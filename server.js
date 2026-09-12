// ---------------------------------------------------------------------------
// Reservasi backend — Fu Fu Mahjong & Cafe
//
//   GET  /                         -> website (index.html)
//   GET  /admin                    -> owner dashboard (admin.html)
//   GET  /api/availability         -> hours already booked
//   POST /api/reservations         -> create booking (atomic + unique amount)
//   GET  /api/reservations?key=    -> owner: list bookings
//   POST /api/reservations/:code/pay?key=    -> owner: mark paid (sends invoice)
//   POST /api/reservations/:code/cancel?key= -> owner: cancel + free slots
// ---------------------------------------------------------------------------

import "dotenv/config";
import express from "express";
import cors from "cors";
import nodemailer from "nodemailer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getBookedHours, createReservation, markPaid, markCancelled, listReservations,
} from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());

const {
  SMTP_HOST = "smtp.gmail.com",
  SMTP_PORT = 465,
  SMTP_USER,
  SMTP_PASS,
  RESEND_API_KEY,
  FROM_EMAIL,
  OWNER_EMAIL,
  BUSINESS_NAME = "Fu Fu Mahjong & Cafe",
  BANK_NAME = "BCA",
  BANK_ACCOUNT = "",          // nomor rekening tujuan transfer
  BANK_HOLDER = "",           // nama pemilik rekening
  ADMIN_KEY = "",
  FONNTE_TOKEN = "",          // token dari fonnte.com (WhatsApp otomatis)
  PORT = 3001,
} = process.env;

const fromEmail = FROM_EMAIL || SMTP_USER;
const ownerInbox = OWNER_EMAIL || SMTP_USER;

const mailer = (SMTP_USER && SMTP_PASS)
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: Number(SMTP_PORT) === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    })
  : null;

// Peraturan bermain (muncul di email invoice). Silakan edit sesuai kebutuhan.
const HOUSE_RULES = [
  "Reservasi berlaku untuk 1 meja (maksimal 4 pemain).",
  "Mohon datang tepat waktu. Meja ditahan maksimal 15 menit dari jam mulai.",
  "Waktu sewa dihitung per jam sesuai reservasi; perpanjangan tergantung ketersediaan.",
  "Jaga kebersihan meja dan kelengkapan set mahjong. Kerusakan atau kehilangan menjadi tanggung jawab penyewa.",
  "Dilarang membawa makanan/minuman dari luar; silakan pesan dari menu kafe.",
  "Mohon menjaga ketenangan dan kenyamanan bersama pengunjung lain.",
];

// --- helpers ---------------------------------------------------------------

const rupiah = (n) => "Rp" + Number(n || 0).toLocaleString("id-ID");

function formatDateID(iso) {
  try {
    return new Date(iso).toLocaleDateString("id-ID", {
      weekday: "long", day: "numeric", month: "long", year: "numeric",
    });
  } catch { return iso; }
}
function genCode() { return "FUFU-" + Math.random().toString(36).slice(2, 8).toUpperCase(); }
function waLink(phone) {
  const p = String(phone || "").replace(/\D/g, "").replace(/^0/, "62");
  return p ? `https://wa.me/${p}` : null;
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

function detailRows(b) {
  const jam = (b.slots || []).join(", ") + (b.duration ? ` (${b.duration} jam)` : "");
  return [
    ["Kode reservasi", b.code],
    ["Cabang", b.branch],
    ["Meja", b.table],
    ["Tanggal", formatDateID(b.date)],
    ["Jam", jam],
    ["Nama", b.name],
    ...(b.addons || []).map((a) => [`${a.name} ×${a.qty}`, rupiah(a.qty * a.price)]),
    b.notes ? ["Catatan", b.notes] : null,
  ].filter(Boolean);
}
function rowsToHTML(rows) {
  return rows.map(([k, v]) => `
    <tr>
      <td style="padding:9px 0;color:#6b6459;font-size:14px;">${k}</td>
      <td style="padding:9px 0;color:#1c1a16;font-size:14px;font-weight:600;text-align:right;">${v}</td>
    </tr>`).join("");
}
function shell(inner) {
  return `<div style="background:#faf6ec;padding:28px 16px;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:540px;margin:0 auto;background:#fffdf7;border:1px solid #e8e0cf;border-radius:16px;overflow:hidden;">
      ${inner}
    </div>
    <p style="max-width:540px;margin:14px auto 0;font-size:11px;color:#a89f8c;text-align:center;">
      Email otomatis dari ${BUSINESS_NAME}.
    </p>
  </div>`;
}

// "Please pay" confirmation, sent at booking time.
function buildBookingHTML(b) {
  const rows = detailRows(b).concat([["Total", rupiah(b.total)]]);
  return shell(`
    <div style="background:#146c54;padding:22px 24px;">
      <div style="color:#fff;font-size:18px;font-weight:700;">${BUSINESS_NAME}</div>
      <div style="color:#cdeee0;font-size:13px;margin-top:2px;">Reservasi diterima — menunggu pembayaran</div>
    </div>
    <div style="padding:24px;">
      <p style="margin:0 0 6px;font-size:15px;">Halo ${b.name},</p>
      <p style="margin:0 0 18px;font-size:14px;color:#6b6459;line-height:1.6;">
        Meja kamu ditahan selama 15 menit. Selesaikan transfer dengan nominal <b>tepat</b>
        di bawah ini supaya kami bisa mencocokkan pembayaranmu otomatis.
      </p>
      <table style="width:100%;border-collapse:collapse;border-top:1px solid #e8e0cf;">${rowsToHTML(rows)}</table>
      <div style="background:#1c1a16;border-radius:12px;padding:18px;margin:20px 0;text-align:center;color:#fff;">
        <div style="font-size:12px;opacity:.7;">Transfer ke ${BANK_NAME}</div>
        <div style="font-size:22px;font-weight:800;letter-spacing:1px;margin-top:4px;">${BANK_ACCOUNT || "(atur nomor rekening)"}</div>
        <div style="font-size:13px;opacity:.85;margin-top:2px;">a.n. ${BANK_HOLDER || "(atur nama rekening)"}</div>
        <div style="margin-top:14px;font-size:12px;opacity:.7;">Nominal tepat (termasuk kode unik)</div>
        <div style="font-size:26px;font-weight:800;color:#e8c25a;">${rupiah(b.payable)}</div>
        <div style="font-size:11px;opacity:.7;margin-top:2px;">3 digit terakhir (${b.uniqueCode}) adalah kode unik — jangan dibulatkan.</div>
      </div>
      <p style="margin:0;font-size:12.5px;color:#6b6459;line-height:1.6;">
        Setelah transfer, kirim bukti ke WhatsApp kami. Kalau pembayaran belum masuk dalam
        15 menit, meja otomatis dilepas dan bisa dipesan orang lain.
      </p>
    </div>`);
}

// Invoice, sent when the owner marks the booking paid.
function buildInvoiceHTML(b) {
  const rows = detailRows(b).concat([["Total dibayar", rupiah(b.payable || b.total)]]);
  const rulesHTML = HOUSE_RULES.map((r) => `<li style="margin-bottom:6px;">${r}</li>`).join("");
  return shell(`
    <div style="background:#146c54;padding:22px 24px;">
      <div style="color:#fff;font-size:18px;font-weight:700;">${BUSINESS_NAME}</div>
      <div style="color:#cdeee0;font-size:13px;margin-top:2px;">Invoice — Pembayaran diterima ✓</div>
    </div>
    <div style="padding:24px;">
      <p style="margin:0 0 6px;font-size:15px;">Halo ${b.name},</p>
      <p style="margin:0 0 18px;font-size:14px;color:#6b6459;line-height:1.6;">
        Terima kasih! Pembayaranmu sudah kami terima dan reservasi kamu <b>terkonfirmasi</b>.
        Ini invoice sekaligus bukti reservasimu.
      </p>
      <table style="width:100%;border-collapse:collapse;border-top:1px solid #e8e0cf;border-bottom:1px solid #e8e0cf;">${rowsToHTML(rows)}</table>
      <div style="margin-top:22px;">
        <div style="font-size:14px;font-weight:700;color:#146c54;margin-bottom:8px;">Peraturan Bermain</div>
        <ol style="margin:0;padding-left:18px;font-size:13px;color:#3f463f;line-height:1.6;">${rulesHTML}</ol>
      </div>
      <p style="margin:18px 0 0;font-size:13px;color:#6b6459;">Sampai jumpa di meja! 🀄</p>
    </div>`);
}

function buildOwnerHTML(b, kind) {
  const rows = detailRows(b).concat([
    ["WhatsApp", b.phone],
    ["Email", b.email || "—"],
    ["Nominal", rupiah(b.payable)],
    ["Status", kind === "paid" ? "LUNAS" : "Menunggu pembayaran"],
  ]);
  const wa = waLink(b.phone);
  return shell(`
    <div style="background:#146c54;padding:16px 20px;color:#fff;font-size:16px;font-weight:700;">
      ${kind === "paid" ? "Pembayaran diterima" : "Booking baru masuk"}
    </div>
    <div style="padding:18px 20px;">
      <table style="width:100%;border-collapse:collapse;">${rowsToHTML(rows)}</table>
      ${wa ? `<a href="${wa}" style="display:inline-block;margin-top:16px;background:#146c54;color:#fff;text-decoration:none;font-size:13px;font-weight:700;padding:10px 16px;border-radius:9px;">Chat pelanggan di WhatsApp</a>` : ""}
    </div>`);
}

async function sendEmail({ to, subject, html }) {
  // Prefer the HTTPS email API (Resend) when configured — it works even where
  // the host blocks SMTP ports (which is what "Connection timeout" means).
  if (RESEND_API_KEY) {
    const from = `${BUSINESS_NAME} <${fromEmail || "onboarding@resend.dev"}>`;
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject, html }),
    });
    if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
    return r.json();
  }
  if (mailer) return mailer.sendMail({ from: `${BUSINESS_NAME} <${fromEmail}>`, to, subject, html });
  console.warn("[email] belum ada RESEND_API_KEY / SMTP — email dilewati.");
  return { skipped: true };
}
const safeSend = (opts) => sendEmail(opts).catch((err) => console.error("[email] error:", err.message));

// --- WhatsApp (Fonnte) -----------------------------------------------------
function waNumber(phone) {
  const p = String(phone || "").replace(/\D/g, "").replace(/^0/, "62");
  return p || null;
}
async function sendWhatsApp(phone, message) {
  if (!FONNTE_TOKEN) { console.warn("[wa] FONNTE_TOKEN belum diset — WhatsApp dilewati."); return { skipped: true }; }
  const target = waNumber(phone);
  if (!target) return { skipped: true };
  const r = await fetch("https://api.fonnte.com/send", {
    method: "POST",
    headers: { Authorization: FONNTE_TOKEN, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ target, message }).toString(),
  });
  if (!r.ok) throw new Error(`Fonnte ${r.status}: ${await r.text()}`);
  return r.json();
}
const safeWA = (phone, message) => sendWhatsApp(phone, message).catch((err) => console.error("[wa] error:", err.message));

function waBookingText(b) {
  const jam = (b.slots || []).join(", ");
  const lines = [
    `Halo ${b.name}! Reservasi kamu di ${BUSINESS_NAME} sudah kami terima.`,
    ``,
    `Kode: ${b.code}`,
    `Cabang: ${b.branch}`,
    `Meja: ${b.table}`,
    `Tanggal: ${formatDateID(b.date)}`,
    `Jam: ${jam}`,
    ``,
    `Silakan transfer NOMINAL TEPAT:`,
    `${BANK_NAME} ${BANK_ACCOUNT} a.n. ${BANK_HOLDER}`,
    `Jumlah: ${rupiah(b.payable)} (termasuk kode unik ${b.uniqueCode})`,
    ``,
    `Meja ditahan 15 menit. Setelah transfer, balas chat ini dengan bukti transfer ya. Terima kasih! 🀄`,
  ];
  return lines.join("\n");
}
function waPaidText(b) {
  const jam = (b.slots || []).join(", ");
  return [
    `Pembayaran diterima ✅ Reservasi kamu di ${BUSINESS_NAME} sudah TERKONFIRMASI.`,
    ``,
    `Kode: ${b.code}`,
    `Meja: ${b.table}`,
    `Tanggal: ${formatDateID(b.date)}`,
    `Jam: ${jam}`,
    ``,
    `Sampai jumpa di meja! 🀄`,
  ].join("\n");
}

function requireAdmin(req, res) {
  if (!ADMIN_KEY || (req.query.key !== ADMIN_KEY && req.get("x-admin-key") !== ADMIN_KEY)) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return false;
  }
  return true;
}

// --- routes ----------------------------------------------------------------

app.get("/health", (_req, res) => res.send("Reservasi backend jalan ✅"));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/admin", (_req, res) => res.sendFile(path.join(__dirname, "admin.html")));
app.get("/fufu-logo.png", (_req, res) => res.sendFile(path.join(__dirname, "fufu-logo.png")));

app.get("/api/availability", (req, res) => {
  const { branch, table, date } = req.query;
  if (!branch || !table || !date) return res.status(400).json({ ok: false, error: "branch, table, date wajib" });
  res.json({ ok: true, bookedHours: getBookedHours(branch, table, date) });
});

app.post("/api/reservations", async (req, res) => {
  const body = req.body || {};
  const problems = validate(body);
  if (problems.length) return res.status(400).json({ ok: false, errors: problems });

  const code = genCode();
  const result = createReservation({ ...body, code });
  if (!result.ok) return res.status(409).json({ ok: false, conflict: result.conflict || [] });

  const full = { ...body, code, payable: result.payable, uniqueCode: result.uniqueCode };
  console.log(`[reservasi] ${code} @ ${body.branch} · ${body.table} ${body.date} [${(body.hours || []).join(",")}] = ${rupiah(result.payable)}`);

  // Answer the browser immediately, then email in the background.
  res.json({
    ok: true, code,
    total: body.total, payable: result.payable, uniqueCode: result.uniqueCode,
    bankName: BANK_NAME, bankAccount: BANK_ACCOUNT, bankHolder: BANK_HOLDER,
    expiresAt: result.expiresAt,
  });

  if (body.email) safeSend({ to: body.email, subject: `Reservasi ${code} — ${BUSINESS_NAME}`, html: buildBookingHTML(full) });
  if (ownerInbox) safeSend({ to: ownerInbox, subject: `📅 Booking baru: ${body.table} · ${body.date} (${code})`, html: buildOwnerHTML(full, "pending") });
  safeWA(body.phone, waBookingText(full));
});

app.get("/api/reservations", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ ok: true, reservations: listReservations(200) });
});

app.post("/api/reservations/:code/pay", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const booking = markPaid(req.params.code);
  if (!booking) return res.json({ ok: false, error: "tidak ditemukan / bukan pending" });

  const forEmail = {
    code: booking.code, branch: booking.branch_name, table: booking.table_name,
    date: booking.date, slots: (booking.hours || []).map((h) => `${String(h).padStart(2, "0")}:00`),
    duration: (booking.hours || []).length, name: booking.name, phone: booking.phone,
    email: booking.email, addons: booking.addons, notes: booking.notes,
    total: booking.total, payable: booking.payable,
  };
  if (booking.email) safeSend({ to: booking.email, subject: `Invoice ${booking.code} — ${BUSINESS_NAME}`, html: buildInvoiceHTML(forEmail) });
  if (ownerInbox) safeSend({ to: ownerInbox, subject: `✅ Lunas: ${booking.table_name} (${booking.code})`, html: buildOwnerHTML(forEmail, "paid") });
  safeWA(booking.phone, waPaidText(forEmail));

  res.json({ ok: true });
});

app.post("/api/reservations/:code/cancel", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const ok = markCancelled(req.params.code);
  res.json({ ok });
});

app.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
