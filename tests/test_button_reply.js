import fs from 'fs';
import path from 'path';
import {
    loadButtonReplies,
    saveButtonReplies,
    registerButtonReply,
    findButtonReply,
    extractIncomingMessageData,
    getOriginalRecipientFromMessage
} from '../wa-bridge/lib/button-replies.js';

console.log('Testing Button Replies Engine...');

const testDir = './test_replies_auth';
if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });

const buttonReplies = {
    byMessage: new Map(),
    byChat: new Map(),
    global: new Map()
};

// 1. Register Button Replies
registerButtonReply(buttonReplies, testDir, 'test-session', {
    messageId: 'msg_test_1001',
    targetJid: '923001234567@s.whatsapp.net',
    buttonId: 'btn_0_yes',
    buttonText: 'Yes',
    replyText: 'Ok Order confirmed'
});

registerButtonReply(buttonReplies, testDir, 'test-session', {
    messageId: 'msg_test_1001',
    targetJid: '923001234567@s.whatsapp.net',
    buttonId: 'btn_1_no',
    buttonText: 'No',
    replyText: 'Order cancelled'
});

// 2. Test Quoted Message / WhatsApp Web Quote Match
const match1 = findButtonReply(buttonReplies, 'msg_test_1001', '923001234567@s.whatsapp.net', ['Yes']);
console.log('Match 1 (Quote "Yes"):', match1);
if (match1 !== 'Ok Order confirmed') throw new Error(`Expected "Ok Order confirmed", got "${match1}"`);

const match2 = findButtonReply(buttonReplies, 'msg_test_1001', '923001234567@s.whatsapp.net', ['No']);
console.log('Match 2 (Quote "No"):', match2);
if (match2 !== 'Order cancelled') throw new Error(`Expected "Order cancelled", got "${match2}"`);

// 3. Test Button ID / Mobile Native Flow Match
const match3 = findButtonReply(buttonReplies, null, '923001234567@s.whatsapp.net', ['btn_0_yes']);
console.log('Match 3 (Button ID "btn_0_yes"):', match3);
if (match3 !== 'Ok Order confirmed') throw new Error(`Expected "Ok Order confirmed", got "${match3}"`);

// 4. Test Chat / Phone Match (without stanzaId)
const match4 = findButtonReply(buttonReplies, null, '923001234567', ['yes']);
console.log('Match 4 (Phone + Text "yes"):', match4);
if (match4 !== 'Ok Order confirmed') throw new Error(`Expected "Ok Order confirmed", got "${match4}"`);

// 5. Test Global Fallback
const match5 = findButtonReply(buttonReplies, null, 'different_chat@s.whatsapp.net', ['yes']);
console.log('Match 5 (Global "yes"):', match5);
if (match5 !== 'Ok Order confirmed') throw new Error(`Expected "Ok Order confirmed", got "${match5}"`);

// 6. Test Unmatched Query
const match6 = findButtonReply(buttonReplies, null, '923001234567', ['unknown_btn']);
console.log('Match 6 (Unmatched):', match6);
if (match6 !== null) throw new Error(`Expected null, got "${match6}"`);

// 7. Test Message Data Extraction
const testMsg1 = {
    message: {
        interactiveResponseMessage: {
            body: { text: 'Yes' },
            nativeFlowResponseMessage: {
                paramsJson: JSON.stringify({ id: 'btn_0_yes', display_text: 'Yes' })
            },
            contextInfo: { stanzaId: 'msg_test_1001' }
        }
    }
};
const extracted1 = extractIncomingMessageData(testMsg1);
console.log('Extracted Native Flow:', extracted1);
if (extracted1.body !== 'Yes' || extracted1.buttonId !== 'btn_0_yes' || extracted1.quotedMessageId !== 'msg_test_1001') {
    throw new Error('Failed to extract native flow response message');
}

const testMsg2 = {
    message: {
        extendedTextMessage: {
            text: 'Yes',
            contextInfo: {
                stanzaId: 'msg_test_1001',
                quotedMessage: { interactiveMessage: {} }
            }
        }
    }
};
const extracted2 = extractIncomingMessageData(testMsg2);
console.log('Extracted Quoted Reply:', extracted2);
if (extracted2.body !== 'Yes' || extracted2.quotedMessageId !== 'msg_test_1001' || extracted2.messageType !== 'button_reply') {
    throw new Error('Failed to extract quoted button reply');
}

// 8. Test Disk Persistence & Reload
const reloaded = loadButtonReplies(testDir, 'test-session');
const reloadedMatch = findButtonReply(reloaded, 'msg_test_1001', '923001234567@s.whatsapp.net', ['Yes']);
console.log('Reloaded Match from disk:', reloadedMatch);
if (reloadedMatch !== 'Ok Order confirmed') throw new Error('Failed to load button replies from disk');

// 9. Test Original Recipient Resolution (for Privacy LID @lid matching)
const origRecipient = getOriginalRecipientFromMessage(buttonReplies, 'msg_test_1001');
console.log('Original Recipient:', origRecipient);
if (origRecipient !== '923001234567@s.whatsapp.net') {
    throw new Error(`Expected "923001234567@s.whatsapp.net", got "${origRecipient}"`);
}

// Clean up
fs.rmSync(testDir, { recursive: true, force: true });
console.log('✅ ALL BUTTON REPLIES TESTS PASSED SUCCESSFULLY!');
