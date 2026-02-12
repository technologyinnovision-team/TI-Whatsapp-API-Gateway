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
    // Return if already connected
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
            retryCache: new Map(), // Per-session retry cache
            retryCount: 0 // Track reconnection attempts
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
        msgRetryCounterCache: sessionState.retryCache,
        // Don't auto-mark online on connect
        markOnlineOnConnect: false 
    });

    sessionState.socket = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            sessionState.qr = qr;
            sessionState.status = 'scanning';
            console.log(`[${sessionId}] QR Generated`);
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            
            sessionState.status = 'disconnected';
            console.log(`[${sessionId}] Closed. Code: ${statusCode}, Reconnect: ${shouldReconnect}`);

            if (shouldReconnect) {
                // Exponential backoff for reconnection
                const delayMs = Math.min(1000 * Math.pow(2, sessionState.retryCount), 60000); // Cap at 1 min
                console.log(`[${sessionId}] Reconnecting in ${delayMs / 1000}s...`);
                sessionState.retryCount++;
                
                setTimeout(() => startSession(sessionId), delayMs);
            } else {
                console.log(`[${sessionId}] Logged out or fatal error.`);
                sessionState.status = 'logged_out';
                sessionState.retryCount = 0;
                try { sock.end(undefined); } catch { }
                // Clean up session if logged out
                sessions.delete(sessionId);
                try {
                     fs.rmSync(path.join(BASE_AUTH_DIR, sessionId), { recursive: true, force: true });
                } catch (e) { console.error(`Failed to cleanup ${sessionId}:`, e); }
            }
        } else if (connection === 'open') {
            console.log(`[${sessionId}] Connected`);
            sessionState.status = 'connected';
            sessionState.qr = null;
            sessionState.retryCount = 0;
            
            // Immediately go offline to prevent "Always Online"
            try {
                await sock.sendPresenceUpdate('unavailable');
            } catch (err) {
                console.error(`[${sessionId}] Failed to set initial offline status:`, err);
            }
        } else if (connection === 'connecting') {
            sessionState.status = 'connecting';
        }
    });

    // Handle initial connection errors that might not trigger connection.update
    sock.ev.on('error', (err) => {
        console.error(`[${sessionId}] Socket error:`, err);
    });
}

// Restore sessions
if (fs.existsSync(BASE_AUTH_DIR)) {
    fs.readdirSync(BASE_AUTH_DIR).forEach(file => {
        if (fs.statSync(path.join(BASE_AUTH_DIR, file)).isDirectory()) {
            startSession(file);
        }
    });
}

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
    const sessionId = req.params.id;
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'connected') {
        return res.status(400).json({ error: 'Session not connected' });
    }

    const { to, message } = req.body;
    if (!to || !message) return res.status(400).json({ error: 'Missing fields' });

    try {
        let jid = to.includes('@s.whatsapp.net') ? to : `${to}@s.whatsapp.net`;
        const socket = session.socket;

        const [result] = await socket.onWhatsApp(jid);
        if (result?.exists) jid = result.jid;

        // Human-like behavior simulation
        // 1. Mark as available (Online)
        await socket.sendPresenceUpdate('available');
        
        // 2. Mock typing (Composing)
        await socket.sendPresenceUpdate('composing', jid);
        
        // Calculate a random typing delay based heavily on message length, 
        // but kept sane (min 1s, max 5s) for responsiveness.
        const typingDelay = Math.min(Math.max(message.length * 30, 1000), 5000);
        await new Promise(resolve => setTimeout(resolve, typingDelay));

        // 3. Pause composing
        await socket.sendPresenceUpdate('paused', jid);

        // 4. Send Message
        await socket.sendMessage(jid, { text: message });

        // 5. Go offline after a short delay to simulate closing the app
        // Random usage delay between 5s and 15s
        const offlineDelay = Math.floor(Math.random() * 10000) + 5000;
        setTimeout(async () => {
             // Check if we are still connected before trying to send
             if (sessions.get(sessionId)?.status === 'connected') {
                 try {
                    await socket.sendPresenceUpdate('unavailable');
                    console.log(`[${sessionId}] Set to unavailable (auto-offline)`);
                 } catch (e) {
                     console.error(`[${sessionId}] Failed to set offline:`, e);
                 }
             }
        }, offlineDelay);

        res.json({ success: true, jid });
    } catch (err) {
        console.error(`[${sessionId}] Send Error:`, err);
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
