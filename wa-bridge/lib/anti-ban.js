import fs from 'fs';
import path from 'path';

/**
 * Resolves spintax strings like: {Hi|Hello|Hey} {friend|there}, {how are you|hope you're well}!
 * Supports nested spintax.
 */
export function resolveSpintax(text) {
    if (!text || typeof text !== 'string') return text;
    const regex = /\{([^{}]+)\}/;
    while (regex.test(text)) {
        text = text.replace(regex, (_, choices) => {
            const options = choices.split('|');
            return options[Math.floor(Math.random() * options.length)];
        });
    }
    return text;
}

/**
 * Calculates dynamic human typing delay based on message length and human variance.
 * Real humans type ~40-60 words per minute (approx 30-50ms per character).
 */
export function calculateTypingDelay(text, mode = 'standard') {
    const len = (text && typeof text === 'string') ? text.length : 25;
    let minDelay = 1200;
    let maxDelay = 6000;
    let charTime = 35;

    if (mode === 'safe') {
        minDelay = 2000;
        maxDelay = 9000;
        charTime = 55;
    } else if (mode === 'fast') {
        minDelay = 800;
        maxDelay = 3500;
        charTime = 20;
    }

    const calculated = Math.min(Math.max(len * charTime, minDelay), maxDelay);
    const jitter = Math.floor(Math.random() * 800);
    return calculated + jitter;
}

/**
 * Calculates safe delay interval between consecutive messages.
 */
export function calculateIntervalDelay(minMs = 4000, maxMs = 9000) {
    const min = Math.max(Number(minMs) || 4000, 2000);
    const max = Math.max(Number(maxMs) || 9000, min + 1000);
    return Math.floor(Math.random() * (max - min)) + min;
}

/**
 * Warm-up schedule and daily quota tracker.
 * New numbers get flagged quickly if they blast hundreds of messages on day 1.
 */
export class SessionSafetyTracker {
    constructor(sessionId, baseDir) {
        this.sessionId = sessionId;
        this.statsFile = path.join(baseDir, sessionId, 'safety_stats.json');
        this.stats = this.loadStats();
    }

    loadStats() {
        try {
            if (fs.existsSync(this.statsFile)) {
                return JSON.parse(fs.readFileSync(this.statsFile, 'utf8'));
            }
        } catch (e) {
            // fallback
        }
        return {
            createdAt: new Date().toISOString(),
            lastActiveDate: new Date().toISOString().split('T')[0],
            sentToday: 0,
            totalSent: 0,
            totalFailed: 0,
            warmupDay: 1,
            customDailyQuota: 300,
            hasProxy: false,
            mode: 'standard' // 'safe', 'standard', 'fast'
        };
    }

    saveStats() {
        try {
            const dir = path.dirname(this.statsFile);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(this.statsFile, JSON.stringify(this.stats, null, 2));
        } catch (e) {
            console.error(`[${this.sessionId}] Error saving safety stats:`, e);
        }
    }

    checkAndResetDay() {
        const today = new Date().toISOString().split('T')[0];
        if (this.stats.lastActiveDate !== today) {
            this.stats.lastActiveDate = today;
            this.stats.sentToday = 0;
            this.stats.warmupDay = (this.stats.warmupDay || 1) + 1;
            this.saveStats();
        }
    }

    getMaxDailyQuota() {
        this.checkAndResetDay();
        const warmupLimits = {
            1: 35,
            2: 70,
            3: 140,
            4: 250
        };
        const day = this.stats.warmupDay || 1;
        if (day in warmupLimits) {
            return Math.min(warmupLimits[day], this.stats.customDailyQuota || 300);
        }
        return this.stats.customDailyQuota || 300;
    }

    canSendMessage() {
        this.checkAndResetDay();
        const max = this.getMaxDailyQuota();
        return this.stats.sentToday < max;
    }

    recordSent() {
        this.checkAndResetDay();
        this.stats.sentToday++;
        this.stats.totalSent++;
        this.saveStats();
    }

    recordFailed() {
        this.checkAndResetDay();
        this.stats.totalFailed++;
        this.saveStats();
    }

    calculateHealthScore() {
        this.checkAndResetDay();
        let score = 100;
        const total = this.stats.totalSent + this.stats.totalFailed;
        
        // Failure rate penalty
        if (total > 5) {
            const failRate = this.stats.totalFailed / total;
            if (failRate > 0.3) score -= 35;
            else if (failRate > 0.15) score -= 20;
            else if (failRate > 0.05) score -= 10;
        }

        // Quota threshold check
        const max = this.getMaxDailyQuota();
        const usageRatio = this.stats.sentToday / max;
        if (usageRatio > 0.9) score -= 25;
        else if (usageRatio > 0.75) score -= 15;

        // Warmup penalty
        if ((this.stats.warmupDay || 1) < 3) {
            score -= 10;
        }

        // Proxy bonus
        if (!this.stats.hasProxy) {
            score -= 10;
        }

        return Math.max(Math.min(score, 100), 10);
    }

    getReport() {
        this.checkAndResetDay();
        const maxQuota = this.getMaxDailyQuota();
        const score = this.calculateHealthScore();
        return {
            sentToday: this.stats.sentToday,
            dailyQuota: maxQuota,
            totalSent: this.stats.totalSent,
            totalFailed: this.stats.totalFailed,
            warmupDay: this.stats.warmupDay,
            healthScore: score,
            isWarmingUp: (this.stats.warmupDay || 1) <= 4,
            safetyLevel: score >= 80 ? 'EXCELLENT' : score >= 60 ? 'GOOD' : score >= 40 ? 'WARNING' : 'CRITICAL',
            mode: this.stats.mode || 'standard',
            hasProxy: Boolean(this.stats.hasProxy)
        };
    }
}
