import axios from 'axios';
import mime from 'mime-types';
import fs from 'fs';
import sharp from 'sharp';
import { proto, generateWAMessageFromContent, prepareWAMessageMedia } from '@whiskeysockets/baileys';

/**
 * Resolves media input (URL, base64 data string, or local path) into a Buffer and metadata.
 */
export async function resolveMediaBuffer(mediaInput, defaultMime = 'application/octet-stream') {
    if (!mediaInput) throw new Error('Media input is empty');

    // 1. Base64 data URI format (e.g. data:image/png;base64,iVBORw0KGgo...)
    if (typeof mediaInput === 'string' && mediaInput.startsWith('data:')) {
        const matches = mediaInput.match(/^data:([^;]+);base64,(.+)$/);
        if (matches) {
            const detectedMime = matches[1];
            const buffer = Buffer.from(matches[2], 'base64');
            return { buffer, mimetype: detectedMime };
        }
    }

    // 2. Pure base64 string
    if (typeof mediaInput === 'string' && /^[A-Za-z0-9+/=]{100,}$/.test(mediaInput.trim().replace(/[\r\n]/g, ''))) {
        const buffer = Buffer.from(mediaInput.trim(), 'base64');
        return { buffer, mimetype: defaultMime };
    }

    // 3. HTTP / HTTPS URL
    if (typeof mediaInput === 'string' && (mediaInput.startsWith('http://') || mediaInput.startsWith('https://'))) {
        const response = await axios.get(mediaInput, {
            responseType: 'arraybuffer',
            timeout: 25000,
            maxContentLength: 75 * 1024 * 1024 // max 75MB
        });
        const headerMime = response.headers['content-type']?.split(';')[0];
        const buffer = Buffer.from(response.data);
        return { buffer, mimetype: headerMime || defaultMime };
    }

    // 4. Local file path
    if (typeof mediaInput === 'string' && fs.existsSync(mediaInput)) {
        const buffer = fs.readFileSync(mediaInput);
        const detectedMime = mime.lookup(mediaInput) || defaultMime;
        return { buffer, mimetype: detectedMime };
    }

    // 5. Raw Buffer passed directly
    if (Buffer.isBuffer(mediaInput)) {
        return { buffer: mediaInput, mimetype: defaultMime };
    }

    throw new Error('Unsupported media format or invalid URL/file');
}

/**
 * Builds Baileys compatible message payload for different message types.
 */
export async function buildMessagePayload(type, options) {
    switch (type) {
        case 'text': {
            const payload = { text: options.text || '' };
            if (options.mentions && Array.isArray(options.mentions)) {
                payload.mentions = options.mentions;
            }
            return payload;
        }

        case 'image': {
            const { buffer, mimetype } = await resolveMediaBuffer(options.media || options.url, 'image/jpeg');
            return {
                image: buffer,
                mimetype: mimetype || 'image/jpeg',
                caption: options.caption || ''
            };
        }

        case 'video': {
            const { buffer, mimetype } = await resolveMediaBuffer(options.media || options.url, 'video/mp4');
            return {
                video: buffer,
                mimetype: mimetype || 'video/mp4',
                caption: options.caption || '',
                gifPlayback: Boolean(options.gifPlayback)
            };
        }

        case 'audio':
        case 'voice': {
            const isPtt = type === 'voice' || Boolean(options.ptt);
            const { buffer, mimetype } = await resolveMediaBuffer(options.media || options.url, isPtt ? 'audio/ogg; codecs=opus' : 'audio/mp4');
            return {
                audio: buffer,
                mimetype: isPtt ? 'audio/ogg; codecs=opus' : (mimetype || 'audio/mp4'),
                ptt: isPtt
            };
        }

        case 'document': {
            const fileName = options.fileName || options.filename || 'file.pdf';
            const detectedMime = mime.lookup(fileName) || 'application/octet-stream';
            const { buffer, mimetype } = await resolveMediaBuffer(options.media || options.url, detectedMime);
            return {
                document: buffer,
                mimetype: options.mimetype || mimetype || detectedMime,
                fileName: fileName,
                caption: options.caption || ''
            };
        }

        case 'poll': {
            if (!options.name || !Array.isArray(options.values) || options.values.length < 2) {
                throw new Error('Poll requires question name and at least 2 option values');
            }
            return {
                poll: {
                    name: options.name,
                    values: options.values.slice(0, 12), // WA allows max 12 options
                    selectableCount: options.selectableCount || 1
                }
            };
        }

        case 'location': {
            if (options.latitude === undefined || options.longitude === undefined) {
                throw new Error('Location requires latitude and longitude');
            }
            return {
                location: {
                    degreesLatitude: Number(options.latitude),
                    degreesLongitude: Number(options.longitude),
                    name: options.name || '',
                    address: options.address || ''
                }
            };
        }

        case 'contact': {
            const displayName = options.displayName || options.name || 'Contact';
            const phone = (options.phone || '').replace(/\D/g, '');
            const vcard = options.vcard || [
                'BEGIN:VCARD',
                'VERSION:3.0',
                `FN:${displayName}`,
                `TEL;type=CELL;type=VOICE;waid=${phone}:+${phone}`,
                'END:VCARD'
            ].join('\n');

            return {
                contacts: {
                    displayName: displayName,
                    contacts: [{ vcard }]
                }
            };
        }

        case 'reaction': {
            if (!options.key || !options.reaction) {
                throw new Error('Reaction requires target message key and reaction emoji');
            }
            return {
                react: {
                    text: options.reaction,
                    key: options.key
                }
            };
        }

        default:
            throw new Error(`Unsupported message type: ${type}`);
    }
}

/**
 * Builds a WhatsApp Native Flow Interactive Message with Click-To-Action (CTA) Buttons.
 * Supports:
 * - cta_url: Website links (e.g. "Visit Website", "View Product")
 * - cta_call: Direct phone call buttons
 * - cta_copy: One-tap copy coupon/promo codes
 * - quick_reply: Interactive quick replies
 */
export function getInteractiveAdditionalNodes() {
    return [
        {
            tag: 'biz',
            attrs: {},
            content: [
                {
                    tag: 'interactive',
                    attrs: {
                        type: 'native_flow',
                        v: '1'
                    },
                    content: [
                        {
                            tag: 'native_flow',
                            attrs: {
                                name: 'mixed',
                                v: '9'
                            }
                        }
                    ]
                }
            ]
        }
    ];
}

export async function buildInteractiveButtonsMessage(socket, targetJid, options = {}) {
    const rawButtons = options.buttons || [];
    const formattedButtons = rawButtons.map((btn, idx) => {
        if (typeof btn === 'string') {
            return {
                name: 'quick_reply',
                buttonParamsJson: JSON.stringify({ display_text: btn, id: 'btn_' + idx })
            };
        }
        const bType = (btn.type || '').toLowerCase();
        // 1. URL / Website Link Button
        if (bType === 'url' || bType === 'cta_url' || btn.url) {
            return {
                name: 'cta_url',
                buttonParamsJson: JSON.stringify({
                    display_text: btn.text || btn.displayText || 'Visit Website',
                    url: btn.url,
                    merchant_url: btn.url
                })
            };
        }
        // 2. Call Phone Number Button
        if (bType === 'call' || bType === 'cta_call' || btn.phone || btn.phoneNumber) {
            return {
                name: 'cta_call',
                buttonParamsJson: JSON.stringify({
                    display_text: btn.text || btn.displayText || 'Call Us',
                    phone_number: btn.phone || btn.phoneNumber
                })
            };
        }
        // 3. Copy Code Button
        if (bType === 'copy' || bType === 'cta_copy' || btn.code || btn.copy_code) {
            return {
                name: 'cta_copy',
                buttonParamsJson: JSON.stringify({
                    display_text: btn.text || btn.displayText || 'Copy Code',
                    id: btn.id || 'copy_' + idx,
                    copy_code: btn.code || btn.copy_code
                })
            };
        }
        // 4. Quick Reply Button
        return {
            name: 'quick_reply',
            buttonParamsJson: JSON.stringify({
                display_text: btn.text || btn.displayText || 'Option',
                id: btn.id || 'btn_' + idx
            })
        };
    });

    let header = undefined;
    if (options.media || options.image) {
        try {
            const { buffer } = await resolveMediaBuffer(options.media || options.image, 'image/jpeg');
            // Ensure image is standard JPEG for WhatsApp protocol
            let jpegBuffer = buffer;
            try {
                jpegBuffer = await sharp(buffer).jpeg({ quality: 90 }).toBuffer();
            } catch (err) {
                console.warn('Sharp JPEG conversion fallback:', err.message);
            }

            const media = await prepareWAMessageMedia({ image: jpegBuffer }, { upload: socket.waUploadToServer });
            header = proto.Message.InteractiveMessage.Header.create({
                title: options.title || '',
                hasMediaAttachment: true,
                imageMessage: media.imageMessage
            });
        } catch (e) {
            console.error('Failed to attach media to button header:', e.message);
            if (options.title) {
                header = proto.Message.InteractiveMessage.Header.create({
                    title: options.title,
                    hasMediaAttachment: false
                });
            }
        }
    } else if (options.title) {
        header = proto.Message.InteractiveMessage.Header.create({
            title: options.title,
            hasMediaAttachment: false
        });
    }

    const interactiveMessageObj = {
        body: proto.Message.InteractiveMessage.Body.create({ text: options.text || options.message || '' }),
        nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
            buttons: formattedButtons
        })
    };

    if (header) {
        interactiveMessageObj.header = header;
    }
    if (options.footer) {
        interactiveMessageObj.footer = proto.Message.InteractiveMessage.Footer.create({ text: options.footer });
    }

    const messageContent = {
        messageContextInfo: {
            deviceListMetadata: {},
            deviceListMetadataVersion: 2
        },
        interactiveMessage: proto.Message.InteractiveMessage.create(interactiveMessageObj)
    };

    return generateWAMessageFromContent(targetJid, messageContent, {
        userJid: socket.user?.id
    });
}

