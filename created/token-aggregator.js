'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.TokenAggregator = void 0;
const { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } = require('node:fs');
const { dirname } = require('node:path');
const { subscribe } = require('./event-bus.js');
const LOCK_TIMEOUT_MS = 10_000;
const FLUSH_INTERVAL_MS = 30_000;
function getShanghaiDateKey() {
    const now = new Date();
    // en-CA locale returns 'YYYY-MM-DD' directly
    return now.toLocaleString('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
}
function getShanghaiMonthKey() {
    return getShanghaiDateKey().substring(0, 7);
}
class TokenAggregator {
    constructor(tokenStatsPath) {
        this.tokenStatsPath = tokenStatsPath;
        this.todayTokens = 0;
        this.monthTokens = 0;
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
                this._todayDateKey = key;
            }
            if (monthKey !== this._todayMonthKey) {
                this.monthTokens = 0;
                this._todayMonthKey = monthKey;
            }
            // v2026.04.30 fix: trust event.tokens directly
            let delta = event.tokens || 0;
            if (event.sessionKey && delta > 0) {
                const prev = this._sessionTotals.get(event.sessionKey) || 0;
                this._sessionTotals.set(event.sessionKey, prev + delta);
            }
            if (delta > 0) {
                this.todayTokens += delta;
                this.monthTokens += delta;
            }
        } catch { /* ignore */ }
    }
    _flush() {
        this._lastFlushMs = Date.now();
        try {
            this._acquireLock();
            let existing = {};
            try { existing = JSON.parse(readFileSync(this.tokenStatsPath, 'utf8')); } catch { }
            const sameDay = existing.dateKey === this._todayDateKey;
            const sameMonth = existing.dateKey
                && existing.dateKey.substring(0, 7) === this._todayDateKey.substring(0, 7);
            const output = {
                dateKey: this._todayDateKey,
                todayTokens: sameDay
                    ? Math.max(this.todayTokens, existing.todayTokens || 0)
                    : this.todayTokens,
                monthTokens: sameMonth
                    ? Math.max(this.monthTokens, existing.monthTokens || 0)
                    : this.monthTokens,
            };
            // Preserve daemon state fields
            if (typeof existing.daemonToday === 'number') output.daemonToday = existing.daemonToday;
            if (typeof existing.daemonMonth === 'number') output.daemonMonth = existing.daemonMonth;
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
            if (data.dateKey === this._todayDateKey) {
                this.todayTokens = typeof data.todayTokens === 'number' ? data.todayTokens : 0;
                this.monthTokens = typeof data.monthTokens === 'number' ? data.monthTokens : 0;
            }
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
        return Date.now() - this._lastFlushMs < 120_000;
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
