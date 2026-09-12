// ---------------------------------------------------------------------------
// Data layer (SQLite via better-sqlite3).
//
// The important bit: a booking checks slot availability and inserts the slots
// inside ONE write-locked transaction, so two people can never grab the same
// table + hour. Unpaid bookings hold their slots for HOLD_MINUTES, then the
// hold is released automatically.
// ---------------------------------------------------------------------------

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DB_PATH = process.env.DB_PATH || "./data/reservasi.db";
const HOLD_MINUTES = Number(process.env.HOLD_MINUTES || 30);

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");   // better concurrency
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    branch_id TEXT, branch_name TEXT,
    table_id TEXT, table_name TEXT,
    date TEXT NOT NULL,
    name TEXT, phone TEXT, email TEXT,
    players INTEGER, notes TEXT,
    addons TEXT, total INTEGER, va TEXT,
    status TEXT NOT NULL DEFAULT 'pending',   -- pending | paid | expired | cancelled
    expires_at INTEGER,
    created_at INTEGER NOT NULL
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

// Release holds that were never paid within the window.
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

// Which hours are taken for a given table on a given date.
export function getBookedHours(branchId, tableId, date) {
  releaseExpired();
  return db.prepare(
    `SELECT hour FROM slots WHERE branch_id=? AND table_id=? AND date=? ORDER BY hour`
  ).all(branchId, tableId, date).map((r) => r.hour);
}

const insertReservation = db.prepare(`
  INSERT INTO reservations
    (code, branch_id, branch_name, table_id, table_name, date, name, phone, email,
     players, notes, addons, total, va, status, expires_at, created_at)
  VALUES
    (@code, @branch_id, @branch_name, @table_id, @table_name, @date, @name, @phone, @email,
     @players, @notes, @addons, @total, @va, 'pending', @expires_at, @created_at)
`);
const insertSlot = db.prepare(
  `INSERT INTO slots (reservation_id, branch_id, table_id, date, hour) VALUES (?, ?, ?, ?, ?)`
);

// Create a booking. Returns { ok:true, expiresAt } or { ok:false, conflict:[hours] }.
export function createReservation(b) {
  releaseExpired();
  const hours = (b.hours || []).map(Number);
  if (!hours.length) return { ok: false, conflict: [] };
  const now = Date.now();
  const expiresAt = now + HOLD_MINUTES * 60 * 1000;

  const run = db.transaction(() => {
    const placeholders = hours.map(() => "?").join(",");
    const taken = db.prepare(
      `SELECT hour FROM slots WHERE branch_id=? AND table_id=? AND date=? AND hour IN (${placeholders})`
    ).all(b.branchId, b.tableId, b.date, ...hours).map((r) => r.hour);

    if (taken.length) return { ok: false, conflict: taken };

    const info = insertReservation.run({
      code: b.code, branch_id: b.branchId, branch_name: b.branch,
      table_id: b.tableId, table_name: b.table, date: b.date,
      name: b.name, phone: b.phone, email: b.email || null,
      players: Number(b.players) || null, notes: b.notes || null,
      addons: JSON.stringify(b.addons || []), total: b.total || 0, va: b.va || null,
      expires_at: expiresAt, created_at: now,
    });
    for (const h of hours) insertSlot.run(info.lastInsertRowid, b.branchId, b.tableId, b.date, h);
    return { ok: true, expiresAt };
  });

  // .immediate grabs the write lock at BEGIN, so the check-then-insert is atomic.
  return run.immediate();
}

// Owner marks a pending booking as paid (locks the slots permanently).
export function markPaid(code) {
  const info = db.prepare(
    `UPDATE reservations SET status='paid', expires_at=NULL WHERE code=? AND status='pending'`
  ).run(code);
  return info.changes > 0;
}

// Recent bookings for the owner dashboard.
export function listReservations(limit = 100) {
  return db.prepare(`
    SELECT r.code, r.branch_name, r.table_name, r.date, r.name, r.phone, r.email,
           r.players, r.total, r.status, r.created_at,
           (SELECT group_concat(hour, ',') FROM slots s WHERE s.reservation_id = r.id) AS hours
    FROM reservations r
    ORDER BY r.id DESC
    LIMIT ?
  `).all(limit);
}
