import axios from 'axios';
import crypto from 'crypto';

const recentWebhookLogs = [];
const MAX_LOGS = 100;

export function getRecentWebhookLogs() {
    return recentWebhookLogs;
}

export function logWebhookEvent(event) {
    recentWebhookLogs.unshift({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        ...event
    });
    if (recentWebhookLogs.length > MAX_LOGS) {
        recentWebhookLogs.pop();
    }
}

/**
 * Dispatches an event payload to a webhook URL.
 */
export async function dispatchWebhook(webhookUrl, eventType, data, secret = '') {
    if (!webhookUrl || typeof webhookUrl !== 'string' || !webhookUrl.startsWith('http')) {
        return;
    }

    const payload = {
        event: eventType,
        timestamp: new Date().toISOString(),
        data: data
    };

    const payloadString = JSON.stringify(payload);
    const headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'TI-Whatsapp-Gateway-Webhook/2.0'
    };

    if (secret) {
        const signature = crypto.createHmac('sha256', secret).update(payloadString).digest('hex');
        headers['X-Hub-Signature-256'] = `sha256=${signature}`;
    }

    try {
        const res = await axios.post(webhookUrl, payload, {
            headers,
            timeout: 8000,
            maxRedirects: 3
        });

        logWebhookEvent({
            event: eventType,
            url: webhookUrl,
            status: res.status,
            success: true
        });
    } catch (err) {
        logWebhookEvent({
            event: eventType,
            url: webhookUrl,
            status: err.response?.status || 0,
            error: err.message,
            success: false
        });
    }
}
