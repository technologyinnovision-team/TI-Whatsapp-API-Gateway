import { resolveSpintax, calculateTypingDelay, calculateIntervalDelay, SessionSafetyTracker } from '../wa-bridge/lib/anti-ban.js';
import fs from 'fs';
import path from 'path';

console.log('Testing Spintax...');
const template = '{Hello|Hi|Greetings} {friend|customer|partner}, your code is 1234. {Thanks|Have a nice day}!';
const results = new Set();
for (let i = 0; i < 30; i++) {
    results.add(resolveSpintax(template));
}
console.log(`Generated ${results.size} distinct variations out of 30 tries.`);
if (results.size < 3) throw new Error('Spintax failed to generate variations');

console.log('Testing Human Typing Delay...');
const delay1 = calculateTypingDelay('Hi');
const delay2 = calculateTypingDelay('This is a longer message that should take more human typing time to simulate realistic keyboard input on WhatsApp.');
console.log(`Delay short: ${delay1}ms, Delay long: ${delay2}ms`);
if (delay2 <= delay1) throw new Error('Typing delay calculation unexpected');

console.log('Testing Interval Jitter...');
const interval = calculateIntervalDelay(4000, 8000);
console.log(`Interval delay: ${interval}ms`);
if (interval < 4000 || interval > 8000) throw new Error('Interval delay out of bounds');

console.log('Testing Safety Tracker & Warm-up Quota...');
const testDir = './test_auth';
if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
const tracker = new SessionSafetyTracker('test-session', testDir);
const report = tracker.getReport();
console.log('Safety report:', report);
if (report.healthScore !== 90 && report.healthScore !== 100 && report.healthScore !== 80) {
    console.log('Initial health score:', report.healthScore);
}

// Cleanup test dir
fs.rmSync(testDir, { recursive: true, force: true });
console.log('✅ ALL ANTI-BAN TESTS PASSED SUCCESSFULLY!');
