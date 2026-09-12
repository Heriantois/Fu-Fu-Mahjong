// ---------------------------------------------------------------------------
// Reservasi backend — email + database + real availability
//
//   GET  /api/availability?branch=&table=&date=   -> hours already booked
//   POST /api/reservations                         -> create booking (atomic)
//   GET  /api/reservations?key=ADMIN_KEY           -> owner: list bookings
//   POST /api/reservations/:code/pay?key=ADMIN_KEY -> owner: mark as paid
//
// Needs Node 18+. Setup in README.md.
// ---------------------------------------------------------------------------

import "dotenv/config";
import express from "express";
import cors from "cors";
import nodemailer from "nodemailer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getBookedHours, createReservation, markPaid, listReservations } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());

const {
  SMTP_HOST = "smtp.gmail.com",   // ganti kalau email pawsly.id bukan di Google
  SMTP_PORT = 465,
  SMTP_USER,                       // alamat pengirim, mis admin@pawsly.id
  SMTP_PASS,                       // App Password / password SMTP
  FROM_EMAIL,                      // opsional; default = SMTP_USER
  OWNER_EMAIL,                     // inbox notifikasi pemilik
  BUSINESS_NAME = "Fu Fu Mahjong & Cafe",
  ADMIN_KEY = "",
  PORT = 3001,
} = process.env;

const fromEmail = FROM_EMAIL || SMTP_USER;
// Inbox pemilik untuk notifikasi booking baru (default: alamat pengirim).
const ownerInbox = OWNER_EMAIL || SMTP_USER;

// Kirim email via SMTP. Default Gmail/Google Workspace; ganti SMTP_HOST/PORT
// kalau email pawsly.id ada di provider lain (Zoho, Titan, cPanel, dll).
const mailer = (SMTP_USER && SMTP_PASS)
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: Number(SMTP_PORT) === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    })
  : null;

// --- helpers ---------------------------------------------------------------

const rupiah = (n) => "Rp" + Number(n || 0).toLocaleString("id-ID");

function formatDateID(iso) {
  try {
    return new Date(iso).toLocaleDateString("id-ID", {
      weekday: "long", day: "numeric", month: "long", year: "numeric",
    });
  } catch { return iso; }
}

function genCode() {
  return "FUFU-" + Math.random().toString(36).slice(2, 8).toUpperCase();
}

function validate(b) {
  const errors = [];
  if (!b.name || !String(b.name).trim()) errors.push("name kosong");
  if (!b.branchId) errors.push("branchId kosong");
  if (!b.tableId) errors.push("tableId kosong");
  if (!b.date) errors.push("date kosong");
  if (!Array.isArray(b.hours) || b.hours.length === 0) errors.push("jam kosong");
  if (b.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) errors.push("email tidak valid");
  return errors;
}

function buildEmailHTML(b) {
  const jam = (b.slots || []).join(", ") + (b.duration ? ` (${b.duration} jam)` : "");
  const rows = [
    ["Kode reservasi", b.code],
    ["Cabang", b.branch],
    ["Meja", b.table],
    ["Tanggal", formatDateID(b.date)],
    ["Jam", jam],
    ["Nama", b.name],
    b.players ? ["Jumlah pemain", `${b.players} orang`] : null,
    ...(b.addons || []).map((a) => [`${a.name} ×${a.qty}`, rupiah(a.qty * a.price)]),
    b.notes ? ["Catatan", b.notes] : null,
    ["Total bayar", rupiah(b.total)],
  ].filter(Boolean);

  const rowsHTML = rows.map(([k, v]) => `
    <tr>
      <td style="padding:9px 0;color:#6b6459;font-size:14px;">${k}</td>
      <td style="padding:9px 0;color:#1c1a16;font-size:14px;font-weight:600;text-align:right;">${v}</td>
    </tr>`).join("");

  return `
  <div style="background:#faf6ec;padding:28px 16px;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:520px;margin:0 auto;background:#fffdf7;border:1px solid #e8e0cf;border-radius:16px;overflow:hidden;">
      <div style="background:#146c54;padding:22px 24px;">
        <div style="color:#fff;font-size:18px;font-weight:700;">${BUSINESS_NAME}</div>
        <div style="color:#cdeee0;font-size:13px;margin-top:2px;">Reservasi diterima</div>
      </div>
      <div style="padding:24px;">
        <p style="margin:0 0 6px;font-size:15px;color:#1c1a16;">Halo ${b.name},</p>
        <p style="margin:0 0 18px;font-size:14px;color:#6b6459;line-height:1.6;">
          Meja kamu sudah kami tahan. Selesaikan pembayaran di bawah ini untuk mengunci reservasi.
        </p>
        <table style="width:100%;border-collapse:collapse;border-top:1px solid #e8e0cf;border-bottom:1px solid #e8e0cf;">
          ${rowsHTML}
        </table>
        <div style="background:#1c1a16;border-radius:12px;padding:16px 18px;margin:20px 0;text-align:center;">
          <div style="color:#a89f8c;font-size:12px;">BCA Virtual Account</div>
          <div style="color:#fff;font-size:24px;font-weight:800;letter-spacing:1px;margin-top:4px;">${b.va}</div>
          <div style="color:#cdeee0;font-size:13px;margin-top:8px;">Total: <b>${rupiah(b.total)}</b></div>
        </div>
        <p style="margin:0;font-size:13px;color:#6b6459;line-height:1.6;">
          Cara bayar: buka <b>BCA Mobile / m-BCA</b> &rarr; <b>m-Transfer</b> &rarr;
          <b>BCA Virtual Account</b> &rarr; masukkan nomor di atas.
        </p>
      </div>
    </div>
    <p style="max-width:520px;margin:14px auto 0;font-size:11px;color:#a89f8c;text-align:center;">
      Email otomatis. Balas email ini kalau ada pertanyaan.
    </p>
  </div>`;
}

function waLink(phone) {
  const p = String(phone || "").replace(/\D/g, "").replace(/^0/, "62");
  return p ? `https://wa.me/${p}` : null;
}

// Short internal alert to the owner for every new booking.
function buildOwnerHTML(b) {
  const jam = (b.slots || []).join(", ") + (b.duration ? ` (${b.duration} jam)` : "");
  const addonsLine = (b.addons || []).map((a) => `${a.name} ×${a.qty}`).join(", ") || "—";
  const wa = waLink(b.phone);
  const rows = [
    ["Kode", b.code],
    ["Cabang", b.branch],
    ["Meja", b.table],
    ["Tanggal", formatDateID(b.date)],
    ["Jam", jam],
    ["Pemain", b.players ? `${b.players} orang` : "—"],
    ["Menu tambahan", addonsLine],
    ["Nama", b.name],
    ["WhatsApp", b.phone],
    ["Email", b.email || "—"],
    ["Total", rupiah(b.total)],
    ["Status", "Menunggu pembayaran"],
  ];
  const rowsHTML = rows.map(([k, v]) => `
    <tr>
      <td style="padding:7px 0;color:#6b6459;font-size:13px;">${k}</td>
      <td style="padding:7px 0;color:#1c1a16;font-size:13px;font-weight:600;text-align:right;">${v}</td>
    </tr>`).join("");

  return `
  <div style="background:#faf6ec;padding:24px 16px;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:480px;margin:0 auto;background:#fffdf7;border:1px solid #e8e0cf;border-radius:14px;overflow:hidden;">
      <div style="background:#146c54;padding:16px 20px;color:#fff;font-size:16px;font-weight:700;">
        Booking baru masuk
      </div>
      <div style="padding:18px 20px;">
        <table style="width:100%;border-collapse:collapse;">${rowsHTML}</table>
        ${wa ? `<a href="${wa}" style="display:inline-block;margin-top:16px;background:#146c54;color:#fff;text-decoration:none;font-size:13px;font-weight:700;padding:10px 16px;border-radius:9px;">Chat pelanggan di WhatsApp</a>` : ""}
      </div>
    </div>
  </div>`;
}

async function sendEmail({ to, subject, html }) {
  if (!mailer) {
    console.warn("[email] SMTP_USER / SMTP_PASS belum diset — email dilewati (mode dev).");
    return { skipped: true };
  }
  return mailer.sendMail({
    from: `${BUSINESS_NAME} <${fromEmail}>`,
    to,
    subject,
    html,
  });
}

function requireAdmin(req, res) {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return false;
  }
  return true;
}

// --- routes ----------------------------------------------------------------

app.get("/health", (_req, res) => res.send("Reservasi backend jalan ✅"));

// Sajikan website (versi flat: file ada di folder yang sama dengan server.js)
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/fufu-logo.png", (_req, res) => res.sendFile(path.join(__dirname, "fufu-logo.png")));

// Slots already taken for a table on a date.
app.get("/api/availability", (req, res) => {
  const { branch, table, date } = req.query;
  if (!branch || !table || !date) return res.status(400).json({ ok: false, error: "branch, table, date wajib" });
  res.json({ ok: true, bookedHours: getBookedHours(branch, table, date) });
});

// Create a booking (atomic — no double-booking).
app.post("/api/reservations", async (req, res) => {
  const body = req.body || {};
  const problems = validate(body);
  if (problems.length) return res.status(400).json({ ok: false, errors: problems });

  const code = genCode();
  const result = createReservation({ ...body, code });

  if (!result.ok) {
    // Someone grabbed one of these hours first.
    return res.status(409).json({ ok: false, conflict: result.conflict || [] });
  }

  console.log(`[reservasi] ${code} @ ${body.branch} · ${body.table} ${body.date} [${(body.hours || []).join(",")}]`);

  // Kirim email tanpa menggagalkan booking kalau salah satu error.
  const safeSend = async (opts) => {
    try { await sendEmail(opts); }
    catch (err) { console.error("[email] error:", err.message); }
  };

  if (body.email) {
    await safeSend({
      to: body.email,
      subject: `Reservasi ${code} — ${BUSINESS_NAME}`,
      html: buildEmailHTML({ ...body, code }),
    });
  }
  if (ownerInbox) {
    await safeSend({
      to: ownerInbox,
      subject: `📅 Booking baru: ${body.table} · ${body.date} (${code})`,
      html: buildOwnerHTML({ ...body, code }),
    });
  }

  res.json({ ok: true, code, va: body.va, expiresAt: result.expiresAt });
});

// Owner: list recent bookings.
app.get("/api/reservations", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ ok: true, reservations: listReservations(100) });
});

// Owner: mark a booking as paid.
app.post("/api/reservations/:code/pay", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const ok = markPaid(req.params.code);
  res.json({ ok });
});

app.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
