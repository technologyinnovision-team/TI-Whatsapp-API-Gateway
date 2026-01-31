import express from 'express';
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import cors from 'cors';
import pino from 'pino';
import fs from 'fs';
import QRCode from 'qrcode';
import path from 'path';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3000;
const BASE_AUTH_DIR = './auth_info';

// State: Map<sessionId, { socket, qr, status, retryCache }>
const sessions = new Map();

if (!fs.existsSync(BASE_AUTH_DIR)) {
    fs.mkdirSync(BASE_AUTH_DIR);
}

const getLogger = (sessionId) => pino({ level: 'silent', name: `session-${sessionId}` });

async function startSession(sessionId) {
    if (sessions.has(sessionId) && sessions.get(sessionId).status === 'connected') {
        return;
    }

    const authDir = path.join(BASE_AUTH_DIR, sessionId);
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    // Initialize session state if new
    if (!sessions.has(sessionId)) {
        sessions.set(sessionId, {
            status: 'initializing',
            qr: null,
            socket: null,
            retryCache: new Map() // Per-session retry cache
        });
    }

    const sessionState = sessions.get(sessionId);
    console.log(`[${sessionId}] Starting session...`);

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, getLogger(sessionId)),
        },
        logger: getLogger(sessionId),
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        emitOwnEvents: true,
        fireInitQueries: true,
        msgRetryCounterCache: sessionState.retryCache // Use the isolated cache
    });

    sessionState.socket = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            sessionState.qr = qr;
            sessionState.status = 'scanning';
            console.log(`[${sessionId}] QR Generated`);
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            sessionState.status = 'disconnected';
            console.log(`[${sessionId}] Closed (Reconnect: ${shouldReconnect})`);

            if (shouldReconnect) {
                setTimeout(() => startSession(sessionId), 2000);
            } else {
                console.log(`[${sessionId}] Logged out.`);
                sessionState.status = 'logged_out';
                try { sock.end(undefined); } catch { }
                // We keep the state object but mark it logged out
            }
        } else if (connection === 'open') {
            console.log(`[${sessionId}] Connected`);
            sessionState.status = 'connected';
            sessionState.qr = null;
        } else if (connection === 'connecting') {
            sessionState.status = 'connecting';
        }
    });
}

// Restore sessions
fs.readdirSync(BASE_AUTH_DIR).forEach(file => {
    if (fs.statSync(path.join(BASE_AUTH_DIR, file)).isDirectory()) {
        startSession(file);
    }
});

// --- Endpoints ---

app.post('/session/init', async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });
    await startSession(sessionId);
    res.json({ success: true, sessionId });
});

app.get('/session/:id/status', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.json({ status: 'not_found' });
    res.json({ status: session.status, user: session.socket?.user });
});

app.get('/session/:id/qr', async (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session || !session.qr) {
        return res.json({ status: session ? session.status : 'not_found', qrImage: null });
    }
    try {
        const url = await QRCode.toDataURL(session.qr);
        res.json({ status: session.status, qrImage: url });
    } catch {
        res.status(500).json({ error: "QR Gen failed" });
    }
});

app.post('/session/:id/send', async (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session || session.status !== 'connected') {
        return res.status(400).json({ error: 'Session not connected' });
    }

    const { to, message } = req.body;
    if (!to || !message) return res.status(400).json({ error: 'Missing fields' });

    try {
        let jid = to.includes('@s.whatsapp.net') ? to : `${to}@s.whatsapp.net`;
        const [result] = await session.socket.onWhatsApp(jid);
        if (result?.exists) jid = result.jid;

        await session.socket.sendMessage(jid, { text: message });
        res.json({ success: true, jid });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/session/:id', async (req, res) => {
    const sessionId = req.params.id;
    const session = sessions.get(sessionId);
    if (session) {
        if (session.socket) {
            // Removes all listeners to prevent leak
            session.socket.ev.removeAllListeners('connection.update');
            session.socket.ev.removeAllListeners('creds.update');
            try { await session.socket.logout(); } catch { }
            try { session.socket.end(undefined); } catch { }
        }
        sessions.delete(sessionId);
    }

    try {
        fs.rmSync(path.join(BASE_AUTH_DIR, sessionId), { recursive: true, force: true });
    } catch (e) {
        console.error(`Failed to delete dir for ${sessionId}:`, e);
    }

    res.json({ success: true });
});

app.listen(PORT, () => {
    console.log(`Multi-Tenant Bridge running on http://localhost:${PORT}`);
});
