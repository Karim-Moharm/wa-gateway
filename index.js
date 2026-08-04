// wa-gateway: unofficial multi-session WhatsApp-Web gateway.
// Holds one whatsapp-web.js Client per sender ("session"), exposes a small
// HTTP API so an external app (Naweb) can request a QR login and send texts.
//
// WARNING: unofficial (drives the WhatsApp Web protocol via Puppeteer).
// Violates WhatsApp ToS. Sender numbers can get banned. Keep volume low.

require('dotenv').config();
const express = require('express');
const qrcode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const PORT = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY || 'change-this-shared-secret'; // master key: unrestricted, any session_id

// Per-client scoped keys, e.g. in .env:
//   SCOPED_API_KEYS=naweb:naweb-secret-key,gweb:gweb-secret-key
// A request authenticated with a scoped key may only touch sessions whose
// id starts with "<prefix>-" (e.g. key "naweb:xyz" can only use session ids
// like "naweb-clienta", never "gweb-anything"). This lets many clients share
// one gateway process without one client's leaked key exposing every other
// client's WhatsApp sessions.
const SCOPED_API_KEYS = new Map(); // key -> prefix

// Re-read the key list from .env WITHOUT restarting.
//
// Onboarding a client only means adding one line to SCOPED_API_KEYS. That used
// to need `pm2 restart`, which kills every connected client's Chromium and
// forces them all to reconnect - a bad trade for a config change that affects
// nobody but the new client. This reloads the keys in place; live sessions are
// untouched.
function loadScopedApiKeys() {
    const fs = require('fs');
    const path = require('path');
    let raw = process.env.SCOPED_API_KEYS || '';

    // Read the file directly - dotenv only populates process.env once, so on a
    // reload the file is the source of truth.
    try {
        const envText = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
        const line = envText.split(/\r?\n/).find((l) => l.trim().startsWith('SCOPED_API_KEYS='));
        if (line) raw = line.slice(line.indexOf('=') + 1).trim();
    } catch (err) { /* no .env - fall back to the environment */ }

    const next = new Map();
    raw.split(',').forEach((entry) => {
        const trimmed = entry.trim();
        if (!trimmed) return;
        const sep = trimmed.indexOf(':');
        if (sep === -1) {
            console.warn(`[config] ignoring malformed SCOPED_API_KEYS entry: "${trimmed}" (expected prefix:key)`);
            return;
        }
        const prefix = trimmed.slice(0, sep).trim();
        const key = trimmed.slice(sep + 1).trim();
        if (!prefix || !key) return;
        next.set(key, prefix);
    });

    SCOPED_API_KEYS.clear();
    next.forEach((prefix, key) => SCOPED_API_KEYS.set(key, prefix));
    console.log(`[config] loaded ${SCOPED_API_KEYS.size} scoped API key(s): ${[...SCOPED_API_KEYS.values()].join(', ')}`);
}

loadScopedApiKeys();

// Pick up .env edits automatically, so adding a client needs no restart and no
// command at all. Debounced: editors often write a file in several chunks.
try {
    const fs = require('fs');
    const path = require('path');
    let pending = null;
    fs.watch(path.join(__dirname, '.env'), () => {
        clearTimeout(pending);
        pending = setTimeout(() => {
            console.log('[config] .env changed - reloading scoped API keys');
            loadScopedApiKeys();
        }, 500);
    });
} catch (err) {
    console.warn('[config] could not watch .env (edit + SIGHUP still works):', err.message);
}

// Manual reload for hosts where file watching is unreliable (some Docker
// bind-mounts, network shares):  kill -HUP <pid>   /   pm2 sendSignal SIGHUP wa-gateway
process.on('SIGHUP', () => {
    console.log('[config] SIGHUP - reloading scoped API keys');
    loadScopedApiKeys();
});

// A single session's internal error (e.g. whatsapp-web.js failing to clean
// up its lockfile on logout) must not take down every other connected
// sender. Log and keep the process alive.
process.on('unhandledRejection', (err) => {
    console.error('[unhandledRejection]', err);
});
process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err);
});

const app = express();
app.use(express.json({ limit: '20mb' })); // PDF attachments arrive as base64 in the JSON body
app.use((req, res, next) => {
    console.log(`[http] ${req.method} ${req.path}`);
    next();
});

// sessionId -> { client, status: 'starting'|'qr'|'connected'|'disconnected', qr, number }
const sessions = new Map();

function requireApiKey(req, res, next) {
    const key = req.get('X-API-KEY');
    if (key === API_KEY) {
        req.sessionPrefix = null; // master key: no restriction
        return next();
    }
    if (SCOPED_API_KEYS.has(key)) {
        req.sessionPrefix = SCOPED_API_KEYS.get(key); // scoped key: restricted below
        return next();
    }
    return res.status(401).json({ ok: false, error: 'unauthorized' });
}

// Applied after requireApiKey on every route that names a session (either
// via :id in the URL or `session` in the JSON body). A scoped key may only
// touch session ids it owns; the master key (req.sessionPrefix === null)
// always passes.
function requireSessionAccess(req, res, next) {
    if (req.sessionPrefix === null) return next(); // master key
    const sessionId = req.params.id || (req.body && req.body.session);
    if (sessionId && sessionId.startsWith(`${req.sessionPrefix}-`)) return next();
    return res.status(403).json({
        ok: false,
        error: `this API key may only access sessions starting with "${req.sessionPrefix}-"`,
    });
}

// Tear down a session's browser and forget it, so the next start builds a
// fresh one. Never throws: on Windows destroy() often fails with EBUSY
// because Chromium still holds files in .wwebjs_auth - that must not stop us
// dropping the dead entry, which is the whole point.
async function destroySession(sessionId) {
    const s = sessions.get(sessionId);
    sessions.delete(sessionId);
    if (s && s.client) {
        try {
            await s.client.destroy();
        } catch (err) {
            console.warn(`[${sessionId}] destroy() failed (ignored):`, err.message);
        }
    }
}

function getOrCreateSession(sessionId) {
    let s = sessions.get(sessionId);
    // A dead session must NOT be handed back: whatsapp-web.js will never
    // re-initialize it, so the UI would sit on "disconnected" forever and the
    // only cure would be restarting the whole gateway (which is what used to
    // happen). Callers hitting /start clear it out first - see the endpoint.
    if (s && s.status !== 'disconnected') return s;
    if (s) sessions.delete(sessionId);

    s = { client: null, status: 'starting', qr: null, number: null };
    sessions.set(sessionId, s);

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: sessionId }),
        puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] },
    });

    client.on('qr', (qr) => {
        s.status = 'qr';
        s.qr = qr;
        console.log(`[${sessionId}] qr generated (scan within ~20s, it rotates)`);
    });

    client.on('loading_screen', (percent, message) => {
        console.log(`[${sessionId}] loading: ${percent}% ${message}`);
    });

    client.on('authenticated', () => {
        console.log(`[${sessionId}] authenticated (waiting for ready...)`);
    });

    client.on('ready', () => {
        s.status = 'connected';
        s.qr = null;
        s.number = client.info && client.info.wid ? client.info.wid.user : null;
        console.log(`[${sessionId}] connected as ${s.number}`);
    });

    client.on('disconnected', (reason) => {
        s.status = 'disconnected';
        s.qr = null;
        console.log(`[${sessionId}] disconnected: ${reason}`);
        // Drop the dead client so the next /start rebuilds from scratch.
        // Without this the entry lingers in `sessions` holding a browser that
        // will never reconnect. Delayed a little to let whatsapp-web.js finish
        // its own logout cleanup first, which reduces the Windows EBUSY noise.
        setTimeout(() => {
            if (sessions.get(sessionId) === s) {
                destroySession(sessionId).catch(() => {});
            }
        }, 3000);
    });

    client.on('auth_failure', (msg) => {
        s.status = 'disconnected';
        console.log(`[${sessionId}] auth failure: ${msg}`);
    });

    s.client = client;
    console.log(`[${sessionId}] initializing...`);
    client.initialize().catch((err) => {
        s.status = 'disconnected';
        console.error(`[${sessionId}] initialize() failed:`, err.message);
        // "Execution context was destroyed" / "Could not load response body"
        // are transient puppeteer races - usually the page navigated while
        // whatsapp-web.js was injecting. One clean retry fixes it; without it
        // the session sits dead until someone presses connect.
        if (!s.retried) {
            s.retried = true;
            console.log(`[${sessionId}] retrying once in 10s...`);
            setTimeout(async () => {
                await destroySession(sessionId);
                try {
                    getOrCreateSession(sessionId);
                } catch (e) {
                    console.error(`[${sessionId}] retry failed:`, e.message);
                }
            }, 10000);
        }
    });
    return s;
}

// Start (or resume) a session for a sender.
app.post('/sessions/:id/start', requireApiKey, requireSessionAccess, async (req, res) => {
    const sessionId = req.params.id;
    const existing = sessions.get(sessionId);

    // Pressing "connect" on a dead session must genuinely restart it. This is
    // what used to require restarting the whole gateway process after every
    // LOGOUT: the dead entry was returned as-is and never re-initialized.
    if (existing && existing.status === 'disconnected') {
        console.log(`[${sessionId}] restarting a disconnected session`);
        await destroySession(sessionId);
        // Give Chromium a moment to release its file handles, or LocalAuth
        // trips over EBUSY on Windows when it reopens the same profile.
        await new Promise((r) => setTimeout(r, 1500));
    }

    const s = getOrCreateSession(sessionId);
    res.json({ ok: true, status: s.status });
});

// Poll connection status.
app.get('/sessions/:id/status', requireApiKey, requireSessionAccess, (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.json({ ok: true, status: 'not_started' });
    res.json({ ok: true, status: s.status, number: s.number });
});

// Current QR code (data URL) while status === 'qr'.
app.get('/sessions/:id/qr', requireApiKey, requireSessionAccess, async (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s || !s.qr) return res.json({ ok: true, qr: null });
    const dataUrl = await qrcode.toDataURL(s.qr);
    res.json({ ok: true, qr: dataUrl });
});

// Log a session out and drop it (lets a fresh QR be issued).
app.post('/sessions/:id/logout', requireApiKey, requireSessionAccess, async (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.json({ ok: true });
    try {
        await s.client.logout();
    } catch (e) { /* ignore - Windows EBUSY on the profile folder is common */ }
    // Close the browser too, not just forget the entry: dropping the map entry
    // alone leaks a live Chromium (~200MB) for the life of the process.
    await destroySession(req.params.id);
    res.json({ ok: true });
});

// Shared preflight: session must exist and be connected, phone must resolve
// to a real WhatsApp account. Returns { session: s, numberId } or writes an
// error response and returns null.
async function resolveSendTarget(req, res) {
    const { session, phone } = req.body || {};
    const s = sessions.get(session);
    if (!s || s.status !== 'connected') {
        res.status(409).json({ ok: false, error: `session '${session}' not connected` });
        return null;
    }
    const digits = String(phone || '').replace(/\D/g, '');
    if (!digits) {
        res.status(400).json({ ok: false, error: 'invalid phone' });
        return null;
    }
    // sendMessage() crashes with an opaque internal error (e.g. "Cannot read
    // properties of undefined (reading 'id')") when the number isn't
    // registered on WhatsApp at all. Checking first gives a clear error.
    const numberId = await s.client.getNumberId(digits);
    if (!numberId) {
        res.status(400).json({ ok: false, error: `الرقم ${digits} غير مسجل على واتساب` });
        return null;
    }
    return { s, numberId };
}

// Send a text message. body: { session, phone, message }
// phone: digits only, E.164 without '+' (e.g. "201234567890").
app.post('/send', requireApiKey, requireSessionAccess, async (req, res) => {
    const { session, phone, message } = req.body || {};
    if (!session || !phone || !message) {
        return res.status(400).json({ ok: false, error: 'session, phone and message are required' });
    }
    try {
        const target = await resolveSendTarget(req, res);
        if (!target) return;
        const sent = await target.s.client.sendMessage(target.numberId._serialized, message);
        res.json({ ok: true, id: (sent && sent.id) ? sent.id._serialized : null });
    } catch (e) {
        console.error(`[${session}] send failed:`, e);
        res.status(500).json({ ok: false, error: e.message || String(e) });
    }
});

// Send a document (e.g. an invoice PDF) with an optional text caption.
// body: { session, phone, message, filename, pdf_base64 }
app.post('/send-document', requireApiKey, requireSessionAccess, async (req, res) => {
    const { session, phone, message, filename, pdf_base64 } = req.body || {};
    if (!session || !phone || !pdf_base64) {
        return res.status(400).json({ ok: false, error: 'session, phone and pdf_base64 are required' });
    }
    try {
        const target = await resolveSendTarget(req, res);
        if (!target) return;
        const media = new MessageMedia('application/pdf', pdf_base64, filename || 'document.pdf');
        const sent = await target.s.client.sendMessage(target.numberId._serialized, media, {
            caption: message || undefined,
        });
        res.json({ ok: true, id: (sent && sent.id) ? sent.id._serialized : null });
    } catch (e) {
        console.error(`[${session}] send-document failed:`, e);
        res.status(500).json({ ok: false, error: e.message || String(e) });
    }
});

// Re-open every session that already has a saved login on disk.
//
// Without this, the `sessions` Map starts empty after every restart/deploy and
// /send answers "not connected" until a human opens the settings page and
// presses "connect" - which is why clients believed they had to re-scan after
// every restart. They never did: LocalAuth keeps the login in
// .wwebjs_auth/session-<id>, so this reconnects silently with no QR.
//
// Staggered because each session is a full Chromium (~200MB); starting a
// dozen at once would spike RAM hard enough to get them OOM-killed.
function restoreSessions() {
    const fs = require('fs');
    const path = require('path');
    const authDir = path.join(__dirname, '.wwebjs_auth');

    let entries;
    try {
        entries = fs.readdirSync(authDir, { withFileTypes: true });
    } catch (err) {
        console.log('[restore] no .wwebjs_auth yet - nothing to restore');
        return;
    }

    const ids = entries
        .filter((e) => e.isDirectory() && e.name.startsWith('session-'))
        .map((e) => e.name.slice('session-'.length));

    if (!ids.length) {
        console.log('[restore] no saved sessions found');
        return;
    }

    console.log(`[restore] found ${ids.length} saved session(s): ${ids.join(', ')}`);

    // SEQUENTIAL, not staggered by a fixed delay. Booting several Chromiums at
    // once starves them and whatsapp-web.js dies mid-injection with
    // "Execution context was destroyed, most likely because of a navigation".
    // So: start one, wait until it settles (qr / connected / disconnected) or
    // times out, only then start the next.
    (async () => {
        for (const id of ids) {
            console.log(`[restore] starting ${id}`);
            try {
                getOrCreateSession(id);
            } catch (err) {
                console.error(`[restore] ${id} failed:`, err.message);
                continue;
            }

            const startedAt = Date.now();
            const TIMEOUT_MS = 120000;
            while (Date.now() - startedAt < TIMEOUT_MS) {
                const s = sessions.get(id);
                if (!s || s.status !== 'starting') break;
                await new Promise((r) => setTimeout(r, 2000));
            }

            const s = sessions.get(id);
            const status = s ? s.status : 'gone';
            console.log(`[restore] ${id} settled as "${status}"`);
            if (status === 'qr') {
                console.log(`[restore] ${id} has NO valid saved login - it needs a QR scan once`);
            }
            // Small gap so the previous browser finishes settling before the
            // next one competes for CPU.
            await new Promise((r) => setTimeout(r, 3000));
        }
        console.log('[restore] done');
    })();
}

app.listen(PORT, () => {
    console.log(`wa-gateway listening on http://localhost:${PORT}`);
    restoreSessions();
});
