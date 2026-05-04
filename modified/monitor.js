"use strict";
/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * WebSocket monitoring for the Lark/Feishu channel plugin.
 *
 * Manages per-account WSClient connections and routes inbound Feishu
 * events (messages, bot membership changes, read receipts) to the
 * appropriate handlers.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.monitorFeishuProvider = monitorFeishuProvider;
const accounts_1 = require("../core/accounts.js");
const lark_client_1 = require("../core/lark-client.js");
const dedup_1 = require("../messaging/inbound/dedup.js");
const lark_logger_1 = require("../core/lark-logger.js");
const shutdown_hooks_1 = require("../core/shutdown-hooks.js");
const event_handlers_1 = require("./event-handlers.js");
const token_aggregator_1 = require("./token-aggregator.js");
const token_aggregator_daemon_1 = require("./token-aggregator-daemon.js");
const mlog = (0, lark_logger_1.larkLogger)('channel/monitor');
let _tokenAggregator = null;
let _tokenAggregatorDaemonStarted = false;
let _healthCheckTimer = null;
// ---------------------------------------------------------------------------
// Single-account monitor
// ---------------------------------------------------------------------------
/**
 * Start monitoring a single Feishu account.
 *
 * Creates a LarkClient, probes bot identity, registers event handlers,
 * and starts a WebSocket connection. Returns a Promise that resolves
 * when the abort signal fires (or immediately if already aborted).
 */
async function monitorSingleAccount(params) {
    const { account, runtime, abortSignal } = params;
    const { accountId } = account;
    const log = runtime?.log ?? ((...args) => mlog.info(args.map(String).join(' ')));
    const error = runtime?.error ?? ((...args) => mlog.error(args.map(String).join(' ')));
    // Only websocket mode is supported in the monitor path.
    const connectionMode = account.config.connectionMode ?? 'websocket';
    if (connectionMode !== 'websocket') {
        log(`feishu[${accountId}]: webhook mode not implemented in monitor`);
        return;
    }
    // Message dedup — filters duplicate deliveries from WebSocket reconnects.
    const dedupCfg = account.config.dedup;
    const messageDedup = new dedup_1.MessageDedup({
        ttlMs: dedupCfg?.ttlMs,
        maxEntries: dedupCfg?.maxEntries,
    });
    log(`feishu[${accountId}]: message dedup enabled (ttl=${messageDedup['ttlMs']}ms, max=${messageDedup['maxEntries']})`);
    log(`feishu[${accountId}]: starting WebSocket connection...`);
    // Create LarkClient instance — manages SDK client, WS, and bot identity.
    const lark = lark_client_1.LarkClient.fromAccount(account);
    // Attach dedup instance so it is disposed together with the client.
    lark.messageDedup = messageDedup;
    /** Per-chat history maps (used for group-chat context window). */
    const chatHistories = new Map();
    const ctx = {
        get cfg() {
            return lark_client_1.LarkClient.runtime.config.loadConfig();
        },
        lark,
        accountId,
        chatHistories,
        messageDedup,
        runtime,
        log,
        error,
    };
    await lark.startWS({
        handlers: {
            'im.message.receive_v1': (data) => (0, event_handlers_1.handleMessageEvent)(ctx, data),
            'im.message.message_read_v1': async () => { },
            'im.message.reaction.created_v1': (data) => (0, event_handlers_1.handleReactionEvent)(ctx, data),
            // These events are expected in normal usage but do not affect the
            // plugin's current behavior. Register no-op handlers to avoid SDK
            // warnings about missing handlers.
            'im.message.reaction.deleted_v1': async () => { },
            'im.chat.access_event.bot_p2p_chat_entered_v1': async () => { },
            'im.chat.member.bot.added_v1': (data) => (0, event_handlers_1.handleBotMembershipEvent)(ctx, data, 'added'),
            'im.chat.member.bot.deleted_v1': (data) => (0, event_handlers_1.handleBotMembershipEvent)(ctx, data, 'removed'),
            'vc.bot.meeting_invited_v1': (data) => (0, event_handlers_1.handleVcMeetingInvitedEvent)(ctx, data),
            // Drive comment event — fires when a user adds a comment or reply on a document.
            'drive.notice.comment_add_v1': (data) => (0, event_handlers_1.handleCommentEvent)(ctx, data),
            // 飞书 SDK EventDispatcher.register 不支持带返回值的处理器，此处 as any 是 SDK 类型限制的变通
            'card.action.trigger': ((data) => 
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (0, event_handlers_1.handleCardActionEvent)(ctx, data)),
        },
        abortSignal,
    });
    // startWS resolves when abortSignal fires — probe result is logged inside startWS.
    log(`feishu[${accountId}]: bot open_id resolved: ${lark.botOpenId ?? 'unknown'}`);
    log(`feishu[${accountId}]: WebSocket client started`);
    mlog.info(`websocket started for account ${accountId}`);
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
// Health check watchdog (v2026.04.29)
// ---------------------------------------------------------------------------
function ensureHealthCheck(tokenStatsPath, log) {
    if (_healthCheckTimer) return;
    const CHECK_INTERVAL_MS = 60 * 1000;
    _healthCheckTimer = setInterval(() => {
        // Check TokenAggregator
        if (_tokenAggregator && !_tokenAggregator.isAlive()) {
            log('[health-check] TokenAggregator appears dead, restarting...');
            try { _tokenAggregator.stop(); } catch { }
            _tokenAggregator = null;
        }
        if (!_tokenAggregator) {
            _tokenAggregator = new token_aggregator_1.TokenAggregator(tokenStatsPath);
            (0, shutdown_hooks_1.registerShutdownHook)('token-aggregator', () => _tokenAggregator?.stop());
            log('[health-check] TokenAggregator recreated');
        }
        // Check Daemon
        if (_tokenAggregatorDaemonStarted && !(0, token_aggregator_daemon_1.isDaemonAlive)()) {
            log('[health-check] TokenAggregatorDaemon appears dead, restarting...');
            try { (0, token_aggregator_daemon_1.stopTokenAggregatorDaemon)(); } catch { }
            _tokenAggregatorDaemonStarted = false;
        }
        if (!_tokenAggregatorDaemonStarted) {
            _tokenAggregatorDaemonStarted = true;
            (0, token_aggregator_daemon_1.startTokenAggregatorDaemon)();
            (0, shutdown_hooks_1.registerShutdownHook)('token-aggregator-daemon',
                () => (0, token_aggregator_daemon_1.stopTokenAggregatorDaemon)());
            log('[health-check] TokenAggregatorDaemon restarted');
        }
    }, CHECK_INTERVAL_MS);
    if (_healthCheckTimer.unref) _healthCheckTimer.unref();
    log('[health-check] watchdog started (interval=60s, threshold=360s)');
}
// ---------------------------------------------------------------------------
/**
 * Start monitoring for all enabled Feishu accounts (or a single
 * account when `opts.accountId` is specified).
 */
async function monitorFeishuProvider(opts = {}) {
    const cfg = opts.config;
    if (!cfg) {
        throw new Error('Config is required for Feishu monitor');
    }
    // Store the original global config so plugin commands (doctor, diagnose)
    // can access cross-account information even when running inside an
    // account-scoped config context.
    lark_client_1.LarkClient.setGlobalConfig(cfg);
    const log = opts.runtime?.log ?? ((...args) => mlog.info(args.map(String).join(' ')));
    // Start TokenAggregator + Daemon singletons
    const path = require('node:path');
    const tokenStatsPath = path.join(require('os').homedir(), '.openclaw', 'token-stats.json');
    if (!_tokenAggregator) {
        _tokenAggregator = new token_aggregator_1.TokenAggregator(tokenStatsPath);
        (0, shutdown_hooks_1.registerShutdownHook)('token-aggregator', () => _tokenAggregator?.stop());
    }
    if (!_tokenAggregatorDaemonStarted) {
        _tokenAggregatorDaemonStarted = true;
        (0, token_aggregator_daemon_1.startTokenAggregatorDaemon)();
        (0, shutdown_hooks_1.registerShutdownHook)('token-aggregator-daemon', () => (0, token_aggregator_daemon_1.stopTokenAggregatorDaemon)());
    }
    ensureHealthCheck(tokenStatsPath, log);
    // Single-account mode.
    if (opts.accountId) {
        const account = (0, accounts_1.getLarkAccount)(cfg, opts.accountId);
        if (!account.enabled || !account.configured) {
            throw new Error(`Feishu account "${opts.accountId}" not configured or disabled`);
        }
        await monitorSingleAccount({
            cfg,
            account,
            runtime: opts.runtime,
            abortSignal: opts.abortSignal,
        });
        await (0, shutdown_hooks_1.drainShutdownHooks)({ log });
        _tokenAggregator = null;
        _tokenAggregatorDaemonStarted = false;
        return;
    }
    // Multi-account mode: start all enabled accounts in parallel.
    const accounts = (0, accounts_1.getEnabledLarkAccounts)(cfg);
    if (accounts.length === 0) {
        throw new Error('No enabled Feishu accounts configured');
    }
    log(`feishu: starting ${accounts.length} account(s): ${accounts.map((a) => a.accountId).join(', ')}`);
    await Promise.all(accounts.map((account) => monitorSingleAccount({
        cfg,
        account,
        runtime: opts.runtime,
        abortSignal: opts.abortSignal,
    })));
    await (0, shutdown_hooks_1.drainShutdownHooks)({ log });
    _tokenAggregator = null;
    _tokenAggregatorDaemonStarted = false;
}
