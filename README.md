# wa-gateway

Unofficial multi-session WhatsApp-Web gateway used by Naweb to send custom
WhatsApp text messages without Meta Business verification or template
approval.

**Warning:** this drives the WhatsApp Web protocol via `whatsapp-web.js`
(Puppeteer/Chromium), not the official Meta Cloud API. It is against
WhatsApp's Terms of Service. The sender number risks being banned,
especially with high volume or messages to non-contacts. Keep volume low
and human-paced. Use a number you can afford to lose.

## Setup

```
cd C:\dev\wa-gateway
npm install
copy .env.example .env
# edit .env: set API_KEY to a real shared secret
node index.js
```

First run downloads Chromium via Puppeteer (~300MB) — expect it to take a
few minutes.

### Chromium launch prerequisites (do this before first run, on every host)

Puppeteer's bundled Chromium needs OS-level dependencies present, or
`client.initialize()` fails immediately with no WhatsApp-related error.

- **Windows** — install "Microsoft Visual C++ Redistributable (x64)":
  `https://aka.ms/vs/17/release/vc_redist.x64.exe`, then reboot. Missing
  this causes a launch crash with exit code `3221226505` (`0xC0000409`).
- **Linux (Debian/Ubuntu)** — install Chromium's shared-lib dependencies:
  ```
  sudo apt-get update && sudo apt-get install -y \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
    libpangocairo-1.0-0 libgtk-3-0
  ```
  (Package names vary slightly by distro/version — see
  https://pptr.dev/troubleshooting if `initialize()` still fails after this.)

If `initialize()` throws in the gateway's console, that's this class of
issue — a missing OS dependency, not a WhatsApp/account problem. Check the
Node terminal output, not just the browser.

## API

All endpoints require header `X-API-KEY: <API_KEY>`.

- `POST /sessions/:id/start` — start/resume a session (id = your chosen
  sender slug, e.g. `main`). Sessions persist login in `.wwebjs_auth/`, so a
  restart does not require a re-scan.
- `GET /sessions/:id/status` — `{ status: starting|qr|connected|disconnected|not_started, number }`
- `GET /sessions/:id/qr` — `{ qr: "data:image/png;base64,..." }` while status is `qr`
- `POST /sessions/:id/logout` — log the session out (forces a fresh QR next start)
- `POST /send` — `{ session, phone, message }` → `{ ok, id }`. `phone` is
  digits only (country code, no `+`), e.g. `201234567890`.
- `POST /send-document` — `{ session, phone, message, filename, pdf_base64 }`
  → `{ ok, id }`. Sends a PDF (base64-encoded) as a document attachment,
  `message` becomes its caption.

## Running as a persistent service

Use `pm2` or Windows Task Scheduler / NSSM to keep `node index.js` running
alongside the Django app. It listens on port 3001 by default.

## Multi-client mode (one gateway, many clients, one key PER CLIENT)

One gateway process serves every client of every project (Naweb, Gweb,
every branch of each) — never a separate gateway per client, that's the
RAM/ops multiplication we deliberately avoid. Isolation between clients
comes entirely from `SCOPED_API_KEYS` (see `.env.example`): **one scoped
key per client**, not one per project. A leaked/compromised key for one
client then can never touch any *other* client's WhatsApp sessions — not
even two branches of the same project.

```
SCOPED_API_KEYS=naweb-autonation:8f2a...,naweb-starchem:1c9e...,gweb-shopa:44bb...
```

- `API_KEY` (singular, no colon) stays the master/admin key — unrestricted,
  works on any session id. Keep it private, never hand it to a client.
- Each `SCOPED_API_KEYS` entry is `prefix:key`. A request authenticated with
  that key may only touch session ids starting with `<prefix>-`. Wrong
  session → `403`.
- The project tag (`naweb`/`gweb`) is a **fixed constant baked into each
  project's own codebase**, not something you type per client — every
  session id that project generates automatically starts with it. Only the
  part after that (the client name) plus a random uuid come from the
  client's own domain/company, fully automatic, nothing typed.

### Onboarding a new client — worked example (Autonation, a Naweb client)

1. In Autonation's own Naweb deployment, staff opens `/whatsapp/settings/`
   and adds a sender. The system generates its session id by itself —
   something like:
   ```
   naweb-autonation-a1b2c3d4
   ```
   `naweb-` = fixed Naweb project tag. `autonation` = slugified from that
   client's own domain or company name (COM11). `a1b2c3d4` = random, just
   for uniqueness. Nobody types any of this.
2. Read the **middle part** off the sender row in that settings page
   (shown under the sender's name) — here, `autonation`.
3. Generate a real secret for this client (don't use a guessable string):
   ```bash
   openssl rand -hex 32
   ```
   Say it prints `8f2a9d...` (some long random string).
4. On the server running `wa-gateway`, edit `.env` and add ONE new entry to
   the existing `SCOPED_API_KEYS` line (comma-separated, don't remove the
   others):
   ```
   SCOPED_API_KEYS=naweb-autonation:8f2a9d...,<...whatever was already there...>
   ```
5. Restart so it picks up the change:
   ```bash
   pm2 restart wa-gateway
   pm2 logs wa-gateway --lines 20   # confirm it loaded the new key
   ```
6. Paste that **same** `8f2a9d...` string into Autonation's own
   `WhatsappConfig.api_key` (Naweb's `/whatsapp/settings/` or Django admin).
   `gateway_url` stays whatever this shared gateway's actual address is
   (e.g. `http://localhost:3001` if co-located on the same server).
7. Connect the sender (اتصال / QR) from Autonation's settings page, scan,
   test one send.

That's the whole per-client checklist, repeated identically for every new
client of every project, forever — one line added to `SCOPED_API_KEYS`, one
restart, one key pasted into that client's own config.

**Trade-off you're still accepting** by sharing one process: if this
gateway crashes or restarts, sending stops for *every* client at once, and
RAM is shared across everyone's active sessions (~150-250MB per connected
session — watch total usage as client count grows; see Naweb's
`whatsapp/README.md` for what to do when RAM becomes the actual bottleneck).

After changing `.env` or `index.js`, the running process must be restarted
to pick up the change (`pm2 restart wa-gateway`) — Node doesn't hot-reload.
Existing WhatsApp logins are unaffected (persisted in `.wwebjs_auth/`), so a
restart does not require re-scanning any QR codes.
