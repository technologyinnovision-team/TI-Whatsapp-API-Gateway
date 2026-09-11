import fs from 'fs';
import path from 'path';

/**
 * Loads stored button reply mappings for a session from disk.
 */
export function loadButtonReplies(baseDir, sessionId) {
    const file = path.join(baseDir, sessionId, 'button_replies.json');
    try {
        if (fs.existsSync(file)) {
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            return {
                byMessage: new Map(Object.entries(data.byMessage || {})),
                byChat: new Map(Object.entries(data.byChat || {})),
                global: new Map(Object.entries(data.global || {}))
            };
        }
    } catch (e) {
        console.error(`[${sessionId}] Failed to load button_replies.json:`, e.message);
    }
    return {
        byMessage: new Map(),
        byChat: new Map(),
        global: new Map()
    };
}

/**
 * Persists button reply mappings for a session to disk.
 */
export function saveButtonReplies(baseDir, sessionId, buttonReplies) {
    if (!buttonReplies) return;
    const dir = path.join(baseDir, sessionId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'button_replies.json');
    try {
        const data = {
            byMessage: Object.fromEntries(buttonReplies.byMessage || []),
            byChat: Object.fromEntries(buttonReplies.byChat || []),
            global: Object.fromEntries(buttonReplies.global || [])
        };
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error(`[${sessionId}] Failed to save button_replies.json:`, e.message);
    }
}

/**
 * Registers quick reply button triggers and their automated responses.
 */
export function registerButtonReply(buttonReplies, baseDir, sessionId, { messageId, targetJid, buttonId, buttonText, replyText }) {
    if (!buttonReplies) return;
    const cleanReply = String(replyText || '').trim();
    if (!cleanReply) return;

    const keys = new Set();
    if (buttonText) {
        keys.add(String(buttonText).trim().toLowerCase());
    }
    if (buttonId) {
        const rawId = String(buttonId).trim().toLowerCase();
        keys.add(rawId);
        // Also strip common prefixes like 'btn_0_', 'qr_0_', etc.
        const strippedId = rawId.replace(/^(btn_\d+_?|qr_\d+_?)/, '').trim();
        if (strippedId) keys.add(strippedId);
    }

    // 1. By messageId (for quote replies / stanzaId)
    if (messageId) {
        let msgMap = buttonReplies.byMessage.get(messageId);
        if (!msgMap) {
            msgMap = {};
            if (buttonReplies.byMessage.size > 1000) {
                const oldest = buttonReplies.byMessage.keys().next().value;
                buttonReplies.byMessage.delete(oldest);
            }
        }
        if (targetJid) {
            msgMap._targetJid = String(targetJid).trim();
        }
        for (const k of keys) {
            msgMap[k] = cleanReply;
        }
        buttonReplies.byMessage.set(messageId, msgMap);
    }

    // 2. By recipient chat (JID and phone number)
    if (targetJid) {
        const cleanJid = String(targetJid).trim().toLowerCase();
        const phone = cleanJid.replace('@s.whatsapp.net', '').replace('@g.us', '');
        for (const cKey of [cleanJid, phone]) {
            let cMap = buttonReplies.byChat.get(cKey);
            if (!cMap) {
                cMap = {};
                if (buttonReplies.byChat.size > 2000) {
                    const oldest = buttonReplies.byChat.keys().next().value;
                    buttonReplies.byChat.delete(oldest);
                }
            }
            for (const k of keys) {
                cMap[k] = cleanReply;
            }
            buttonReplies.byChat.set(cKey, cMap);
        }
    }

    // 3. Global session level
    for (const k of keys) {
        buttonReplies.global.set(k, cleanReply);
    }

    if (baseDir && sessionId) {
        saveButtonReplies(baseDir, sessionId, buttonReplies);
    }
}

/**
 * Finds an automated button reply matching the incoming message / button response.
 */
export function findButtonReply(buttonReplies, quotedMessageId, sender, candidateKeys = []) {
    if (!buttonReplies) return null;

    const normalizedKeys = candidateKeys
        .filter(Boolean)
        .map(k => String(k).trim().toLowerCase());

    // 1. Check message-specific (quoted message stanzaId)
    if (quotedMessageId && buttonReplies.byMessage) {
        const msgMap = buttonReplies.byMessage.get(quotedMessageId);
        if (msgMap) {
            for (const k of normalizedKeys) {
                if (msgMap[k]) return msgMap[k];
            }
        }
    }

    // 2. Check chat-specific (recipient JID / phone)
    if (sender && buttonReplies.byChat) {
        const cleanJid = String(sender).trim().toLowerCase();
        const phone = cleanJid.replace('@s.whatsapp.net', '').replace('@g.us', '');
        for (const cKey of [cleanJid, phone]) {
            const chatMap = buttonReplies.byChat.get(cKey);
            if (chatMap) {
                for (const k of normalizedKeys) {
                    if (chatMap[k]) return chatMap[k];
                }
            }
        }
    }

    // 3. Check global session map
    if (buttonReplies.global) {
        for (const k of normalizedKeys) {
            if (buttonReplies.global.has(k)) {
                return buttonReplies.global.get(k);
            }
        }
    }

    return null;
}

/**
 * Retrieves the original recipient JID of a button message from byMessage map.
 */
export function getOriginalRecipientFromMessage(buttonReplies, messageId) {
    if (!buttonReplies || !messageId || !buttonReplies.byMessage) return null;
    const msgMap = buttonReplies.byMessage.get(messageId);
    return msgMap?._targetJid || null;
}

/**
 * Extracts comprehensive message content, button IDs, and interactive replies
 * from Baileys message objects.
 */
export function extractIncomingMessageData(msg) {
    let body = '';
    let messageType = 'text';
    let buttonId = null;
    let buttonText = null;

    const m = msg.message;
    if (!m) return { body, messageType, buttonId, buttonText, quotedMessageId: null };

    const quotedMessageId = m.extendedTextMessage?.contextInfo?.stanzaId ||
                           m.interactiveResponseMessage?.contextInfo?.stanzaId ||
                           m.templateButtonReplyMessage?.contextInfo?.stanzaId ||
                           m.buttonsResponseMessage?.contextInfo?.stanzaId ||
                           m.listResponseMessage?.contextInfo?.stanzaId ||
                           null;

    if (m.interactiveResponseMessage) {
        messageType = 'interactive_response';
        const interactive = m.interactiveResponseMessage;
        buttonText = interactive.body?.text || '';
        if (interactive.nativeFlowResponseMessage?.paramsJson) {
            try {
                const params = JSON.parse(interactive.nativeFlowResponseMessage.paramsJson);
                buttonId = params.id || null;
                if (params.display_text) buttonText = params.display_text;
                else if (params.text) buttonText = params.text;
            } catch (e) {
                buttonId = interactive.nativeFlowResponseMessage.paramsJson;
            }
        }
        body = buttonText || buttonId || '';
    } else if (m.templateButtonReplyMessage) {
        messageType = 'button_reply';
        buttonId = m.templateButtonReplyMessage.selectedId;
        buttonText = m.templateButtonReplyMessage.selectedDisplayText;
        body = buttonText || buttonId || '';
    } else if (m.buttonsResponseMessage) {
        messageType = 'button_reply';
        buttonId = m.buttonsResponseMessage.selectedButtonId;
        buttonText = m.buttonsResponseMessage.selectedDisplayText;
        body = buttonText || buttonId || '';
    } else if (m.listResponseMessage) {
        messageType = 'list_reply';
        buttonId = m.listResponseMessage.singleSelectReply?.selectedRowId;
        buttonText = m.listResponseMessage.title;
        body = buttonText || buttonId || '';
    } else if (m.extendedTextMessage?.text) {
        body = m.extendedTextMessage.text;
        // Check if extendedTextMessage is quoting an interactive buttons message
        if (m.extendedTextMessage.contextInfo?.quotedMessage?.interactiveMessage) {
            messageType = 'button_reply';
            buttonText = body;
        }
    } else if (m.conversation) {
        body = m.conversation;
    } else if (m.imageMessage?.caption) {
        body = m.imageMessage.caption;
        messageType = 'image';
    } else if (m.videoMessage?.caption) {
        body = m.videoMessage.caption;
        messageType = 'video';
    } else if (m.audioMessage) {
        messageType = 'audio';
    } else if (m.documentMessage) {
        body = m.documentMessage.fileName || '';
        messageType = 'document';
    }

    return {
        body,
        messageType,
        buttonId,
        buttonText,
        quotedMessageId
    };
}
