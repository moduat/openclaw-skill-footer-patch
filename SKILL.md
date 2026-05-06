# Footer 全量显示补丁 — AI 操作指南

> **用途**: openclaw-lark 插件升级后，恢复飞书卡片 Footer 全量显示补丁
> **触发**: 用户说"footer 补丁需要恢复" / "插件升级了" / "footer 还在吗"
> **适用版本**: openclaw-lark >= 2026.4.7（基于 2026.4.10 开发）
> **最后更新**: 2026-05-07
> **版本**: v1.5

---

## 一、补丁概述

本补丁为飞书卡片 Footer 添加 4 行全量显示：

```
Line1: 🪙Token今/月: 27.5M丨27.5M · 05/02-19:42
Line2: ──────────────────
Line3: ✅已完成 · ⏳️2m 15s · xiaomi-coding/mimo-v2.5-pro
Line4: ↑ 85.1k ↓ 8.2k · 缓存 1.9k/0 (5%) · 📑 39.7k/205k (19%) · 💸 $0.3379 · 🚀首token 611.64s
```

- Line1: 全局 Token 累计（今日/本月）
- Line2: 分隔线（纯装饰）
- Line3: 状态(emoji+中文) · 耗时 · 模型名
- Line4: 输入输出Token · 缓存 · 上下文 · 费用 · 首token延迟

---

## 二、文件清单

### 修改文件（5个）

| # | 源路径 | 备份在 | 改动目的 |
|---|--------|--------|----------|
| 1 | `src/card/builder.js` | `modified/builder.js` | 4行footer布局、中文状态标签、emoji、费用/首token显示 |
| 2 | `src/card/reply-mode.js` | `modified/reply-mode.js` | 群聊使用 streaming 模式 |
| 3 | `src/card/streaming-card-controller.js` | `modified/streaming-card-controller.js` | Token数据采集、首token延迟、事件发布 |
| 4 | `src/channel/monitor.js` | `modified/monitor.js` | 启动Token聚合组件、健康检查看门狗 |
| 5 | `src/core/footer-config.js` | `modified/footer-config.js` | 默认开启所有9个footer字段 |

### 新建文件（3个）

| # | 源路径 | 备份在 | 用途 |
|---|--------|--------|------|
| 6 | `src/channel/event-bus.js` | `created/event-bus.js` | 进程级事件发布/订阅 |
| 7 | `src/channel/token-aggregator.js` | `created/token-aggregator.js` | 事件驱动Token聚合（监听会话完成事件） |
| 8 | `src/channel/token-aggregator-daemon.js` | `created/token-aggregator-daemon.js` | 文件扫描Token聚合（扫描cron/runs JSONL） |

### Skill 目录结构

```
~/.openclaw/skills/footer-patch/
├── SKILL.md              ← 本文件（AI操作指南）
├── original/             ← 5个原始文件（改之前，用于对比差异）
│   ├── builder.js
│   ├── reply-mode.js
│   ├── streaming-card-controller.js
│   ├── monitor.js
│   └── footer-config.js
├── modified/             ← 5个修改后的文件（用于覆盖）
│   ├── builder.js
│   ├── reply-mode.js
│   ├── streaming-card-controller.js
│   ├── monitor.js
│   └── footer-config.js
├── created/              ← 3个新建的文件（用于补充）
│   ├── event-bus.js
│   ├── token-aggregator.js
│   └── token-aggregator-daemon.js
└── new-backup/           ← 恢复时临时存放新版文件（自动生成）
```

---

## 三、每个文件的改动详情

### 1. builder.js（改动最大）

**目的**: 实现 4 行 footer 布局，显示全部 7 项指标

**改动点**:

1. **compactNumber() 阈值**: 1000（数字小于1000时显示精确值）

2. **formatFooterRuntimeSegments() 重写为 4 行**:
   - Line1: `🪙Token今/月: {today}丨{month} · {dateKey}`（需 `showGlobalTokens && footerMetrics`）
   - Line2: `──────────────────`（分隔线，由 buildCompleteCard 添加）
   - Line3: `{status} · ⏳️{elapsed} · {model}`（始终显示）
   - Line4: `↑ {input} ↓ {output} · 缓存 {cacheR}/{cacheW} ({hit}%) · 📑 {ctx}/{total} ({pct}%) · 💸 ${cost} · 🚀首token {ftl}s`

3. **状态标签 emoji + 中文**:
   - `metrics.status === 'error' ? '❌出错' : metrics.status === 'aborted' ? '⏹️已停止' : '✅已完成'`

4. **耗时格式**: `⏳️{minutes}m {seconds}s` 或 `⏳️{seconds}s`

5. **showGlobalTokens opt-out**: Line1 用 `showGlobalTokens !== false` 控制（默认显示）

6. **上下文窗口 robustness**:
   - 3级 totalTokens fallback: `metrics.totalTokens → metrics.contextTokens → cfg.contextWindow`
   - `inputTokens >= 0` 允许显示 0 值

7. **calcModelCost**: 公式 `(input/1M * cost.input) + (output/1M * cost.output) + (cacheRead/1M * cost.cacheRead)`

8. **首token延迟**: `metrics.firstTokenLatencyMs > 0` 时显示

### 2. reply-mode.js（1处改动）

`expandAutoMode()` 中 streaming=true 时返回 `'streaming'`（群聊和私聊统一）。

### 3. streaming-card-controller.js（改动最多）

**目的**: 采集 footer 所需的所有指标数据，发布到 event-bus

**改动点**:

1. **移除 `lark_client_1` import**: 不再依赖 LarkClient.runtime 读取 session store

2. **新增 `computeTranscriptTokenTotals(transcriptPath)`**:
   - 遍历 transcript JSONL 文件
   - 累加所有 `message.usage.inputTokens + outputTokens + cacheRead + cacheWrite`
   - 返回 `{inputTokens, outputTokens, cacheRead, cacheWrite, totalTokens}`
   - cacheRead 从 `usage.cacheRead` 或 `usage.cache_read` 读取（兼容两种格式）

3. **新增 `collectFooterMetrics(entry, cfg, sessionKey)`**:
   - 从 session store entry 读取基础指标
   - 调用 `computeTranscriptTokenTotals` 获取精确 token 数据
   - 调用 `calcModelCost` 计算费用

4. **新增 `resolveContextWindowFromConfig(model, cfg)`**:
   - 从 `cfg.models.providers` 中查找匹配模型的 contextWindow
   - 支持模糊匹配（model 可能带 provider 前缀）

5. **重写 `getFooterSessionMetrics(sessionKey, cfg)`**:
   - 直接读取 session store JSON 文件
   - 从 sessionKey 提取 agentId: `sessionKey.split(':')[1]`
   - 构造路径: `~/.openclaw/agents/{agentId}/sessions/sessions.json`
   - **重要**: 不要依赖 `resolveStorePath()` 的默认值，它默认返回 main agent 的路径

6. **新增 `_publishTokenEvent(footerMetrics)`**:
   - 发布 `session_tokens_accrued` 事件到 event-bus
   - `totalTokens = baseTotal + (footerMetrics.cacheRead ?? 0) + (footerMetrics.cacheWrite ?? 0)`
   - 其中 `baseTotal = footerMetrics.totalTokens ?? (inputTokens + outputTokens)`
   - require 路径: `require('../channel/event-bus.js')`
   - 位置: 在 `abortCard` 方法之后、`ensureCardCreated` 方法之前

7. **三个终态路径调用 _publishTokenEvent**:
   - `onError()` — 出错时发布
   - `onIdle()` — 完成时发布
   - `abortCard()` — 中止时发布
   - 每个路径在 `needsFooterMetrics()` → `collectFooterMetrics()` 之后调用

8. **首token延迟测量**:
   - 构造函数中: `this._transcriptStartTime = Date.now()`
   - `onDeliver()` 中: `if (this._transcriptFirstTokenTs == null) this._transcriptFirstTokenTs = Date.now()`
   - ftl = `_transcriptFirstTokenTs - _transcriptStartTime`

9. **needsFooterMetrics()**: 检查所有 9 个 footer config 字段

### 4. monitor.js（3处改动）

1. **启动 TokenAggregator + Daemon 单例**（在 `monitorFeishuProvider()` 中）

2. **drainShutdownHooks 后重置守卫**:
   ```javascript
   _tokenAggregator = null;
   _tokenAggregatorDaemonStarted = false;
   ```
   单账户路径和多账户路径各一处。

3. **ensureHealthCheck() 看门狗**:
   - 60s 间隔检查 TokenAggregator.isAlive() 和 Daemon.isDaemonAlive()
   - 死了则 stop() → new → 重新订阅
   - 不注册到 drainShutdownHooks（进程级生命周期）
   - 使用 `.unref()` 不阻止进程退出

### 5. footer-config.js（2处改动）

1. **DEFAULT_FOOTER_CONFIG**: 所有 9 个字段默认 `true`（status/elapsed/tokens/cache/context/model/cost/todayTokens/monthTokens）

2. **resolveFooterConfig()**: merge 逻辑不变，确保新字段参与合并

### 6. event-bus.js（新建）

进程级事件发布/订阅，连接 streaming-card-controller 和 token-aggregator。

API: `eventBus.subscribe(event, handler)` / `eventBus.publish(event, payload)` / `eventBus.unsubscribe(event, handler)`

事件: `session_tokens_accrued` — payload: `{sessionKey, tokens, timestamp}`

### 7. token-aggregator.js（新建）

**用途**: 事件驱动的 Token 聚合器，订阅会话完成事件，累加到 token-stats.json

**关键逻辑**:
- `_sessionTotals` Map: sessionKey → cumulativeTotal（持久化到 token-stats.json）
- `_loadedDaemonToday` / `_loadedDaemonMonth`: 启动时从文件加载的 daemon 快照
- **delta = event.tokens（直接信任）**
- `_flush()`: 30s 间隔
  - `eventPathToday = todayTokens - _loadedDaemonToday`
  - `globalToday = eventPathToday + currentDaemonToday`
  - `Math.max(0, ...)` 防止负值
  - 跨日检测: `dateChanged`/`monthChanged` 标志，跨日时重置 `_loadedDaemonToday=0`
  - 保留 existing.daemonToday/daemonMonth/scannedFiles/sessionTotals
- `_loadFromFile()`: 加载 sessionTotals + todayTokens/monthTokens（日期匹配时）+ _loadedDaemonToday/_loadedDaemonMonth
- 日期辅助函数: UTC+8 偏移法（`new Date(Date.now() + SHANGHAI_OFFSET_MS)` + UTC 方法）
- `isAlive()`: 360s 无 flush 判定死亡

### 8. token-aggregator-daemon.js（新建）

**用途**: 文件扫描 Token 聚合，扫描 cron/runs/*.jsonl，补充事件路径遗漏的 token

**关键逻辑**:
- 每 5 分钟扫描一次
- 支持 camelCase/snake_case/`ts`/`timestamp` 字段格式
- `daemonToday`/`daemonMonth` 独立跟踪
- 日期/月份边界: `lastLineIndex = 0` + `lastTotalTokens = 0` 全量重算
- 新文件必须走 recount + 日期过滤（`startOfDayMs`）
- `scanJsonlFile` 中 `state.lastLineIndex = i + 1` 在循环顶部（continue 之前）
- flush 公式: `(global - oldDaemon) + newDaemon`
- `isDaemonAlive()`: 360s 无 flush 判定死亡
- 不覆盖 token-stats.json 中的 `sessionTotals` 字段
- 启动时: `currentDateKey=''` + `daemonToday=0` 强制 recount
- 启动时立即写 `daemonToday=0` 到文件（在 `tick()` 之前）
- 启动写入时: `existing.todayTokens -= existing.daemonToday` 减旧值
- 文件路径变量: `_tokenStatsPath`（模块级变量）
- 日期辅助函数: UTC+8 偏移法（`new Date(Date.now() + SHANGHAI_OFFSET_MS)` + UTC 方法）

---

## 四、恢复流程（按顺序执行）

### Step 1: 备份新版文件（带日期戳）

```bash
DATE=$(date +%Y%m%d)
BACKUP_DIR=~/.openclaw/skills/footer-patch/new-backup/$DATE
mkdir -p "$BACKUP_DIR"

PLUGIN=~/.openclaw/extensions/openclaw-lark

for f in \
  src/card/builder.js \
  src/card/reply-mode.js \
  src/card/streaming-card-controller.js \
  src/channel/monitor.js \
  src/core/footer-config.js; do
  mkdir -p "$BACKUP_DIR/$(dirname $f)"
  cp "$PLUGIN/$f" "$BACKUP_DIR/$f"
done
echo "✅ 已备份新版到 $BACKUP_DIR"
```

### Step 2: 对比差异

```bash
SKILL=~/.openclaw/skills/footer-patch
BACKUP=~/.openclaw/skills/footer-patch/new-backup/$DATE

declare -A FILE_MAP=(
  ["builder.js"]="src/card/builder.js"
  ["reply-mode.js"]="src/card/reply-mode.js"
  ["streaming-card-controller.js"]="src/card/streaming-card-controller.js"
  ["monitor.js"]="src/channel/monitor.js"
  ["footer-config.js"]="src/core/footer-config.js"
)

BIG_CHANGE=0
for f in builder.js reply-mode.js streaming-card-controller.js monitor.js footer-config.js; do
  RELPATH="${FILE_MAP[$f]}"
  LINES=$(diff "$SKILL/original/$f" "$BACKUP/$RELPATH" 2>/dev/null | wc -l)
  if [ "$LINES" -eq 0 ]; then
    echo "✅ $f: 无变化"
  elif [ "$LINES" -lt 100 ]; then
    echo "⚠️ $f: 小变化 ($LINES 行)"
  else
    echo "❌ $f: 大变化 ($LINES 行)"
    diff "$SKILL/original/$f" "$BACKUP/$RELPATH" >> "$SKILL/diff-report.txt"
    BIG_CHANGE=1
  fi
done

if [ $BIG_CHANGE -eq 1 ]; then
  echo "❌ 有文件发生大变化！已保存 diff 到 $SKILL/diff-report.txt"
  echo "请将 diff-report.txt 发给 AI 分析修复方案。"
  echo "在 AI 确认前，不要执行后续步骤。"
  exit 1
fi
```

判断标准: 0 行=安全覆盖 | <100 行=小变化 | >=100 行=停止，找 AI 分析

### Step 3: 检查新建文件是否冲突

```bash
PLUGIN=~/.openclaw/extensions/openclaw-lark
SKILL=~/.openclaw/skills/footer-patch

for f in event-bus.js token-aggregator.js token-aggregator-daemon.js; do
  if [ -f "$PLUGIN/src/channel/$f" ]; then
    if diff "$SKILL/created/$f" "$PLUGIN/src/channel/$f" > /dev/null 2>&1; then
      echo "✅ $f: 新版有同名文件，但内容相同，跳过"
    else
      echo "❌ $f: 新版有同名文件且内容不同！"
      cp "$PLUGIN/src/channel/$f" "$SKILL/new-backup/$DATE/conflict-$f"
      CONFLICT=1
    fi
  else
    echo "✅ $f: 新版没有此文件，可以安全补回"
  fi
done

if [ "${CONFLICT:-0}" -eq 1 ]; then
  echo "❌ 有文件名冲突！请将 new-backup/$DATE/conflict-* 发给 AI 分析。"
  exit 1
fi
```

### Step 4: 覆盖修改文件 + 补回新建文件

```bash
PLUGIN=~/.openclaw/extensions/openclaw-lark
SKILL=~/.openclaw/skills/footer-patch

cp "$SKILL/modified/builder.js" "$PLUGIN/src/card/builder.js"
cp "$SKILL/modified/reply-mode.js" "$PLUGIN/src/card/reply-mode.js"
cp "$SKILL/modified/streaming-card-controller.js" "$PLUGIN/src/card/streaming-card-controller.js"
cp "$SKILL/modified/monitor.js" "$PLUGIN/src/channel/monitor.js"
cp "$SKILL/modified/footer-config.js" "$PLUGIN/src/core/footer-config.js"

cp "$SKILL/created/event-bus.js" "$PLUGIN/src/channel/event-bus.js"
cp "$SKILL/created/token-aggregator.js" "$PLUGIN/src/channel/token-aggregator.js"
cp "$SKILL/created/token-aggregator-daemon.js" "$PLUGIN/src/channel/token-aggregator-daemon.js"

echo "✅ 已覆盖 5 个 + 补回 3 个"
```

### Step 5: 语法检查

```bash
PLUGIN=~/.openclaw/extensions/openclaw-lark
FAIL=0
for f in \
  src/card/builder.js \
  src/card/reply-mode.js \
  src/card/streaming-card-controller.js \
  src/channel/monitor.js \
  src/core/footer-config.js \
  src/channel/event-bus.js \
  src/channel/token-aggregator.js \
  src/channel/token-aggregator-daemon.js; do
  if node -c "$PLUGIN/$f" 2>/dev/null; then
    echo "✅ $f"
  else
    echo "❌ $f 语法错误！"
    FAIL=1
  fi
done

if [ $FAIL -eq 1 ]; then
  echo "❌ 语法检查失败，正在回滚..."
  DATE=$(ls -t ~/.openclaw/skills/footer-patch/new-backup/ | head -1)
  BACKUP=~/.openclaw/skills/footer-patch/new-backup/$DATE
  for f in \
    src/card/builder.js \
    src/card/reply-mode.js \
    src/card/streaming-card-controller.js \
    src/channel/monitor.js \
    src/core/footer-config.js; do
    cp "$BACKUP/$f" "$PLUGIN/$f"
  done
  for f in event-bus.js token-aggregator.js token-aggregator-daemon.js; do
    rm -f "$PLUGIN/src/channel/$f"
  done
  echo "✅ 已回滚到新版原始文件"
  exit 1
fi
```

### Step 6: 检查 openclaw.json 配置

```bash
cat ~/.openclaw/openclaw.json | python3 -c "
import json, sys
cfg = json.load(sys.stdin)
footer = cfg.get('channels', {}).get('feishu', {}).get('footer', {})
required = ['status','elapsed','tokens','cache','context','model','cost','todayTokens','monthTokens']
missing = [k for k in required if not footer.get(k)]
if missing:
    print(f'⚠️ footer 配置缺少字段: {missing}')
else:
    print('✅ footer 配置完整')
"
```

缺少字段时需修改 `~/.openclaw/openclaw.json` 中的 `channels.feishu.footer`。

### Step 7: 重启 Gateway

```bash
openclaw gateway restart
```

### Step 8: 验证

1. 等 gateway 启动完成（约 30 秒）
2. 发一条消息给任意 agent
3. 等 agent 回复完成
4. 检查 footer 4 行是否全部显示：
   - **Line1**: `🪙Token今/月: X丨X`（数字可以是 0，文字必须出现）
   - **Line2**: `──────────────────`（分隔线）
   - **Line3**: `✅已完成` 或 `❌出错` 或 `⏹️已停止` + 耗时 + 模型名
   - **Line4**: `↑ X ↓ X` + `缓存` + `📑` + `💸` + `🚀`（至少 3 个）
5. 只显示 Line3 没有 Line1/Line4 时：
   - 检查日志: `tail -100 ~/.openclaw/logs/gateway.log | grep -iE 'error|footer|token-aggregator'`
   - 可能是 token-stats.json 不存在（首次启动需要等 30 秒 flush）
   - 可能是 session store 路径不对（看日志有无 "store not found"）

---

## 五、样式配置（恢复时可调整）

| 用户选择 | 改动位置 | 具体操作 |
|---------|---------|--------|
| 去掉某个字段 | `openclaw.json` | `footer.<字段>: false` |
| 不要分隔线 | `builder.js` | `formatFooterRuntimeSegments()` 去掉 Line 2 |
| 中文/英文/双语标签 | `builder.js` | `formatFooterRuntimeSegments()` 修改状态字符串 |
| 粗略数字 | `builder.js` | `compactNumber()` 阈值从 1000 改回 100 |
| 改分隔线字符 | `builder.js` | `formatFooterRuntimeSegments()` 修改分隔线字符串 |

当前配置: 全部 7 项显示 · 中文标签 · 精确数字（阈值 1000）· 分隔线保留

---

## 六、回滚方法

```bash
DATE=$(ls -t ~/.openclaw/skills/footer-patch/new-backup/ | head -1)
BACKUP=~/.openclaw/skills/footer-patch/new-backup/$DATE
PLUGIN=~/.openclaw/extensions/openclaw-lark

for f in \
  src/card/builder.js \
  src/card/reply-mode.js \
  src/card/streaming-card-controller.js \
  src/channel/monitor.js \
  src/core/footer-config.js; do
  cp "$BACKUP/$f" "$PLUGIN/$f"
done

rm -f "$PLUGIN/src/channel/event-bus.js"
rm -f "$PLUGIN/src/channel/token-aggregator.js"
rm -f "$PLUGIN/src/channel/token-aggregator-daemon.js"

openclaw gateway restart
echo "✅ 已回滚，footer 补丁已移除"
```

---

## 七、依赖关系图

```
footer-config.js ← 被 streaming-card-controller.js 读取
       ↓
event-bus.js ← 被 streaming-card-controller.js 发布事件
       ↓              被 token-aggregator.js 订阅事件
token-aggregator.js ← 被 monitor.js 启动
       ↓
token-aggregator-daemon.js ← 被 monitor.js 启动
       ↓
monitor.js ← 启动上述组件，管理生命周期
       ↓
streaming-card-controller.js ← 采集数据 + 发布事件
       ↓
builder.js ← 读取 metrics 对象，渲染 footer
       ↓
reply-mode.js ← 确保群聊用 streaming 模式
```

**如果新建文件缺失**: streaming-card-controller.js import event-bus.js 崩溃 → gateway 启动失败
**如果 monitor.js 未修改**: TokenAggregator 不启动 → token-stats.json 不更新 → Line1 永远为 0
**如果 footer-config.js 未修改**: 默认所有字段 false → footer 不显示

---

## 八、关键技术细节

### 首token延迟
- `_transcriptStartTime`: StreamingCardController 构造函数中赋值 `Date.now()`
- `_transcriptFirstTokenTs`: `onDeliver()` 中首次调用时赋值 `Date.now()`
- 使用 `== null` guard 防止重复赋值
- ftl = `_transcriptFirstTokenTs - _transcriptStartTime`

### getFooterSessionMetrics 路径
- 从 sessionKey 提取 agentId: `sessionKey.split(':')[1]`
- 构造路径: `~/.openclaw/agents/{agentId}/sessions/sessions.json`
- **不要用 `resolveStorePath()` 默认值**，它返回 main agent 的路径

### 日期格式
- 使用 UTC+8 偏移法：`new Date(Date.now() + SHANGHAI_OFFSET_MS)` + UTC 方法
- **禁止使用 `toLocaleDateString()` / `toLocaleString()`**
- getShanghaiTimeWindow() 计算 todayStartMs/monthStartMs

### isAlive 阈值
- TokenAggregator: 360s
- TokenAggregatorDaemon: 360s

### drainShutdownHooks 重置
- 两个 `drainShutdownHooks()` 调用后必须重置:
  ```javascript
  _tokenAggregator = null;
  _tokenAggregatorDaemonStarted = false;
  ```

### Token 统计双路径
- **Event 路径**: Feishu 会话 → transcript JSONL → _publishTokenEvent → TokenAggregator → token-stats.json
- **Daemon 路径**: Cron/Dreaming → cron/runs JSONL → daemon 扫描 → 累加到 token-stats.json
- 两路径互补，不重复计数（通过 _sessionTotals 去重）

---

## 九、验证清单

1. Gateway 启动完成（约 30 秒）
2. 日志出现 `[TokenAggregator] started: today=... month=...`
3. 日志出现 `[token-aggregator-daemon] started — scan=300s...`
4. 发送消息，等回复完成
5. footer 4 行全部显示（Line1-4）
6. 只显示 Line3 时检查日志和 token-stats.json
7. 验证群聊 Footer
8. 30 秒后 `~/.openclaw/token-stats.json` 更新
9. 双路径运行:
   - `grep 'TokenAggregator.*flushed' ~/.openclaw/logs/gateway.log`
   - `grep 'token-aggregator-daemon.*scanned' ~/.openclaw/logs/gateway.log`
10. 无致命错误: `tail -50 ~/.openclaw/logs/gateway.log | grep -iE 'FATAL|crash|uncaught'`

---

## 十、常见问题

**Q: footer 不显示？**
A: 检查 `openclaw.json` 中 `channels.feishu.footer`，9 个字段都应为 `true`。

**Q: Token 今/月显示为 0？**
A: 正常，首次启动需要等 30 秒 flush。

**Q: 费用不显示？**
A: 模型没有 cost 配置时费用为 0，自动隐藏。免费模型不显示费用是正常的。

**Q: 只显示 Line3 没有 Line1/Line4？**
A: 三种可能：token-stats.json 不存在（等 30 秒）/ session store 路径不对（看日志）/ 模型无 cost 配置（费用跳过但其他行应在）

**Q: 新版插件自己加了 event-bus.js / token-aggregator.js？**
A: Step 3 会检测冲突。冲突时需 AI 对比决定合并还是覆盖。

**Q: 覆盖后 gateway 崩溃？**
A: 最常见原因：event-bus.js 没被补回。检查 `$PLUGIN/src/channel/event-bus.js` 是否存在。

**Q: 双路径怎么确认都在运行？**
A: 日志 grep `TokenAggregator.*flushed` 和 `token-aggregator-daemon.*scanned` 和 `health-check`，三个都应有输出。

**Q: token-stats.json 数据准不准？**
A: 对比增量与 API 后台计费。Event 路径覆盖 Feishu 会话，Daemon 路径覆盖 cron/dreaming。

---

## 十一、禁止事项

- ❌ 禁止修改 openclaw-lark 插件目录以外的任何文件
- ❌ 禁止跳过语法验证步骤
- ❌ 禁止在用户未确认前覆盖任何文件
- ❌ 禁止修改本文档中未列出的文件或函数
- ❌ 禁止假设目标机器的路径、版本、配置与当前机器相同
- ❌ 禁止同时扫描 agents/ 和 cron/runs/ 导致双重计数
- ❌ 禁止将旧版代码作为修改依据（以 `modified/` 和 `created/` 为准）

---

## 十二、已知问题

| 问题 | 状态 | 说明 |
|------|------|------|
| ⑥ 费用不显示（模型 cost 全为 0） | ⚠️ 需配置 | `openclaw.json` 中 `models.providers` 添加 cost 字段 |
| 月累计基数跨月丢失 | ⚠️ 正常行为 | 每月 1 日 daemonMonth 重置为 0，需手动初始化保留历史 |
| token-stats.json 月累计基数：每月1日 daemonMonth 重置为0，需手动初始化保留历史（如195M） | ⚠️ 正常行为 | 同上 |
