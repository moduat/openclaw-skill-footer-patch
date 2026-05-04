'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.TokenAggregator = void 0;
const { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } = require('node:fs');
const { dirname } = require('node:path');
const { subscribe } = require('./event-bus.js');
const LOCK_TIMEOUT_MS = 10_000;
const FLUSH_INTERVAL_MS = 30_000;
const SHANGHAI_OFFSET_MS = 8 * 3600 * 1000;
function getShanghaiDateKey() {
    const d = new Date(Date.now() + SHANGHAI_OFFSET_MS);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function getShanghaiMonthKey() {
    return getShanghaiDateKey().substring(0, 7);
}
class TokenAggregator {
    constructor(tokenStatsPath) {
        this.tokenStatsPath = tokenStatsPath;
        this.todayTokens = 0;
        this.monthTokens = 0;
        this._loadedDaemonToday = 0;
        this._loadedDaemonMonth = 0;
        this._sessionTotals = new Map();
        this._lastFlushMs = Date.now();
        this._todayDateKey = getShanghaiDateKey();
        this._todayMonthKey = getShanghaiMonthKey();
        this._unsubscribe = null;
        this._flushTimer = null;
        this._loadFromFile();
        this._unsubscribe = subscribe('session_tokens_accrued', (event) => this._onTokensAccrued(event));
        this._flushTimer = setInterval(() => this._flush(), FLUSH_INTERVAL_MS);
        if (this._flushTimer.unref) this._flushTimer.unref();
    }
    _onTokensAccrued(event) {
        try {
            const key = getShanghaiDateKey();
            const monthKey = getShanghaiMonthKey();
            if (key !== this._todayDateKey) {
                this.todayTokens = 0;
                this._loadedDaemonToday = 0;
                this._todayDateKey = key;
            }
            if (monthKey !== this._todayMonthKey) {
                this.monthTokens = 0;
                this._loadedDaemonMonth = 0;
                this._todayMonthKey = monthKey;
            }
            // v2026.04.30: direct-trust mode — event.tokens is the per-message delta
            if (event.sessionKey) {
                const delta = event.tokens || 0;
                if (delta > 0) {
                    const prev = this._sessionTotals.get(event.sessionKey) || 0;
                    this._sessionTotals.set(event.sessionKey, prev + delta);
                    this.todayTokens += delta;
                    this.monthTokens += delta;
                }
            }
        } catch { /* ignore */ }
    }
    _flush() {
        this._lastFlushMs = Date.now();
        try {
            // Detect date/month change even if no messages arrived yet
            const key = getShanghaiDateKey();
            const monthKey = getShanghaiMonthKey();
            let dateChanged = false, monthChanged = false;
            if (key !== this._todayDateKey) {
                this.todayTokens = 0;
                this._loadedDaemonToday = 0;
                this._todayDateKey = key;
                dateChanged = true;
            }
            if (monthKey !== this._todayMonthKey) {
                this.monthTokens = 0;
                this._loadedDaemonMonth = 0;
                this._todayMonthKey = monthKey;
                monthChanged = true;
                dateChanged = true; // month change implies date change
            }
            this._acquireLock();
            let existing = {};
            try { existing = JSON.parse(readFileSync(this.tokenStatsPath, 'utf8')); } catch { }
            const sameDay = existing.dateKey === this._todayDateKey;
            const sameMonth = existing.dateKey
                && existing.dateKey.substring(0, 7) === this._todayDateKey.substring(0, 7);
            // Bug#10: recalculation formula separating Event and Daemon contributions
            const currentDaemonToday = typeof existing.daemonToday === 'number' ? existing.daemonToday : 0;
            const currentDaemonMonth = typeof existing.daemonMonth === 'number' ? existing.daemonMonth : 0;
            let globalToday, globalMonth;
            if (sameDay) {
                const eventPathToday = this.todayTokens - this._loadedDaemonToday;
                globalToday = eventPathToday + currentDaemonToday;
            } else {
                globalToday = this.todayTokens;
            }
            if (sameMonth) {
                const eventPathMonth = this.monthTokens - this._loadedDaemonMonth;
                globalMonth = eventPathMonth + currentDaemonMonth;
            } else {
                globalMonth = this.monthTokens;
            }
            const output = {
                dateKey: this._todayDateKey,
                todayTokens: Math.max(0, globalToday),
                monthTokens: Math.max(0, globalMonth),
            };
            // Preserve daemon state fields (reset stale values on date/month change)
            if (dateChanged) {
                output.daemonToday = 0;
            } else if (typeof existing.daemonToday === 'number') {
                output.daemonToday = existing.daemonToday;
            }
            if (monthChanged) {
                output.daemonMonth = 0;
            } else if (typeof existing.daemonMonth === 'number') {
                output.daemonMonth = existing.daemonMonth;
            }
            if (existing.scannedFiles && typeof existing.scannedFiles === 'object') output.scannedFiles = existing.scannedFiles;
            // Preserve + merge sessionTotals
            const mergedSessionTotals = {};
            if (existing.sessionTotals && typeof existing.sessionTotals === 'object') {
                for (const [k, v] of Object.entries(existing.sessionTotals)) {
                    if (typeof v === 'number') mergedSessionTotals[k] = v;
                }
            }
            for (const [k, v] of this._sessionTotals) {
                mergedSessionTotals[k] = Math.max(v, mergedSessionTotals[k] || 0);
            }
            if (Object.keys(mergedSessionTotals).length > 0) {
                output.sessionTotals = mergedSessionTotals;
            }
            output.updatedAt = new Date().toISOString();
            output.source = 'token-aggregator';
            const dir = dirname(this.tokenStatsPath);
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            writeFileSync(this.tokenStatsPath, JSON.stringify(output, null, 2), 'utf8');
        } catch { /* ignore */ }
        finally { this._releaseLock(); }
    }
    _loadFromFile() {
        try {
            if (!existsSync(this.tokenStatsPath)) return;
            const data = JSON.parse(readFileSync(this.tokenStatsPath, 'utf8'));
            // Bug#10: load daemon contribution snapshot for recalculation formula
            this._loadedDaemonToday = typeof data.daemonToday === 'number' ? data.daemonToday : 0;
            this._loadedDaemonMonth = typeof data.daemonMonth === 'number' ? data.daemonMonth : 0;
            // Load todayTokens/monthTokens when date matches (original feature)
            const key = getShanghaiDateKey();
            if (data.dateKey === key && typeof data.todayTokens === 'number') {
                this.todayTokens = data.todayTokens;
            }
            const monthKey = getShanghaiMonthKey();
            if (data.dateKey && data.dateKey.substring(0, 7) === monthKey && typeof data.monthTokens === 'number') {
                this.monthTokens = data.monthTokens;
            }
            // Load sessionTotals for dedup (v2026.04.28-2)
            if (data.sessionTotals && typeof data.sessionTotals === 'object') {
                for (const [k, v] of Object.entries(data.sessionTotals)) {
                    if (typeof v === 'number') this._sessionTotals.set(k, v);
                }
            }
        } catch { /* ignore */ }
    }
    stop() {
        if (this._flushTimer) { clearInterval(this._flushTimer); this._flushTimer = null; }
        if (this._unsubscribe) { this._unsubscribe(); this._unsubscribe = null; }
        this._flush();
    }
    isAlive() {
        if (!this._lastFlushMs) return true;
        return Date.now() - this._lastFlushMs < 360_000;
    }
    _acquireLock() {
        const lockPath = this.tokenStatsPath + '.lock';
        const start = Date.now();
        while (true) {
            try {
                const dir = dirname(lockPath);
                if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
                writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
                return;
            } catch (e) {
                if (e.code === 'EEXIST') {
                    if (Date.now() - start > LOCK_TIMEOUT_MS) {
                        try { unlinkSync(lockPath); } catch { }
                        return;
                    }
                } else { return; }
            }
        }
    }
    _releaseLock() {
        try { unlinkSync(this.tokenStatsPath + '.lock'); } catch { }
    }
}
exports.TokenAggregator = TokenAggregator;
