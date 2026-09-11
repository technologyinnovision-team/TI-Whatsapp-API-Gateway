import express from 'express';
import cors from 'cors';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import QRCode from 'qrcode';
import dotenv from 'dotenv';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers,
    makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';

import { resolveSpintax, calculateTypingDelay, calculateIntervalDelay, SessionSafetyTracker } from './lib/anti-ban.js';
import { buildMessagePayload, buildInteractiveButtonsMessage, getInteractiveAdditionalNodes } from './lib/media.js';
import { dispatchWebhook, getRecentWebhookLogs } from './lib/webhook.js';
import { loadButtonReplies, saveButtonReplies, registerButtonReply, findButtonReply, extractIncomingMessageData, getOriginalRecipientFromMessage } from './lib/button-replies.js';

dotenv.config({ path: path.resolve(process.cwd(), '../.env') });
dotenv.config(); // local fallback

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

const PORT = parseInt(process.env.BRIDGE_PORT || process.env.PORT || '3001', 10);
const BASE_AUTH_DIR = path.resolve(process.env.AUTH_DIR || './auth_info');
const GLOBAL_WEBHOOK_URL = process.env.GLOBAL_WEBHOOK_URL || '';
const GLOBAL_WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const FLASK_PORT = parseInt(process.env.WEB_PORT || '5000', 10);
const FLASK_INTERNAL_URL = process.env.FLASK_INTERNAL_URL || `http://127.0.0.1:${FLASK_PORT}`;

function notifyFlaskInternal(eventType, data) {
    try {
        fetch(`${FLASK_INTERNAL_URL}/internal/event`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event: eventType, data })
        }).catch(() => {});
    } catch (e) {}
}

if (!fs.existsSync(BASE_AUTH_DIR)) {
    fs.mkdirSync(BASE_AUTH_DIR, { recursive: true });
}

// In-Memory Sessions Registry
// Map<sessionId, { socket, qr, pairingCode, status, retryCache, retryCount, safety, queue, isProcessingQueue, settings, autoOfflineTimer } >
const sessions = new Map();

const getLogger = (sessionId) => pino({ level: 'silent', name: `wa-${sessionId}` });

function loadSessionSettings(sessionId) {
    const settingsPath = path.join(BASE_AUTH_DIR, sessionId, 'settings.json');
    try {
        if (fs.existsSync(settingsPath)) {
            return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        }
    } catch (e) {
        // ignore
    }
    return {
        proxyUrl: '',
        minDelayMs: 4000,
        maxDelayMs: 9000,
        customDailyQuota: 300,
        webhookUrl: '',
        webhookSecret: '',
        mode: 'standard', // 'safe', 'standard', 'fast'
        autoReplyRules: []
    };
}

function saveSessionSettings(sessionId, settings) {
    const dir = path.join(BASE_AUTH_DIR, sessionId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2));
}

function loadLidMap(baseDir, sessionId) {
    const file = path.join(baseDir, sessionId, 'lid_map.json');
    const map = new Map();
    try {
        if (fs.existsSync(file)) {
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            for (const [k, v] of Object.entries(data)) {
                map.set(k, v);
            }
        }
    } catch (e) {}
    return map;
}

function saveLidMap(baseDir, sessionId, lidMap) {
    if (!lidMap) return;
    const dir = path.join(baseDir, sessionId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'lid_map.json');
    try {
        const obj = Object.fromEntries(lidMap.entries());
        fs.writeFileSync(file, JSON.stringify(obj, null, 2));
    } catch (e) {}
}

function createProxyAgent(proxyUrl) {
    if (!proxyUrl) return undefined;
    try {
        if (proxyUrl.startsWith('socks5://') || proxyUrl.startsWith('socks4://')) {
            return new SocksProxyAgent(proxyUrl);
        } else if (proxyUrl.startsWith('http://') || proxyUrl.startsWith('https://')) {
            return new HttpsProxyAgent(proxyUrl);
        }
    } catch (err) {
        console.error(`Invalid proxy URL: ${proxyUrl}`, err.message);
    }
    return undefined;
}

/**
 * Initializes or starts a WhatsApp session.
 */
async function startSession(sessionId, options = {}) {
    const existing = sessions.get(sessionId);
    if (existing && (existing.status === 'connected' || existing.status === 'connecting')) {
        return existing;
    }

    const authDir = path.join(BASE_AUTH_DIR, sessionId);
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

    const settings = { ...loadSessionSettings(sessionId), ...options };
    saveSessionSettings(sessionId, settings);

    const safety = new SessionSafetyTracker(sessionId, BASE_AUTH_DIR);
    safety.stats.customDailyQuota = settings.customDailyQuota || 300;
    safety.stats.mode = settings.mode || 'standard';
    safety.stats.hasProxy = Boolean(settings.proxyUrl);
    safety.saveStats();

    const sessionState = {
        socket: null,
        qr: null,
        pairingCode: null,
        status: 'initializing',
        retryCache: new Map(),
        retryCount: 0,
        safety: safety,
        queue: [],
        isProcessingQueue: false,
        settings: settings,
        autoOfflineTimer: null,
        chats: new Map(),
        contacts: new Map(),
        buttonReplies: loadButtonReplies(BASE_AUTH_DIR, sessionId),
        messageRecipients: new Map(),
        lidMap: loadLidMap(BASE_AUTH_DIR, sessionId)
    };
    sessions.set(sessionId, sessionState);

    console.log(`[${sessionId}] Initializing session (Proxy: ${settings.proxyUrl || 'Direct'})...`);

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();
    const agent = createProxyAgent(settings.proxyUrl);

    if (!sessionState.messageStore) {
        sessionState.messageStore = new Map();
    }

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, getLogger(sessionId)),
        },
        logger: getLogger(sessionId),
        printQRInTerminal: false,
        browser: Browsers.macOS('Desktop'),
        syncFullHistory: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 15000,
        emitOwnEvents: false,
        fireInitQueries: true,
        generateHighQualityLinkPreview: true,
        markOnlineOnConnect: false,
        msgRetryCounterCache: sessionState.retryCache,
        getMessage: async (key) => {
            if (sessionState.messageStore && sessionState.messageStore.has(key.id)) {
                return sessionState.messageStore.get(key.id);
            }
            return undefined;
        },
        agent: agent
    });

    sessionState.socket = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            sessionState.qr = qr;
            sessionState.status = 'scanning';
            console.log(`[${sessionId}] QR code updated`);
            dispatchWebhook(settings.webhookUrl || GLOBAL_WEBHOOK_URL, 'connection.update', {
                sessionId,
                status: 'scanning',
                qrAvailable: true
            }, settings.webhookSecret || GLOBAL_WEBHOOK_SECRET);
        }

        if (connection === 'connecting') {
            sessionState.status = 'connecting';
        } else if (connection === 'open') {
            console.log(`[${sessionId}] Successfully connected! User: ${sock.user?.id || 'OK'}`);
            sessionState.status = 'connected';
            sessionState.qr = null;
            sessionState.pairingCode = null;
            sessionState.retryCount = 0;

            // Automatically set unavailable to avoid 24/7 online detection
            try {
                await sock.sendPresenceUpdate('unavailable');
            } catch (e) {
                // ignore
            }

            dispatchWebhook(settings.webhookUrl || GLOBAL_WEBHOOK_URL, 'connection.update', {
                sessionId,
                status: 'connected',
                user: sock.user
            }, settings.webhookSecret || GLOBAL_WEBHOOK_SECRET);
        } else if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            const isLoggedOut = statusCode === DisconnectReason.loggedOut;
            const shouldReconnect = !isLoggedOut;

            console.log(`[${sessionId}] Closed (Code: ${statusCode}, ShouldReconnect: ${shouldReconnect})`);
            sessionState.status = isLoggedOut ? 'logged_out' : 'disconnected';

            dispatchWebhook(settings.webhookUrl || GLOBAL_WEBHOOK_URL, 'connection.update', {
                sessionId,
                status: sessionState.status,
                statusCode
            }, settings.webhookSecret || GLOBAL_WEBHOOK_SECRET);

            if (shouldReconnect) {
                sessionState.retryCount++;
                const delayMs = Math.min(1500 * Math.pow(1.8, sessionState.retryCount), 60000);
                console.log(`[${sessionId}] Scheduling reconnection in ${Math.round(delayMs / 1000)}s...`);
                setTimeout(() => {
                    startSession(sessionId, settings);
                }, delayMs);
            } else {
                console.log(`[${sessionId}] Session logged out. Cleaning up credentials.`);
                try {
                    sock.end(undefined);
                } catch {}
                try {
                    fs.rmSync(authDir, { recursive: true, force: true });
                } catch (e) {
                    console.error(`Failed to clean dir for ${sessionId}:`, e.message);
                }
                sessions.delete(sessionId);
            }
        }
    });

    // Synchronize contacts and linked device privacy LIDs (LID <-> Phone JID)
    sock.ev.on('chats.phoneNumberShare', ({ lid, jid }) => {
        if (lid && jid) {
            sessionState.lidMap.set(lid, jid);
            sessionState.lidMap.set(jid, lid);
            saveLidMap(BASE_AUTH_DIR, sessionId, sessionState.lidMap);
            console.log(`[${sessionId}] LID mapped from phoneNumberShare: ${lid} <-> ${jid}`);
        }
    });

    sock.ev.on('contacts.upsert', (contacts) => {
        let updated = false;
        for (const c of contacts || []) {
            if (c.id && c.lid) {
                sessionState.lidMap.set(c.lid, c.id);
                sessionState.lidMap.set(c.id, c.lid);
                updated = true;
            }
        }
        if (updated) {
            saveLidMap(BASE_AUTH_DIR, sessionId, sessionState.lidMap);
        }
    });

    sock.ev.on('contacts.update', (contacts) => {
        let updated = false;
        for (const c of contacts || []) {
            if (c.id && c.lid) {
                sessionState.lidMap.set(c.lid, c.id);
                sessionState.lidMap.set(c.id, c.lid);
                updated = true;
            }
        }
        if (updated) {
            saveLidMap(BASE_AUTH_DIR, sessionId, sessionState.lidMap);
        }
    });

    // Handle Incoming Messages
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify' && type !== 'append') return;

        for (const msg of messages) {
            if (msg.key.fromMe) continue; // ignore outgoing

            const sender = msg.key.remoteJid;
            const isGroup = sender.endsWith('@g.us');
            const pushName = msg.pushName || '';

            const { body, messageType, buttonId, buttonText, quotedMessageId } = extractIncomingMessageData(msg);

            // Resolve the true recipient phone JID (especially if sender is a WhatsApp Privacy LID @lid)
            let resolvedSender = sender;
            if (quotedMessageId) {
                const originalTarget = sessionState.messageRecipients?.get(quotedMessageId) ||
                                       getOriginalRecipientFromMessage(sessionState.buttonReplies, quotedMessageId);
                if (originalTarget) {
                    resolvedSender = originalTarget;
                    if (sender.endsWith('@lid')) {
                        sessionState.lidMap.set(sender, originalTarget);
                        sessionState.lidMap.set(originalTarget, sender);
                        saveLidMap(BASE_AUTH_DIR, sessionId, sessionState.lidMap);
                        console.log(`[${sessionId}] Learned and saved LID mapping from quote: ${sender} -> ${originalTarget}`);
                    }
                }
            } else if (sender.endsWith('@lid') && sessionState.lidMap.has(sender)) {
                resolvedSender = sessionState.lidMap.get(sender);
            }

            const senderPhone = resolvedSender.replace('@s.whatsapp.net', '').replace('@g.us', '').replace('@lid', '');

            const eventData = {
                sessionId,
                messageId: msg.key.id,
                from: resolvedSender,
                rawSender: sender,
                phone: senderPhone,
                isGroup,
                pushName,
                type: messageType,
                body,
                buttonId,
                buttonText,
                quotedMessageId,
                timestamp: msg.messageTimestamp
            };

            // Dispatch webhook
            dispatchWebhook(settings.webhookUrl || GLOBAL_WEBHOOK_URL, 'message.received', eventData, settings.webhookSecret || GLOBAL_WEBHOOK_SECRET);
            notifyFlaskInternal('message.received', eventData);
            if (messageType === 'interactive_response' || messageType === 'button_reply' || buttonId) {
                dispatchWebhook(settings.webhookUrl || GLOBAL_WEBHOOK_URL, 'message.button_clicked', eventData, settings.webhookSecret || GLOBAL_WEBHOOK_SECRET);
            }

            // Check auto-reply:
            // 1. Quick Reply button mapping check
            const candidateKeys = [body, buttonText, buttonId].filter(Boolean);
            let matchedReply = findButtonReply(sessionState.buttonReplies, quotedMessageId, resolvedSender, candidateKeys);
            if (!matchedReply && sender !== resolvedSender) {
                matchedReply = findButtonReply(sessionState.buttonReplies, quotedMessageId, sender, candidateKeys);
            }

            // 2. Chatbot Auto-Reply Rules fallback
            if (!matchedReply && settings.autoReplyRules && Array.isArray(settings.autoReplyRules) && candidateKeys.length > 0) {
                for (const rule of settings.autoReplyRules) {
                    if (!rule.enabled || !rule.replyText) continue;
                    let matched = false;
                    const trigger = (rule.trigger || '').trim().toLowerCase();

                    for (const term of candidateKeys) {
                        const cleanMsg = term.trim().toLowerCase();
                        if (rule.matchType === 'exact' && cleanMsg === trigger) matched = true;
                        else if (rule.matchType === 'contains' && cleanMsg.includes(trigger)) matched = true;
                        else if (rule.matchType === 'starts_with' && cleanMsg.startsWith(trigger)) matched = true;
                        else if (rule.matchType === 'regex') {
                            try {
                                if (new RegExp(rule.trigger, 'i').test(cleanMsg)) matched = true;
                            } catch (e) {}
                        }
                        if (matched) break;
                    }

                    if (matched) {
                        matchedReply = rule.replyText;
                        break;
                    }
                }
            }

            // 3. Dispatch auto-reply if matched
            if (matchedReply) {
                const replyContent = resolveSpintax(matchedReply);
                console.log(`[${sessionId}] Quick Reply / Auto-Reply triggered for ${resolvedSender} (sender: ${sender}, text: "${body}") -> "${replyContent}"`);
                enqueueMessage(sessionId, {
                    type: 'text',
                    to: resolvedSender,
                    options: { text: replyContent }
                }).then(sentResult => {
                    const autoReplyPayload = {
                        sessionId,
                        recipient: resolvedSender,
                        originalSender: sender,
                        originalMessage: body,
                        replyText: replyContent,
                        messageId: sentResult?.messageId
                    };
                    dispatchWebhook(settings.webhookUrl || GLOBAL_WEBHOOK_URL, 'message.auto_reply', autoReplyPayload, settings.webhookSecret || GLOBAL_WEBHOOK_SECRET);
                    notifyFlaskInternal('message.auto_reply', autoReplyPayload);
                }).catch(err => {
                    console.error(`[${sessionId}] Auto-reply dispatch failed:`, err.message);
                });
            }
        }
    });

    // Track contacts & chats
    sock.ev.on('contacts.update', (updates) => {
        for (const contact of updates) {
            if (contact.id) sessionState.contacts.set(contact.id, { ...sessionState.contacts.get(contact.id), ...contact });
        }
    });

    sock.ev.on('chats.set', ({ chats }) => {
        for (const chat of chats) {
            if (chat.id) sessionState.chats.set(chat.id, chat);
        }
    });

    return sessionState;
}

/**
 * Enqueue outgoing message task with Anti-Ban protection.
 */
function enqueueMessage(sessionId, task) {
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    return new Promise((resolve, reject) => {
        session.queue.push({
            ...task,
            resolve,
            reject,
            createdAt: Date.now()
        });
        processQueue(sessionId);
    });
}

/**
 * Anti-Ban Queue Worker: Process messages sequentially with human simulation and jitter.
 */
async function processQueue(sessionId) {
    const session = sessions.get(sessionId);
    if (!session || session.isProcessingQueue || session.queue.length === 0) {
        return;
    }

    session.isProcessingQueue = true;

    while (session.queue.length > 0) {
        const item = session.queue.shift();

        // 1. Quota Check
        if (!session.safety.canSendMessage()) {
            const report = session.safety.getReport();
            const err = new Error(`Daily safe sending quota exceeded (${report.sentToday}/${report.dailyQuota}). Paused to protect WhatsApp account from ban.`);
            item.reject(err);
            continue;
        }

        // 2. Connection Check
        if (session.status !== 'connected' || !session.socket) {
            item.reject(new Error(`Session is not connected (current: ${session.status})`));
            continue;
        }

        try {
            const socket = session.socket;
            let targetJid = item.to;
            if (targetJid.includes('@lid') && session.lidMap && session.lidMap.has(targetJid)) {
                targetJid = session.lidMap.get(targetJid);
            }

            const isGroup = targetJid.includes('@g.us');
            const isLid = targetJid.includes('@lid');

            if (!isGroup && !isLid) {
                const cleanPhone = targetJid.split('@')[0].replace(/\D/g, '');
                targetJid = `${cleanPhone}@s.whatsapp.net`;
                // Validate number on WhatsApp if personal JID
                try {
                    const [res] = await socket.onWhatsApp(targetJid);
                    if (res?.exists) targetJid = res.jid;
                } catch (e) {
                    // fallback
                }
            }

            // Resolve Spintax if text/caption
            if (item.options?.text) item.options.text = resolveSpintax(item.options.text);
            if (item.options?.caption) item.options.caption = resolveSpintax(item.options.caption);

            // 3. Human Simulation: Presence Available
            await socket.sendPresenceUpdate('available');

            // 4. Human Simulation: Typing / Recording Presence
            const isVoice = item.type === 'voice' || (item.type === 'audio' && item.options?.ptt);
            const presenceAction = isVoice ? 'recording' : 'composing';
            await socket.sendPresenceUpdate(presenceAction, targetJid);

            // 5. Dynamic Human Typing Delay
            const typingText = item.options?.text || item.options?.caption || '';
            const typingDelay = calculateTypingDelay(typingText, session.settings?.mode);
            await new Promise(r => setTimeout(r, typingDelay));

            // 6. Pause Typing
            await socket.sendPresenceUpdate('paused', targetJid);

            // 7. Dispatch Message Payload
            let sent;
            if (item.type === 'buttons' || (item.options?.buttons && Array.isArray(item.options.buttons) && item.options.buttons.length > 0)) {
                const msg = await buildInteractiveButtonsMessage(socket, targetJid, item.options);
                const additionalNodes = getInteractiveAdditionalNodes();
                await socket.relayMessage(targetJid, msg.message, {
                    messageId: msg.key.id,
                    additionalNodes
                });
                sent = msg;

                // Register Quick Reply mappings for automatic response on click
                const rawButtons = item.options?.buttons || [];
                for (let idx = 0; idx < rawButtons.length; idx++) {
                    const btn = rawButtons[idx];
                    if (!btn) continue;
                    const bType = typeof btn === 'string' ? 'quick_reply' : (btn.type || '').toLowerCase();
                    const text = typeof btn === 'string' ? btn : (btn.text || btn.displayText || '');
                    let replyText = null;
                    let id = typeof btn === 'object' ? (btn.id || `btn_${idx}`) : `btn_${idx}`;

                    if (typeof btn === 'object') {
                        if (btn.reply === false || btn.reply_text === false) {
                            replyText = null;
                        } else {
                            replyText = btn.reply || btn.reply_text || btn.replyText || '';
                            if (!replyText && (bType === 'quick_reply' || !bType)) {
                                if (btn.value && !btn.value.startsWith('http') && !btn.value.startsWith('+')) {
                                    replyText = btn.value;
                                } else if (btn.id && btn.id !== text && (btn.id.includes(' ') || btn.id.length > 15)) {
                                    replyText = btn.id;
                                } else {
                                    replyText = `Thank you for choosing "${text}". Your response has been recorded.`;
                                }
                            }
                        }
                    } else if (typeof btn === 'string') {
                        replyText = `Thank you for choosing "${btn}". Your response has been recorded.`;
                    }

                    if (replyText) {
                        registerButtonReply(session.buttonReplies, BASE_AUTH_DIR, sessionId, {
                            messageId: sent?.key?.id,
                            targetJid,
                            buttonId: id,
                            buttonText: text,
                            replyText
                        });
                    }
                }
            } else {
                const payload = await buildMessagePayload(item.type, item.options);
                sent = await socket.sendMessage(targetJid, payload);
            }

            // Cache sent message in session store for signal decryption retry / linked devices sync
            if (sent?.key?.id && sent?.message) {
                if (!session.messageStore) session.messageStore = new Map();
                session.messageStore.set(sent.key.id, sent.message);
                if (session.messageStore.size > 5000) {
                    const firstKey = session.messageStore.keys().next().value;
                    session.messageStore.delete(firstKey);
                }
            }

            // Cache recipient destination for quote reply matching & LID translation
            if (sent?.key?.id && targetJid) {
                if (!session.messageRecipients) session.messageRecipients = new Map();
                session.messageRecipients.set(sent.key.id, targetJid);
                if (session.messageRecipients.size > 5000) {
                    const firstKey = session.messageRecipients.keys().next().value;
                    session.messageRecipients.delete(firstKey);
                }
            }

            // 8. Record Safety Stats
            session.safety.recordSent();

            item.resolve({
                success: true,
                messageId: sent?.key?.id,
                jid: targetJid,
                safetyReport: session.safety.getReport()
            });

            // 9. Anti-Ban Jitter Interval Delay before next message
            if (session.queue.length > 0) {
                const intervalDelay = calculateIntervalDelay(session.settings?.minDelayMs, session.settings?.maxDelayMs);
                console.log(`[${sessionId}] Anti-ban delay: waiting ${Math.round(intervalDelay / 1000)}s before next message...`);
                await new Promise(r => setTimeout(r, intervalDelay));
            }

            // 10. Schedule Going Offline (unavailable) after idle window
            clearTimeout(session.autoOfflineTimer);
            session.autoOfflineTimer = setTimeout(async () => {
                if (session.status === 'connected' && session.queue.length === 0) {
                    try {
                        await socket.sendPresenceUpdate('unavailable');
                    } catch (e) {}
                }
            }, Math.floor(Math.random() * 8000) + 6000);

        } catch (err) {
            console.error(`[${sessionId}] Send error:`, err.message);
            session.safety.recordFailed();
            item.reject(err);
        }
    }

    session.isProcessingQueue = false;
}

// Restore saved sessions on boot with staggered startup
if (fs.existsSync(BASE_AUTH_DIR)) {
    const sessionDirs = fs.readdirSync(BASE_AUTH_DIR).filter(f => {
        try {
            return fs.statSync(path.join(BASE_AUTH_DIR, f)).isDirectory();
        } catch {
            return false;
        }
    });

    console.log(`Found ${sessionDirs.length} saved sessions. Restoring...`);
    sessionDirs.forEach((dirName, index) => {
        setTimeout(() => {
            startSession(dirName).catch(err => console.error(`Restore error for ${dirName}:`, err.message));
        }, index * 2000); // 2s stagger to prevent socket flood
    });
}

// ==========================================
// REST API ENDPOINTS
// ==========================================

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        activeSessions: sessions.size,
        port: PORT,
        version: '2.0.0'
    });
});

// List all sessions
app.get('/sessions', (req, res) => {
    const list = [];
    for (const [id, s] of sessions.entries()) {
        list.push({
            sessionId: id,
            status: s.status,
            phone: s.socket?.user?.id ? s.socket.user.id.split(':')[0] : null,
            pushName: s.socket?.user?.name || null,
            queueLength: s.queue.length,
            safety: s.safety.getReport(),
            hasProxy: Boolean(s.settings?.proxyUrl)
        });
    }
    res.json({ success: true, count: list.length, sessions: list });
});

// Initialize session
app.post('/session/init', async (req, res) => {
    const { sessionId, proxyUrl, minDelayMs, maxDelayMs, customDailyQuota, webhookUrl, webhookSecret, mode } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

    try {
        const state = await startSession(sessionId, {
            proxyUrl,
            minDelayMs,
            maxDelayMs,
            customDailyQuota,
            webhookUrl,
            webhookSecret,
            mode
        });
        res.json({ success: true, sessionId, status: state.status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Request 8-digit Pairing Code (no QR scanner needed)
app.post('/session/pairing-code', async (req, res) => {
    const { sessionId, phoneNumber } = req.body;
    if (!sessionId || !phoneNumber) {
        return res.status(400).json({ error: 'sessionId and phoneNumber are required' });
    }

    try {
        const cleanPhone = phoneNumber.replace(/\D/g, '');
        if (cleanPhone.length < 9) {
            return res.status(400).json({ error: 'Invalid phone number length' });
        }

        let session = sessions.get(sessionId);
        if (!session) {
            session = await startSession(sessionId);
        }

        if (session.status === 'connected') {
            return res.status(400).json({ error: 'Session is already connected' });
        }

        // Wait for socket to be ready
        if (!session.socket) {
            await new Promise(r => setTimeout(r, 1500));
        }

        const code = await session.socket.requestPairingCode(cleanPhone);
        session.pairingCode = code;
        session.status = 'pairing';

        res.json({
            success: true,
            sessionId,
            phoneNumber: cleanPhone,
            pairingCode: code,
            instructions: 'Enter this 8-digit code in WhatsApp: Linked Devices -> Link with phone number instead'
        });
    } catch (err) {
        console.error(`Pairing code error for ${sessionId}:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

// Get session status & user details
app.get('/session/:id/status', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ status: 'not_found' });

    res.json({
        sessionId: req.params.id,
        status: session.status,
        user: session.socket?.user || null,
        pairingCode: session.pairingCode,
        queueLength: session.queue.length,
        safety: session.safety.getReport()
    });
});

// Get QR Code Image
app.get('/session/:id/qr', async (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ status: 'not_found', qrImage: null });

    if (!session.qr) {
        return res.json({ status: session.status, qrImage: null, pairingCode: session.pairingCode });
    }

    try {
        const qrImage = await QRCode.toDataURL(session.qr, {
            margin: 2,
            width: 320,
            color: { dark: '#0b141a', light: '#ffffff' }
        });
        res.json({ status: session.status, qrImage, qrRaw: session.qr });
    } catch (err) {
        res.status(500).json({ error: 'Failed to generate QR image' });
    }
});

// Get Anti-Ban Safety Report
app.get('/session/:id/safety', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(session.safety.getReport());
});

// Update Session Settings (Proxy, Anti-Ban delays, Quota, Webhook)
app.post('/session/:id/settings', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const updated = { ...session.settings, ...req.body };
    session.settings = updated;
    saveSessionSettings(req.params.id, updated);

    if (req.body.customDailyQuota) {
        session.safety.stats.customDailyQuota = Number(req.body.customDailyQuota);
    }
    if (req.body.mode) {
        session.safety.stats.mode = req.body.mode;
    }
    if (req.body.proxyUrl !== undefined) {
        session.safety.stats.hasProxy = Boolean(req.body.proxyUrl);
    }
    session.safety.saveStats();

    res.json({ success: true, settings: session.settings, safety: session.safety.getReport() });
});

// Universal Send Message Endpoint (Single recipient)
app.post('/session/:id/send', async (req, res) => {
    const sessionId = req.params.id;
    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const { to, type = 'text', message, ...options } = req.body;
    if (!to) return res.status(400).json({ error: 'Recipient "to" is required' });

    // Normalize text / message
    const msgOptions = { ...options };
    if (message && !msgOptions.text) msgOptions.text = message;

    try {
        const result = await enqueueMessage(sessionId, {
            type,
            to,
            options: msgOptions
        });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Bulk Messaging Endpoint (Enqueues multiple recipients safely)
app.post('/session/:id/send/bulk', async (req, res) => {
    const sessionId = req.params.id;
    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const { recipients, type = 'text', message, ...options } = req.body;
    if (!Array.isArray(recipients) || recipients.length === 0) {
        return res.status(400).json({ error: 'Recipients array is required' });
    }

    const enqueued = [];
    for (const item of recipients) {
        const to = typeof item === 'string' ? item : item.to;
        const customText = (typeof item === 'object' && item.text) ? item.text : message;
        const itemOptions = { ...options, text: customText };

        // Push to queue non-blocking
        enqueueMessage(sessionId, {
            type,
            to,
            options: itemOptions
        }).catch(() => {});

        enqueued.push({ to, status: 'enqueued' });
    }

    res.json({
        success: true,
        enqueuedCount: enqueued.length,
        currentQueueLength: session.queue.length,
        note: 'Messages enqueued with anti-ban human simulation and safe interval jitter delays.'
    });
});

// Queue management
app.get('/session/:id/queue', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json({
        sessionId: req.params.id,
        queueLength: session.queue.length,
        isProcessing: session.isProcessingQueue
    });
});

app.delete('/session/:id/queue', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const cleared = session.queue.length;
    session.queue.forEach(item => item.reject(new Error('Queue was cleared by user')));
    session.queue = [];
    res.json({ success: true, clearedMessages: cleared });
});

// Chats, Contacts, Groups
app.get('/session/:id/chats', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const chats = Array.from(session.chats.values());
    res.json({ success: true, count: chats.length, chats });
});

app.get('/session/:id/contacts', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const contacts = Array.from(session.contacts.values());
    res.json({ success: true, count: contacts.length, contacts });
});

app.get('/session/:id/groups', async (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session || session.status !== 'connected' || !session.socket) {
        return res.status(400).json({ error: 'Session not connected' });
    }
    try {
        const groups = await session.socket.groupFetchAllParticipating();
        res.json({ success: true, count: Object.keys(groups).length, groups });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Restart / Reconnect Session
app.post('/session/:id/restart', async (req, res) => {
    const sessionId = req.params.id;
    const session = sessions.get(sessionId);
    if (session?.socket) {
        try { session.socket.end(undefined); } catch {}
    }
    sessions.delete(sessionId);
    await startSession(sessionId);
    res.json({ success: true, message: `Session ${sessionId} restarting` });
});

// Delete session (Logout + wipe auth info)
app.delete('/session/:id', async (req, res) => {
    const sessionId = req.params.id;
    const session = sessions.get(sessionId);
    if (session) {
        if (session.socket) {
            try { session.socket.ev.removeAllListeners(); } catch {}
            try { await session.socket.logout(); } catch {}
            try { session.socket.end(undefined); } catch {}
        }
        sessions.delete(sessionId);
    }

    try {
        const authDir = path.join(BASE_AUTH_DIR, sessionId);
        if (fs.existsSync(authDir)) {
            fs.rmSync(authDir, { recursive: true, force: true });
        }
    } catch (e) {
        console.error(`Failed to delete dir for ${sessionId}:`, e.message);
    }

    res.json({ success: true, message: `Session ${sessionId} deleted successfully` });
});

// Webhook delivery logs
app.get('/webhooks/logs', (req, res) => {
    res.json({ success: true, logs: getRecentWebhookLogs() });
});

// Global Error Handler
app.use((err, req, res, next) => {
    console.error('Unhandled server error:', err);
    res.status(500).json({ error: 'Internal server error', message: err.message });
});

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`====================================================`);
    console.log(`🚀 TI WhatsApp Anti-Ban Bridge v2.0 running on port ${PORT}`);
    console.log(`📡 Base Auth Directory: ${BASE_AUTH_DIR}`);
    console.log(`🛡️  Anti-Ban Engine: Active (Queue + Jitter + Spintax + Quota)`);
    console.log(`====================================================`);
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`❌ PORT ${PORT} is already in use! Check your configuration or set BRIDGE_PORT.`);
    } else {
        console.error('Server listen error:', err);
    }
});

// Graceful shutdown
const shutdown = () => {
    console.log('Shutting down WhatsApp Bridge gracefully...');
    for (const [id, s] of sessions.entries()) {
        try { s.socket?.end(undefined); } catch {}
    }
    server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
