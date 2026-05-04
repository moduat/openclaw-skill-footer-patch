'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.startTokenAggregatorDaemon = startTokenAggregatorDaemon;
exports.stopTokenAggregatorDaemon = stopTokenAggregatorDaemon;
exports.isDaemonAlive = isDaemonAlive;
const { existsSync, readFileSync, writeFileSync, readdirSync } = require('node:fs');
const { join, basename } = require('node:path');
const { homedir } = require('node:os');
const SCAN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const SHANGHAI_OFFSET_MS = 8 * 3600 * 1000;
let _timer = null;
let daemonLastFlushMs = 0;
let _tokenStatsPath = null;
let _cronRunsDir = null;
let currentDateKey = '';
let currentMonthKey = '';
let daemonToday = 0;
let daemonMonth = 0;
/** @type {Map<string, {lastLineIndex: number, lastTotalTokens: number}>} */
let fileState = new Map();
// Must use UTC methods (getUTCFullYear etc), locale independent.
// Do NOT use toLocaleDateString() — different locales use different separators.
function getShanghaiDateKey() {
    const d = new Date(Date.now() + SHANGHAI_OFFSET_MS);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function getShanghaiMonthKey() {
    return getShanghaiDateKey().substring(0, 7);
}
function getShanghaiTimeWindow() {
    const nowUtc = Date.now();
    const shanghaiNow = new Date(nowUtc + SHANGHAI_OFFSET_MS);
    const todayShanghai = new Date(shanghaiNow);
    todayShanghai.setUTCHours(0, 0, 0, 0);
    const todayStartMs = todayShanghai.getTime() - SHANGHAI_OFFSET_MS;
    const monthStartMs = Date.UTC(shanghaiNow.getUTCFullYear(), shanghaiNow.getUTCMonth(), 1) - SHANGHAI_OFFSET_MS;
    return { todayStartMs, monthStartMs };
}
function parseTimestamp(value) {
    if (typeof value === 'number' && value > 0) {
        // Milliseconds or seconds
        if (value > 1e12) return value;
        if (value > 1e9) return value * 1000;
    }
    if (typeof value === 'string') {
        const parsed = Date.parse(value);
        if (!isNaN(parsed)) return parsed;
        const num = Number(value);
        if (!isNaN(num) && num > 0) {
            if (num > 1e12) return num;
            if (num > 1e9) return num * 1000;
        }
    }
    return null;
}
function extractTokens(entry) {
    if (!entry || typeof entry !== 'object') return null;
    // Handle both agent session transcript and cron run formats
    const usage = entry?.message?.usage ?? entry?.usage;
    if (!usage || typeof usage !== 'object') return null;
    const input = typeof usage.input === 'number' ? usage.input
        : typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
    const output = typeof usage.output === 'number' ? usage.output
        : typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
    if (input > 0 || output > 0) return { input, output };
    return null;
}
function scanJsonlFile(filePath, fileKey, isRecount, startOfDayMs, startOfMonthMs) {
    let state = fileState.get(fileKey);
    if (!state) {
        state = { lastLineIndex: 0, lastTotalTokens: 0 };
        fileState.set(fileKey, state);
    }
    if (isRecount) {
        state.lastTotalTokens = 0;
        state.lastLineIndex = 0;
    }
    let content;
    try { content = readFileSync(filePath, 'utf8'); } catch { return 0; }
    const lines = content.split('\n');
    let delta = 0;
    for (let i = state.lastLineIndex; i < lines.length; i++) {
        state.lastLineIndex = i + 1; // Always advance, even for skipped lines
        const trimmed = lines[i].trim();
        if (!trimmed) continue;
        let entry;
        try { entry = JSON.parse(trimmed); } catch { continue; }
        const tokens = extractTokens(entry);
        if (!tokens) continue;
        const ts = parseTimestamp(entry?.timestamp ?? entry?.ts);
        // Time window gating for recount (today/month)
        if (isRecount && ts != null) {
            if (startOfDayMs != null && ts < startOfDayMs) continue;
        }
        const total = tokens.input + tokens.output;
        delta += total;
    }
    state.lastTotalTokens += delta;
    return delta;
}
function scanCronRuns() {
    if (!_cronRunsDir || !existsSync(_cronRunsDir)) return;
    const key = getShanghaiDateKey();
    const monthKey = getShanghaiMonthKey();
    const dateChanged = !currentDateKey || currentDateKey !== key;
    const monthChanged = currentMonthKey && currentMonthKey !== monthKey;
    let isRecount = dateChanged || monthChanged;
    if (isRecount) {
        if (dateChanged) daemonToday = 0;
        if (monthChanged) daemonMonth = 0;
        currentDateKey = key;
        currentMonthKey = monthKey;
    }
    // Compute time window boundaries for recount (UTC+offset, not locale)
    let startOfDayMs = null;
    let startOfMonthMs = null;
    if (isRecount) {
        const tw = getShanghaiTimeWindow();
        startOfDayMs = tw.todayStartMs;
        startOfMonthMs = tw.monthStartMs;
    }
    // v2026.04.30 fix: new files must always use recount+date-filter
    // (prevents counting all historical tokens when fileState is empty)
    let totalDelta = 0;
    try {
        const files = readdirSync(_cronRunsDir).filter(f => f.endsWith('.jsonl'));
        if (!isRecount) {
            for (const file of files) {
                const fileKey = `cron:${file}`;
                if (!fileState.has(fileKey)) {
                    isRecount = true; break;
                }
            }
            if (isRecount) {
                const tw = getShanghaiTimeWindow();
                startOfDayMs = tw.todayStartMs;
                startOfMonthMs = tw.monthStartMs;
            }
        }
        // v2026.04.30: recount must reset lastLineIndex=0 for ALL files
        if (isRecount) {
            for (const s of fileState.values()) {
                s.lastTotalTokens = 0;
                s.lastLineIndex = 0;
            }
        }
        for (const file of files) {
            const filePath = join(_cronRunsDir, file);
            const fileKey = `cron:${file}`;
            const delta = scanJsonlFile(filePath, fileKey, isRecount, startOfDayMs, startOfMonthMs);
            totalDelta += delta;
        }
    } catch (e) { console.error('[daemon] scanCronRuns error:', e?.message); }
    daemonToday += totalDelta;
    daemonMonth += totalDelta;
}
function flushStats() {
    daemonLastFlushMs = Date.now();
    try {
        if (!_tokenStatsPath) return;
        let existing = {};
        try { existing = JSON.parse(readFileSync(_tokenStatsPath, 'utf8')); } catch { }
        const key = getShanghaiDateKey();
        const prevDaemonToday = existing.daemonToday || 0;
        const prevDaemonMonth = existing.daemonMonth || 0;
        const sameDay = existing.dateKey === key;
        const sameMonth = existing.dateKey && existing.dateKey.substring(0, 7) === key.substring(0, 7);
        let globalToday, globalMonth;
        if (sameDay) {
            const baseToday = Math.max((existing.todayTokens || 0) - prevDaemonToday, 0);
            globalToday = baseToday + daemonToday;
        } else {
            globalToday = daemonToday;
        }
        if (sameMonth) {
            const baseMonth = Math.max((existing.monthTokens || 0) - prevDaemonMonth, 0);
            globalMonth = baseMonth + daemonMonth;
        } else {
            globalMonth = daemonMonth;
        }
        const output = {
            dateKey: key,
            todayTokens: globalToday,
            monthTokens: globalMonth,
            daemonToday,
            daemonMonth,
            scannedFiles: Object.fromEntries(fileState),
            updatedAt: new Date().toISOString(),
            source: 'token-aggregator-daemon',
        };
        // Preserve sessionTotals written by the Event path (TokenAggregator)
        if (existing.sessionTotals && typeof existing.sessionTotals === 'object') {
            output.sessionTotals = existing.sessionTotals;
        }
        writeFileSync(_tokenStatsPath, JSON.stringify(output, null, 2), 'utf8');
    } catch { /* ignore */ }
}
function tick() {
    scanCronRuns();
    flushStats();
}
function startTokenAggregatorDaemon() {
    if (_timer) return;
    const home = homedir();
    _tokenStatsPath = join(home, '.openclaw', 'token-stats.json');
    _cronRunsDir = join(home, '.openclaw', 'cron', 'runs');
    // Load existing fileState from token-stats.json
    try {
        if (existsSync(_tokenStatsPath)) {
            const data = JSON.parse(readFileSync(_tokenStatsPath, 'utf8'));
            if (data.scannedFiles && typeof data.scannedFiles === 'object') {
                for (const [k, v] of Object.entries(data.scannedFiles)) {
                    if (v && typeof v === 'object') {
                        fileState.set(k, {
                            lastLineIndex: typeof v.lastLineIndex === 'number' ? v.lastLineIndex : 0,
                            lastTotalTokens: typeof v.lastTotalTokens === 'number' ? v.lastTotalTokens : 0,
                        });
                    }
                }
            }
            // Bug#11: force recount on every startup
            // Load monthKey for month boundary detection, then clear to force dateChanged=true
            // Preserve daemonMonth — Bug#10's recalculation formula needs it
            if (data.dateKey) currentMonthKey = data.dateKey.substring(0, 7);
            if (typeof data.daemonMonth === 'number') daemonMonth = data.daemonMonth;
            currentDateKey = '';
            daemonToday = 0;
            // Clear daemonToday in file immediately so aggregator doesn't read stale value
            // Also subtract old daemon contribution from todayTokens so aggregator's
            // eventPathToday = (todayTokens - _loadedDaemonToday) doesn't inflate
            try {
                const existing = JSON.parse(readFileSync(_tokenStatsPath, 'utf8'));
                const oldDaemonToday = typeof existing.daemonToday === 'number' ? existing.daemonToday : 0;
                existing.todayTokens = Math.max((existing.todayTokens || 0) - oldDaemonToday, 0);
                existing.daemonToday = 0;
                existing.updatedAt = new Date().toISOString();
                writeFileSync(_tokenStatsPath, JSON.stringify(existing, null, 2));
            } catch { /* ignore */ }
        }
    } catch { /* ignore */ }
    tick(); // Initial scan
    _timer = setInterval(tick, SCAN_INTERVAL_MS);
    if (_timer.unref) _timer.unref();
}
function stopTokenAggregatorDaemon() {
    if (_timer) { clearInterval(_timer); _timer = null; }
    daemonLastFlushMs = 0;
}
function isDaemonAlive() {
    if (!daemonLastFlushMs) return true;
    // Daemon scans every 5 min; allow 6 min before declaring dead
    return Date.now() - daemonLastFlushMs < 360_000;
}
