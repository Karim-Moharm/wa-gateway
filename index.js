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
(process.env.SCOPED_API_KEYS || '').split(',').forEach((entry) => {
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
    SCOPED_API_KEYS.set(key, prefix);
});
if (SCOPED_API_KEYS.size > 0) {
    console.log(`[config] loaded ${SCOPED_API_KEYS.size} scoped API key(s): ${[...SCOPED_API_KEYS.values()].join(', ')}`);
}

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

function getOrCreateSession(sessionId) {
    let s = sessions.get(sessionId);
    if (s) return s;

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
    });

    client.on('auth_failure', (msg) => {
        s.status = 'disconnected';
        console.log(`[${sessionId}] auth failure: ${msg}`);
    });

    s.client = client;
    console.log(`[${sessionId}] initializing...`);
    client.initialize().catch((err) => {
        s.status = 'disconnected';
        console.error(`[${sessionId}] initialize() failed:`, err);
    });
    return s;
}

// Start (or resume) a session for a sender.
app.post('/sessions/:id/start', requireApiKey, requireSessionAccess, (req, res) => {
    const s = getOrCreateSession(req.params.id);
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
    } catch (e) { /* ignore */ }
    sessions.delete(req.params.id);
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

app.listen(PORT, () => {
    console.log(`wa-gateway listening on http://localhost:${PORT}`);
});
