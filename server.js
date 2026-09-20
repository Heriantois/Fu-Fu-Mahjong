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
  getBookedHours, createReservation, createFnbOrder, markPaid, markCancelled, listReservations, getByCode,
  getMember, listMembers, topUpMember,
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
  "Mohon datang tepat waktu. Meja ditahan maksimal 15 menit dari jam mulai; lewat dari itu dianggap hangus tanpa pengembalian dana.",
  "Waktu sewa dihitung per jam sesuai reservasi; perpanjangan tergantung ketersediaan.",
  "Pembayaran yang sudah masuk tidak dapat dikembalikan (no refund).",
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
  if (!target) { console.warn(`[wa] nomor tidak valid, dilewati (input: '${phone}')`); return { skipped: true }; }
  console.log(`[wa] mengirim ke ${target} …`);
  const r = await fetch("https://api.fonnte.com/send", {
    method: "POST",
    headers: { Authorization: FONNTE_TOKEN, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ target, message }).toString(),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Fonnte ${r.status}: ${text}`);
  console.log(`[wa] terkirim ke ${target} — respons Fonnte: ${text}`);
  return { ok: true };
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
  const rules = HOUSE_RULES.map((r, i) => `${i + 1}. ${r}`).join("\n");
  return [
    `*INVOICE — LUNAS* ✅`,
    `${BUSINESS_NAME}`,
    ``,
    `Kode: ${b.code}`,
    `Cabang: ${b.branch}`,
    `Meja: ${b.table}`,
    `Tanggal: ${formatDateID(b.date)}`,
    `Jam: ${jam}`,
    `Total dibayar: ${rupiah(b.payable || b.total)}`,
    ``,
    `*Peraturan Bermain (S&K):*`,
    rules,
    ``,
    `Dengan membayar, kamu dianggap menyetujui peraturan di atas.`,
    `Terima kasih, sampai jumpa di meja! 🀄`,
  ].join("\n");
}

// Printable invoice page (owner opens with ?key=ADMIN_KEY, then Print / Save as PDF).
function buildInvoicePage(b) {
  const jam = (b.hours || []).map((h) => `${String(h).padStart(2, "0")}:00`).join(", ");
  const addons = b.addons || [];
  const addonsTotal = addons.reduce((s, a) => s + a.qty * a.price, 0);
  const sewa = (b.total || 0) - addonsTotal;
  const statusLabel = b.status === "paid" ? "LUNAS" : (b.status || "").toUpperCase();
  const itemsHTML = [
    `<tr><td>Sewa meja — ${b.table_name} (${(b.hours || []).length} jam)</td><td class="r">${rupiah(sewa)}</td></tr>`,
    ...addons.map((a) => `<tr><td>${a.name} ×${a.qty}</td><td class="r">${rupiah(a.qty * a.price)}</td></tr>`),
  ].join("");
  const rulesHTML = HOUSE_RULES.map((r) => `<li>${r}</li>`).join("");
  return `<!DOCTYPE html><html lang="id"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1"><title>Invoice ${b.code}</title>
  <style>
   *{box-sizing:border-box} body{font-family:Arial,Helvetica,sans-serif;color:#1c1a16;background:#f4f1e8;margin:0;padding:24px;}
   .inv{max-width:640px;margin:0 auto;background:#fff;border:1px solid #e3dccb;border-radius:12px;padding:30px;}
   .top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #146c54;padding-bottom:14px;margin-bottom:16px;}
   .biz{font-size:20px;font-weight:800;color:#146c54;} .sub{color:#6b6459;font-size:12px;margin-top:2px;}
   .badge{font-size:12px;font-weight:800;padding:5px 12px;border-radius:999px;background:#e7f4ed;color:#146c54;white-space:nowrap;}
   h2{font-size:13px;margin:18px 0 8px;text-transform:uppercase;letter-spacing:.04em;color:#6b6459;}
   table{width:100%;border-collapse:collapse;font-size:13.5px;} td{padding:8px 0;border-bottom:1px solid #eee;} .r{text-align:right;}
   .tot td{border-top:2px solid #1c1a16;border-bottom:none;font-weight:800;font-size:16px;padding-top:10px;}
   .meta{font-size:13px;color:#3f463f;line-height:1.8;}
   ol{font-size:12.5px;color:#3f463f;line-height:1.6;padding-left:18px;margin:0;}
   .agree{font-size:11px;color:#8a847a;margin-top:18px;border-top:1px dashed #ddd;padding-top:12px;}
   .btnbar{max-width:640px;margin:0 auto 14px;text-align:right;}
   .pbtn{font:inherit;font-weight:700;background:#146c54;color:#fff;border:none;border-radius:9px;padding:10px 18px;cursor:pointer;}
   @media print{ body{background:#fff;padding:0;} .inv{border:none;border-radius:0;} .btnbar{display:none;} }
  </style></head><body>
  <div class="btnbar"><button class="pbtn" onclick="window.print()">🖨️ Cetak / Simpan PDF</button></div>
  <div class="inv">
    <div class="top">
      <div><div class="biz">${BUSINESS_NAME}</div><div class="sub">Invoice Reservasi</div></div>
      <div class="badge">${statusLabel}</div>
    </div>
    <div class="meta">
      <b>No. Invoice:</b> ${b.code}<br>
      <b>Tanggal main:</b> ${formatDateID(b.date)}<br>
      <b>Jam:</b> ${jam}<br>
      <b>Cabang:</b> ${b.branch_name}<br>
      <b>Nama:</b> ${b.name} &nbsp;·&nbsp; <b>WA:</b> ${b.phone}
    </div>
    <h2>Rincian</h2>
    <table>${itemsHTML}
      <tr class="tot"><td>Total ${b.status === "paid" ? "dibayar" : "tagihan"}</td><td class="r">${rupiah(b.payable || b.total)}</td></tr>
    </table>
    <h2>Peraturan Bermain — Terms &amp; Conditions</h2>
    <ol>${rulesHTML}</ol>
    <div class="agree">Dengan melakukan pembayaran, pelanggan dianggap telah membaca dan menyetujui seluruh peraturan di atas.</div>
  </div></body></html>`;
}

function waFnbText(b) {
  const items = (b.addons || []).map((a) => `- ${a.name} x${a.qty} = ${rupiah(a.qty * a.price)}`).join("\n");
  return [
    `*Pesanan F&B — ${BUSINESS_NAME}*`,
    `Kode: ${b.code}`,
    b.branch ? `Cabang: ${b.branch}` : "",
    `Meja: ${b.table_no}`,
    "",
    items,
    "",
    `Transfer NOMINAL TEPAT:`,
    `${BANK_NAME} ${BANK_ACCOUNT} a.n. ${BANK_HOLDER}`,
    `Jumlah: ${rupiah(b.payable)} (kode unik ${b.uniqueCode})`,
    "",
    `Setelah transfer, balas chat ini dengan bukti transfer ya. Pesanan disiapkan setelah pembayaran dikonfirmasi. Terima kasih! 🀄`,
  ].filter((x) => x !== "").join("\n");
}

function waMemberText(b) {
  const jam = (b.slots || []).join(", ");
  return [
    `*Reservasi TERKONFIRMASI (Member)* ✅`,
    `${BUSINESS_NAME}`,
    ``,
    `Kode: ${b.code}`,
    `Cabang: ${b.branch}`,
    `Meja: ${b.table}`,
    `Tanggal: ${formatDateID(b.date)}`,
    `Jam: ${jam}`,
    ``,
    `Terpakai ${b.usedHours} jam. Sisa saldo: *${b.hoursRemaining} jam*.`,
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
app.get("/cek", (_req, res) => res.sendFile(path.join(__dirname, "cek.html")));
app.get("/fufu-logo.png", (_req, res) => res.sendFile(path.join(__dirname, "fufu-logo.png")));
app.use("/img", express.static(path.join(__dirname, "img"))); // foto menu (opsional): taruh file di folder "img"

app.get("/api/availability", (req, res) => {
  const { branch, table, date } = req.query;
  if (!branch || !table || !date) return res.status(400).json({ ok: false, error: "branch, table, date wajib" });
  res.json({ ok: true, bookedHours: getBookedHours(branch, table, date) });
});

// Public: check a member's remaining hours by phone.
app.get("/api/member-lookup", (req, res) => {
  const m = getMember(req.query.phone || "");
  if (!m) return res.json({ ok: true, found: false });
  res.json({ ok: true, found: true, name: m.name, tier: m.tier, hoursRemaining: m.hours_remaining });
});

// Owner: list members.
app.get("/api/members", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ ok: true, members: listMembers() });
});

// Owner: add a member or top up hours (sell a card).
app.post("/api/members/topup", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const b = req.body || {};
  if (!b.phone) return res.status(400).json({ ok: false, error: "phone wajib" });
  const m = topUpMember({ phone: b.phone, name: b.name, tier: b.tier, hours: b.hours, reason: b.reason });
  if (!m) return res.status(400).json({ ok: false, error: "gagal" });
  // notify member on WhatsApp about their new balance
  safeWA(b.phone, [
    `*Kartu Member ${BUSINESS_NAME}*`,
    b.tier ? `Tier: ${b.tier}` : "",
    `+${Number(b.hours) || 0} jam ditambahkan.`,
    `Sisa saldo: *${m.hours_remaining} jam*.`,
    `Tunjukkan nomor WhatsApp ini saat reservasi untuk bayar pakai jam. 🀄`,
  ].filter((x) => x !== "").join("\n"));
  res.json({ ok: true, member: { phone: m.phone, name: m.name, tier: m.tier, hoursRemaining: m.hours_remaining } });
});

app.post("/api/reservations", async (req, res) => {
  const body = req.body || {};
  const problems = validate(body);
  if (problems.length) return res.status(400).json({ ok: false, errors: problems });

  const code = genCode();
  const result = createReservation({ ...body, code });
  if (!result.ok && result.conflict) return res.status(409).json({ ok: false, conflict: result.conflict });
  if (!result.ok && result.error === "member_not_found") return res.status(400).json({ ok: false, error: "member_not_found" });
  if (!result.ok && result.error === "insufficient") return res.status(400).json({ ok: false, error: "insufficient", hoursRemaining: result.hoursRemaining });
  if (!result.ok) return res.status(400).json({ ok: false, error: "gagal" });

  // --- Member-paid booking (hours deducted, confirmed instantly) ---
  if (result.member) {
    console.log(`[reservasi] ${code} MEMBER @ ${body.branch} · ${body.table} ${body.date} [${(body.hours || []).join(",")}] -${result.usedHours} jam`);
    res.json({ ok: true, code, member: true, usedHours: result.usedHours, hoursRemaining: result.hoursRemaining });
    safeWA(body.phone, waMemberText({ ...body, code, usedHours: result.usedHours, hoursRemaining: result.hoursRemaining }));
    return;
  }

  const full = { ...body, code, payable: result.payable, uniqueCode: result.uniqueCode };
  console.log(`[reservasi] ${code} @ ${body.branch} · ${body.table} ${body.date} [${(body.hours || []).join(",")}] = ${rupiah(result.payable)}`);

  // Answer the browser immediately, then WhatsApp in the background.
  res.json({
    ok: true, code,
    total: body.total, payable: result.payable, uniqueCode: result.uniqueCode,
    bankName: BANK_NAME, bankAccount: BANK_ACCOUNT, bankHolder: BANK_HOLDER,
    expiresAt: result.expiresAt,
  });

  safeWA(body.phone, waBookingText(full));
});

// Create an F&B order (VA payment, no calendar slot).
app.post("/api/fnb-orders", (req, res) => {
  const b = req.body || {};
  if (!b.branchId || !b.table_no || !Array.isArray(b.addons) || !b.addons.length || !b.phone) {
    return res.status(400).json({ ok: false, error: "data kurang" });
  }
  const code = "FB-" + Math.random().toString(36).slice(2, 8).toUpperCase();
  const date = new Date().toISOString().slice(0, 10);
  const result = createFnbOrder({ ...b, code, date });
  const full = { ...b, code, date, payable: result.payable, uniqueCode: result.uniqueCode };
  console.log(`[fnb] ${code} @ ${b.branch} · ${b.table_no} = ${rupiah(result.payable)}`);
  res.json({
    ok: true, code, total: b.total, payable: result.payable, uniqueCode: result.uniqueCode,
    bankName: BANK_NAME, bankAccount: BANK_ACCOUNT, bankHolder: BANK_HOLDER, expiresAt: result.expiresAt,
  });
  safeWA(b.phone, waFnbText(full));
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
  // Email dinonaktifkan — invoice + S&K dikirim lewat WhatsApp.
  safeWA(booking.phone, waPaidText(forEmail));

  res.json({ ok: true });
});

app.post("/api/reservations/:code/cancel", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const ok = markCancelled(req.params.code);
  res.json({ ok });
});

// Printable invoice (owner-only): /invoice/CODE?key=ADMIN_KEY
app.get("/invoice/:code", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const b = getByCode(req.params.code);
  if (!b) return res.status(404).send("Reservasi tidak ditemukan.");
  res.send(buildInvoicePage(b));
});

app.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}  [BUILD: wa-debug-v3]`));
