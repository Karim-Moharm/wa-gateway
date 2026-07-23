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
