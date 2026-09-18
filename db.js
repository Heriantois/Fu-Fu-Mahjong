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
`);

// Safe migrations for databases created by an older version.
for (const col of ["unique_code INTEGER", "payable INTEGER", "paid_at INTEGER", "kind TEXT DEFAULT 'reservation'"]) {
  try { db.exec(`ALTER TABLE reservations ADD COLUMN ${col}`); } catch { /* already exists */ }
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

    // unique payable amount (base + 1..999) not shared with other pending bookings
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
