// ---------------------------------------------------------------------------
// Data layer (SQLite via better-sqlite3).
//
// - Atomic booking: checks + reserves slots in one write-locked transaction,
//   so two people can never grab the same table + hour.
// - Unpaid bookings hold their slots for HOLD_MINUTES, then release automatically.
// - Each booking gets a unique payable amount (total + a 1..999 code) so you can
//   match a bank transfer to the exact booking.
// ---------------------------------------------------------------------------

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DB_PATH = process.env.DB_PATH || "./data/reservasi.db";
const HOLD_MINUTES = Number(process.env.HOLD_MINUTES || 15);

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    branch_id TEXT, branch_name TEXT,
    table_id TEXT, table_name TEXT,
    date TEXT NOT NULL,
    name TEXT, phone TEXT, email TEXT,
    notes TEXT,
    addons TEXT, total INTEGER,
    unique_code INTEGER, payable INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    expires_at INTEGER,
    created_at INTEGER NOT NULL,
    paid_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS slots (
    reservation_id INTEGER NOT NULL,
    branch_id TEXT NOT NULL,
    table_id TEXT NOT NULL,
    date TEXT NOT NULL,
    hour INTEGER NOT NULL,
    FOREIGN KEY (reservation_id) REFERENCES reservations(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_slots_lookup ON slots (branch_id, table_id, date, hour);
  CREATE TABLE IF NOT EXISTS members (
    phone TEXT PRIMARY KEY,
    name TEXT, tier TEXT,
    hours_remaining REAL NOT NULL DEFAULT 0,
    created_at INTEGER, updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS member_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT, delta REAL, reason TEXT, ref TEXT, at INTEGER
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    branch_id TEXT, branch_name TEXT,
    table_id TEXT, table_name TEXT,
    name TEXT, phone TEXT,
    rate INTEGER,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    minutes INTEGER, blocks INTEGER, amount INTEGER,
    status TEXT NOT NULL DEFAULT 'open',   -- open | closed | paid
    notes TEXT
  );
  CREATE TABLE IF NOT EXISTS session_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_code TEXT NOT NULL,
    name TEXT, qty INTEGER, price INTEGER,
    source TEXT, at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_sitems ON session_items (session_code);
`);

// Safe migrations for databases created by an older version.
for (const col of ["unique_code INTEGER", "payable INTEGER", "paid_at INTEGER", "kind TEXT DEFAULT 'reservation'"]) {
  try { db.exec(`ALTER TABLE reservations ADD COLUMN ${col}`); } catch { /* already exists */ }
}
// Bill fields: timer_on = is the clock running, manual_minutes = hours added by staff by hand.
for (const col of ["timer_on INTEGER DEFAULT 1", "manual_minutes INTEGER DEFAULT 0"]) {
  try { db.exec(`ALTER TABLE sessions ADD COLUMN ${col}`); } catch { /* already exists */ }
}

const releaseExpired = db.transaction(() => {
  const now = Date.now();
  const expired = db.prepare(
    `SELECT id FROM reservations WHERE status='pending' AND expires_at IS NOT NULL AND expires_at < ?`
  ).all(now);
  const delSlots = db.prepare(`DELETE FROM slots WHERE reservation_id = ?`);
  const setExpired = db.prepare(`UPDATE reservations SET status='expired', expires_at=NULL WHERE id = ?`);
  for (const r of expired) { delSlots.run(r.id); setExpired.run(r.id); }
  return expired.length;
});

export function getBookedHours(branchId, tableId, date) {
  releaseExpired();
  return db.prepare(
    `SELECT hour FROM slots WHERE branch_id=? AND table_id=? AND date=? ORDER BY hour`
  ).all(branchId, tableId, date).map((r) => r.hour);
}

export function getByCode(code) {
  const r = db.prepare(`SELECT * FROM reservations WHERE code=?`).get(code);
  if (!r) return null;
  const hours = db.prepare(`SELECT hour FROM slots WHERE reservation_id=? ORDER BY hour`)
    .all(r.id).map((x) => x.hour);
  let addons = [];
  try { addons = JSON.parse(r.addons || "[]"); } catch { addons = []; }
  return { ...r, hours, addons };
}

const insertReservation = db.prepare(`
  INSERT INTO reservations
    (code, branch_id, branch_name, table_id, table_name, date, name, phone, email,
     notes, addons, total, unique_code, payable, status, expires_at, created_at)
  VALUES
    (@code, @branch_id, @branch_name, @table_id, @table_name, @date, @name, @phone, @email,
     @notes, @addons, @total, @unique_code, @payable, 'pending', @expires_at, @created_at)
`);
const insertSlot = db.prepare(
  `INSERT INTO slots (reservation_id, branch_id, table_id, date, hour) VALUES (?, ?, ?, ?, ?)`
);

export function createReservation(b) {
  releaseExpired();
  const hours = (b.hours || []).map(Number);
  if (!hours.length) return { ok: false, conflict: [] };
  const now = Date.now();
  const expiresAt = now + HOLD_MINUTES * 60 * 1000;
  const base = Number(b.total) || 0;

  const run = db.transaction(() => {
    const placeholders = hours.map(() => "?").join(",");
    const taken = db.prepare(
      `SELECT hour FROM slots WHERE branch_id=? AND table_id=? AND date=? AND hour IN (${placeholders})`
    ).all(b.branchId, b.tableId, b.date, ...hours).map((r) => r.hour);
    if (taken.length) return { ok: false, conflict: taken };

    // --- Member payment path: pay with prepaid hours ---
    if (b.memberPhone) {
      const p = normPhone(b.memberPhone);
      const m = db.prepare(`SELECT * FROM members WHERE phone=?`).get(p);
      if (!m) return { ok: false, error: "member_not_found" };
      const need = hours.length;
      if (m.hours_remaining < need) return { ok: false, error: "insufficient", hoursRemaining: m.hours_remaining };
      const info = insertReservation.run({
        code: b.code, branch_id: b.branchId, branch_name: b.branch,
        table_id: b.tableId, table_name: b.table, date: b.date,
        name: b.name, phone: b.phone, email: b.email || null,
        notes: b.notes || null, addons: JSON.stringify(b.addons || []), total: base,
        unique_code: null, payable: null, expires_at: null, created_at: now,
      });
      db.prepare(`UPDATE reservations SET status='paid', paid_at=? WHERE id=?`).run(now, info.lastInsertRowid);
      for (const h of hours) insertSlot.run(info.lastInsertRowid, b.branchId, b.tableId, b.date, h);
      const left = m.hours_remaining - need;
      db.prepare(`UPDATE members SET hours_remaining=?, updated_at=? WHERE phone=?`).run(left, now, p);
      db.prepare(`INSERT INTO member_log (phone,delta,reason,ref,at) VALUES (?,?,?,?,?)`).run(p, -need, "booking", b.code, now);
      return { ok: true, member: true, hoursRemaining: left, usedHours: need };
    }

    // unique payable amount (base + 1..499) not shared with other pending bookings
    const used = new Set(
      db.prepare(`SELECT payable FROM reservations WHERE status='pending' AND payable IS NOT NULL`)
        .all().map((r) => r.payable)
    );
    let uniqueCode = null, payable = null;
    for (let i = 0; i < 999; i++) {
      const code = 1 + Math.floor(Math.random() * 499);
      if (!used.has(base + code)) { uniqueCode = code; payable = base + code; break; }
    }
    if (payable === null) { uniqueCode = 1 + Math.floor(Math.random() * 499); payable = base + uniqueCode; }

    const info = insertReservation.run({
      code: b.code, branch_id: b.branchId, branch_name: b.branch,
      table_id: b.tableId, table_name: b.table, date: b.date,
      name: b.name, phone: b.phone, email: b.email || null,
      notes: b.notes || null, addons: JSON.stringify(b.addons || []), total: base,
      unique_code: uniqueCode, payable, expires_at: expiresAt, created_at: now,
    });
    for (const h of hours) insertSlot.run(info.lastInsertRowid, b.branchId, b.tableId, b.date, h);
    return { ok: true, expiresAt, uniqueCode, payable };
  });

  return run.immediate();
}

// Create an F&B order (no slots, doesn't block the calendar). Same unique-amount VA.
export function createFnbOrder(b) {
  releaseExpired();
  const now = Date.now();
  const expiresAt = now + HOLD_MINUTES * 60 * 1000;
  const base = Number(b.total) || 0;
  const run = db.transaction(() => {
    const used = new Set(
      db.prepare(`SELECT payable FROM reservations WHERE status='pending' AND payable IS NOT NULL`)
        .all().map((r) => r.payable)
    );
    let uniqueCode = null, payable = null;
    for (let i = 0; i < 499; i++) {
      const code = 1 + Math.floor(Math.random() * 499);
      if (!used.has(base + code)) { uniqueCode = code; payable = base + code; break; }
    }
    if (payable === null) { uniqueCode = 1 + Math.floor(Math.random() * 499); payable = base + uniqueCode; }
    insertReservation.run({
      code: b.code, branch_id: b.branchId, branch_name: b.branch,
      table_id: null, table_name: b.table_no, date: b.date,
      name: b.name || null, phone: b.phone, email: null,
      notes: b.notes || null, addons: JSON.stringify(b.addons || []), total: base,
      unique_code: uniqueCode, payable, expires_at: expiresAt, created_at: now,
    });
    db.prepare(`UPDATE reservations SET kind='fnb' WHERE code=?`).run(b.code);
    return { ok: true, expiresAt, uniqueCode, payable };
  });
  return run.immediate();
}

// ---- Members (prepaid hours wallet) ----
function normPhone(p) { return String(p || "").replace(/\D/g, "").replace(/^0/, "62"); }

export function getMember(phone) {
  const p = normPhone(phone);
  return db.prepare(`SELECT * FROM members WHERE phone=?`).get(p) || null;
}
export function listMembers() {
  return db.prepare(`SELECT phone, name, tier, hours_remaining, created_at, updated_at FROM members ORDER BY updated_at DESC`).all();
}
export function topUpMember({ phone, name, tier, hours, reason }) {
  const p = normPhone(phone);
  if (!p) return null;
  const now = Date.now();
  const add = Number(hours) || 0;
  const tx = db.transaction(() => {
    const m = db.prepare(`SELECT * FROM members WHERE phone=?`).get(p);
    if (m) {
      db.prepare(`UPDATE members SET name=COALESCE(?,name), tier=COALESCE(?,tier), hours_remaining=hours_remaining+?, updated_at=? WHERE phone=?`)
        .run(name || null, tier || null, add, now, p);
    } else {
      db.prepare(`INSERT INTO members (phone,name,tier,hours_remaining,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
        .run(p, name || null, tier || null, add, now, now);
    }
    db.prepare(`INSERT INTO member_log (phone,delta,reason,ref,at) VALUES (?,?,?,?,?)`).run(p, add, reason || "top-up", null, now);
    return db.prepare(`SELECT * FROM members WHERE phone=?`).get(p);
  });
  return tx();
}

// ---- Walk-in sessions (pay as you go, billed per 15-minute block) ----
export function startSession(b) {
  const now = Date.now();
  const code = "WI-" + Math.random().toString(36).slice(2, 7).toUpperCase();
  const timerOn = b.timerOn === false ? 0 : 1;
  db.prepare(`
    INSERT INTO sessions (code, branch_id, branch_name, table_id, table_name, name, phone, rate, started_at, status, timer_on, manual_minutes)
    VALUES (?,?,?,?,?,?,?,?,?, 'open', ?, 0)
  `).run(code, b.branchId, b.branch, b.tableId || null, b.table_name, b.name || null, b.phone || null, Number(b.rate) || 0, now, timerOn);
  return db.prepare(`SELECT * FROM sessions WHERE code=?`).get(code);
}

// Find the table's open bill, or create one (used when a customer orders via QR
// before staff has started a session — the clock stays OFF until staff starts it).
export function getOrCreateOpenBill({ branchId, branch, table_name, rate }) {
  const existing = getOpenSession(branchId, table_name);
  if (existing) return { bill: existing, created: false };
  const bill = startSession({ branchId, branch, table_name, rate: rate || 0, timerOn: false });
  return { bill, created: true };
}

// Staff adds table time by hand (minutes). Use negative to correct a mistake.
export function addManualMinutes(code, minutes) {
  const s = db.prepare(`SELECT * FROM sessions WHERE code=? AND status='open'`).get(code);
  if (!s) return null;
  const next = Math.max(0, (s.manual_minutes || 0) + Number(minutes || 0));
  db.prepare(`UPDATE sessions SET manual_minutes=? WHERE id=?`).run(next, s.id);
  return getSessionByCode(code);
}

// Start/stop the running clock on an open bill.
export function setTimer(code, on) {
  const s = db.prepare(`SELECT * FROM sessions WHERE code=? AND status='open'`).get(code);
  if (!s) return null;
  if (on) {
    // starting (or restarting) the clock: bank any elapsed time first, then reset the start point
    db.prepare(`UPDATE sessions SET timer_on=1, started_at=? WHERE id=?`).run(Date.now(), s.id);
  } else {
    const elapsed = s.timer_on ? Math.max(0, Math.round((Date.now() - s.started_at) / 60000)) : 0;
    db.prepare(`UPDATE sessions SET timer_on=0, manual_minutes=? WHERE id=?`)
      .run((s.manual_minutes || 0) + elapsed, s.id);
  }
  return getSessionByCode(code);
}

// Close a session: table time (per 15-min block, rounded up) + F&B items on the bill.
export function endSession(code) {
  const s = db.prepare(`SELECT * FROM sessions WHERE code=? AND status='open'`).get(code);
  if (!s) return null;
  const now = Date.now();
  const live = s.timer_on ? Math.max(0, Math.round((now - s.started_at) / 60000)) : 0;
  const minutes = live + (s.manual_minutes || 0);
  const blocks = minutes > 0 ? Math.ceil(minutes / 15) : 0;   // 15-minute blocks, rounded up
  const tableAmount = Math.round((s.rate / 4) * blocks);      // rate is per hour = 4 blocks
  const itemsAmount = getSessionItems(code).reduce((t, i) => t + i.qty * i.price, 0);
  const amount = tableAmount + itemsAmount;
  db.prepare(`UPDATE sessions SET ended_at=?, minutes=?, blocks=?, amount=?, status='closed' WHERE id=?`)
    .run(now, minutes, blocks, amount, s.id);
  const out = db.prepare(`SELECT * FROM sessions WHERE id=?`).get(s.id);
  out.tableAmount = tableAmount;
  out.itemsAmount = itemsAmount;
  out.items = getSessionItems(code);
  return out;
}

// ---- Open bill: F&B items attached to a walk-in session ----
export function getSessionItems(code) {
  return db.prepare(`SELECT name, qty, price, source, at FROM session_items WHERE session_code=? ORDER BY id`).all(code);
}
export function getOpenSession(branchId, tableName) {
  return db.prepare(`SELECT * FROM sessions WHERE branch_id=? AND table_name=? AND status='open' ORDER BY id DESC LIMIT 1`)
    .get(branchId, tableName) || null;
}
export function getSessionByCode(code) {
  const s = db.prepare(`SELECT * FROM sessions WHERE code=?`).get(code);
  if (!s) return null;
  s.items = getSessionItems(code);
  return s;
}
// Add F&B items to an OPEN session. source: 'admin' | 'qr'
export function addSessionItems(code, items, source) {
  const s = db.prepare(`SELECT * FROM sessions WHERE code=? AND status='open'`).get(code);
  if (!s) return null;
  const now = Date.now();
  const ins = db.prepare(`INSERT INTO session_items (session_code,name,qty,price,source,at) VALUES (?,?,?,?,?,?)`);
  const tx = db.transaction(() => {
    for (const it of items || []) {
      if (!it.name || !it.qty) continue;
      ins.run(code, it.name, Number(it.qty), Number(it.price) || 0, source || "admin", now);
    }
  });
  tx();
  return getSessionByCode(code);
}

export function paySession(code) {
  const info = db.prepare(`UPDATE sessions SET status='paid' WHERE code=? AND status='closed'`).run(code);
  if (info.changes === 0) return null;
  return db.prepare(`SELECT * FROM sessions WHERE code=?`).get(code);
}

export function cancelSession(code) {
  const info = db.prepare(`DELETE FROM sessions WHERE code=? AND status='open'`).run(code);
  return info.changes > 0;
}

export function listSessions(limit = 100) {
  const rows = db.prepare(`SELECT * FROM sessions ORDER BY id DESC LIMIT ?`).all(limit);
  return rows.map((r) => {
    const items = getSessionItems(r.code);
    return { ...r, items, itemsAmount: items.reduce((t, i) => t + i.qty * i.price, 0) };
  });
}

export function markPaid(code) {
  const info = db.prepare(
    `UPDATE reservations SET status='paid', expires_at=NULL, paid_at=? WHERE code=? AND status='pending'`
  ).run(Date.now(), code);
  if (info.changes === 0) return null;
  return getByCode(code);
}

// Owner cancels a booking and frees its slots. Returns true if it existed.
export function markCancelled(code) {
  const row = db.prepare(`SELECT id FROM reservations WHERE code=?`).get(code);
  if (!row) return false;
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM slots WHERE reservation_id=?`).run(row.id);
    db.prepare(`UPDATE reservations SET status='cancelled', expires_at=NULL WHERE id=?`).run(row.id);
  });
  tx();
  return true;
}

// Recent bookings for the owner dashboard.
export function listReservations(limit = 200) {
  releaseExpired();
  return db.prepare(`
    SELECT r.code, r.branch_name, r.table_name, r.date, r.name, r.phone, r.email,
           r.total, r.unique_code, r.payable, r.status, r.created_at, r.paid_at, r.kind,
           (SELECT group_concat(hour, ',') FROM slots s WHERE s.reservation_id = r.id) AS hours
    FROM reservations r
    ORDER BY r.id DESC
    LIMIT ?
  `).all(limit);
}
