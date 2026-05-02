"use strict";
/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Process-internal event bus (pub/sub) for the Lark/Feishu channel plugin.
 *
 * Provides a simple on/off/publish interface for intra-process events.
 * Currently used to bridge StreamingCardController → TokenAggregator
 * for session token accrual notifications.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventBus = void 0;
exports.publish = publish;
exports.subscribe = subscribe;
class EventBus {
    _listeners = new Map();
    on(event, fn) {
        if (!this._listeners.has(event)) this._listeners.set(event, []);
        this._listeners.get(event).push(fn);
    }
    off(event, fn) {
        const arr = this._listeners.get(event);
        if (!arr) return;
        const idx = arr.indexOf(fn);
        if (idx >= 0) arr.splice(idx, 1);
    }
    emit(event, data) {
        const arr = this._listeners.get(event);
        if (!arr) return;
        for (const fn of arr) {
            try { fn(data); } catch { /* ignore */ }
        }
    }
}
exports.EventBus = EventBus;
// Singleton instance
const _bus = new EventBus();
function publish(event, data) { _bus.emit(event, data); }
function subscribe(event, fn) { _bus.on(event, fn); return () => _bus.off(event, fn); }
