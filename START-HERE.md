# ⚠️ This is the FLAT version — no folders

Every file sits at the same level (there is **no `public` folder**). When you upload
to GitHub, open this folder, select **all** the files, and drag them in together —
there is nothing that can get misplaced. Replace the old files (same names overwrite).

---

# Fu Fu Mahjong & Cafe — Booking Website: Start Here

A plain-English guide. No coding knowledge assumed. Read top to bottom once,
then follow the steps.

---

> **Already tried and got a build error?** That was not your fault — the host used a
> too-new version of Node, which the database library couldn't build against. It's
> fixed in these files now (Node is pinned to a stable version). To recover: re-upload
> the changed files to GitHub — `package.json`, `.node-version`, `server.js`,
> `.env.example` — and update your Render environment variables to the new email
> names shown in Section 6. Render will rebuild automatically.

---

## 1. What you actually have

Think of it like a small restaurant:

- **The website** (`index.html`) is the *dining room* — what customers see
  and use to book a table. It shows your branches, tables, time slots, prices,
  and the café menu.
- **The server / "brain"** (`server.js` + `db.js`) is the *kitchen* — customers
  never see it, but it does the real work: it remembers every booking, stops two
  people booking the same table at the same hour, and sends emails.
- **The database** (a file the server creates) is the *reservation book* — where
  every booking is written down.
- **Gmail** is your *outbox* — the server uses your Gmail to send the confirmation
  emails.

Good news: I've set it up so the dining room and the kitchen are **one package**.
You deploy **one thing**, and it runs the whole system.

---

## 2. "Do I use Gmail or Render?" — you use BOTH, for different jobs

This is the part that was confusing, so here it is plainly:

- **Gmail** = sending email. You already have it (herianto.iskandar@gmail.com).
  You do **NOT** need paid "Google Workspace / Gsuite". A normal free Gmail is fine.
- **Render** = the cloud computer that *runs* your website 24/7 so customers can
  reach it. This is the "hosting". (Railway.app works the same way if you prefer.)

They are not alternatives. Gmail sends the emails; Render runs the site.

---

## 3. Before you start — 3 free accounts

1. **Gmail** — you have this already.
2. **GitHub** (github.com) — free. This is where your code files live so Render
   can read them. Think of it as Google Drive, but for code.
3. **Render** (render.com) — free to start. This runs the site.

---

## 4. The one manual step only YOU can do: a Google App Password

Your site sends email from **admin@pawsly.id**, which is on Google Workspace. Google
won't let the server use your normal password, so you create a special 16-character
"App Password" (you can revoke it anytime without touching your real password).

1. Sign in to **admin@pawsly.id**, go to Google Account → **Security**, and turn on
   **2-Step Verification** if it isn't already (App Passwords won't appear without it).
2. Go to **myaccount.google.com/apppasswords**, create one named "FuFu booking",
   and copy the 16 letters it shows you.
3. That 16-letter code is your `SMTP_PASS` in Step 6. Keep `SMTP_HOST` = `smtp.gmail.com`
   and `SMTP_PORT` = `465`.

Keep the code somewhere safe and treat it like a password.

---

## 5. Put the files on GitHub

1. Create a free GitHub account and click **New repository**. Name it `fufu-booking`.
   Leave it Public or Private — either works.
2. On the repo page, click **Add file → Upload files**.
3. Upload **all** the files I gave you:
   `server.js`, `db.js`, `package.json`, `.gitignore`, `README.md`,
   including `index.html` and `fufu-logo.png`. There are **no folders** in this
   version — just select every file and upload them together.
   - **Do NOT upload** your `.env` file or any `data` folder. (`.gitignore` already
     protects these, but just don't upload them.)
4. Click **Commit changes**.

---

## 6. Create the site on Render

1. Sign in to Render with your GitHub account.
2. Click **New → Web Service**, and pick your `fufu-booking` repository.
3. Fill in:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. Scroll to **Environment Variables** and add these (one per row). Copy the names
   exactly:

   | Name | Value |
   |------|-------|
   | `SMTP_HOST` | smtp.gmail.com *(change only if pawsly.id isn't on Google)* |
   | `SMTP_PORT` | 465 |
   | `SMTP_USER` | admin@pawsly.id |
   | `SMTP_PASS` | *(the password from Step 4)* |
   | `OWNER_EMAIL` | admin@pawsly.id |
   | `BUSINESS_NAME` | Fu Fu Mahjong & Cafe |
   | `BANK_NAME` | BCA |
   | `BANK_ACCOUNT` | *(your BCA account number)* |
   | `BANK_HOLDER` | *(name on the account)* |
   | `ADMIN_KEY` | *(make up a long random password, e.g. `fufu-7hK2p9Wq`)* |

5. Click **Create Web Service** and wait a few minutes. When it's done, Render gives
   you a web address like `https://fufu-booking.onrender.com`.
6. Open that address. **That's your live booking website.** Test it by booking a
   slot with your own email — you should get two emails: the customer confirmation
   and an owner alert.

---

## 7. IMPORTANT: make bookings survive (read this before real customers use it)

On Render's **free** plan, the site "goes to sleep" when idle and the reservation
book (database) can be wiped when it restarts. That's fine for testing, but you'll
lose bookings in real use. Two ways to fix it:

- **Easiest:** upgrade the Render service to the small paid plan (about US$7/month)
  and add a **Persistent Disk** mounted at `/data`, then add one more environment
  variable `DB_PATH` = `/data/reservasi.db`. Bookings then survive forever.
- **Alternative:** use a free hosted database (Supabase or Neon). This needs a small
  code change — just ask and I'll prepare that version.

Decide this before you advertise the site to customers.

---

## 8. Changing your details later (prices, tables, menu, WhatsApp number)

All your settings sit at the **top** of `index.html`, clearly labelled.
Edit that file on GitHub (open it → pencil icon → edit → Commit), and Render updates
the site automatically in a minute or two. What you can change there:

- **`BUSINESS_WHATSAPP`** — put your real WhatsApp number here (e.g. `0812-3456-7890`).
  Right now it's a placeholder (`08XX-XXXX-XXXX`), so the "send payment proof to
  WhatsApp" button on the confirmation screen won't work until you set it.
- **`BRANCHES`** — your branches and the list of tables in each.
- **`slotPrice` / `baseSlotPrice`** — the per-hour prices (weekday, evening, weekend).
- **`ADDONS`** — the café menu items and prices.

(The file `reservasi.jsx` is only the preview you saw in our chat — the *live* site
is `index.html`.)

---

## 9. Running your business day to day

Until the automatic card/VA payment is connected (see Section 10), you confirm
payments by hand:

- **See your bookings:** open this address in a browser (replace the address and key
  with yours):
  `https://fufu-booking.onrender.com/api/reservations?key=YOUR_ADMIN_KEY`
- **Mark a booking as paid** after you see the transfer in your BCA:
  open `https://fufu-booking.onrender.com/api/reservations/FUFU-XXXXXX/pay?key=YOUR_ADMIN_KEY`
  (using that booking's code).
- You also get an **email alert** for every new booking, with a button to WhatsApp
  the customer directly.

A held table is released automatically after 30 minutes if unpaid, so slots don't
get stuck.

---

## 10. What's NOT built yet (be honest with yourself)

- **Automatic BCA Virtual Account payment.** Right now the VA number on screen is a
  realistic *placeholder*, and you confirm payment by hand (Section 9). To make the
  bank number real and payment automatic, you connect a payment gateway
  (**Xendit** or **Midtrans**). That's the next big step, and the system is already
  built to slot it in. Just ask when you're ready.
- **WhatsApp confirmations** (auto-sending a WhatsApp message, not just email) —
  optional later step via Fonnte/Wablas.

---

## 11. If any of this feels like too much

That's completely normal — deploying a website is a real (if small) technical task.
Everything above is a well-defined job that any freelance web developer can finish
in an hour or two, and **all the hard part (the code) is already done.** You can
hand them this folder and this guide and say: "Please deploy this to Render and set
the environment variables." If you'd like, I can also write a short message you can
send to a developer describing exactly what to do.

---

## Optional: trying it on your own computer first

Only if you're curious. You'd install Node.js (nodejs.org), open the folder in a
terminal, run `npm install`, copy `.env.example` to `.env` and fill it in, then run
`npm start`, and open `http://localhost:3001`. If that sentence felt like a foreign
language, skip this — Section 6 (Render) is the real path.

---

## Appendix: changing, replacing, or deleting a file on GitHub

You don't need any software — do it all on github.com in your repo
(Heriantois/Fufu-booking).

**Replace a file with an updated version (the usual case — e.g. the fixed files):**
1. Open your repository.
2. Click **Add file → Upload files**.
3. Drag in the new version. If it has the **same file name** as the old one, GitHub
   replaces it automatically — you don't need to delete the old one first.
4. Scroll down, click **Commit changes**.

**Edit a file's text by hand:**
1. Click the file name to open it, then click the **pencil (Edit)** icon (top right).
2. Make your change, scroll down, click **Commit changes**.

**Delete a file:**
1. Click the file name to open it.
2. Click the **… (three-dots)** menu near the top right and choose **Delete file**
   (on some screens it's a trash-can icon instead).
3. Scroll down, click **Commit changes**.

**Add the new `.node-version` file:**
- Easiest: **Add file → Upload files** and drag it in. Or **Add file → Create new
  file**, type `.node-version` as the name and `22.11.0` as the only content, then commit.

After any commit, Render notices the change and rebuilds your site automatically in a
minute or two. Watch the deploy log; it should now get past the step that failed before.
