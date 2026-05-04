# Footer 全量显示补丁 — AI 操作指南

> **用途**: openclaw-lark 插件升级后，恢复飞书卡片 Footer 全量显示补丁
> **触发**: 用户说"footer 补丁需要恢复" / "插件升级了" / "footer 还在吗"
> **适用版本**: openclaw-lark >= 2026.4.7（基于 2026.4.10 开发）
> **最后更新**: 2026-05-04
> **版本**: v1.4（修复跨日 token 刷新、daemon 启动写入、lastLineIndex 递进、日期辅助函数等 6 个 bug）

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

1. **compactNumber() 阈值**: 100 → 1000（数字小于1000时显示精确值）

2. **formatFooterRuntimeSegments() 重写为 4 行**:
   - Line1: `🪙Token今/月: {today}丨{month} · {dateKey}`（需 `showGlobalTokens && footerMetrics`）
   - Line2: `──────────────────`（分隔线，由 buildCompleteCard 添加）
   - Line3: `{status} · ⏳️{elapsed} · {model}`（始终显示）
   - Line4: `↑ {input} ↓ {output} · 缓存 {cacheR}/{cacheW} ({hit}%) · 📑 {ctx}/{total} ({pct}%) · 💸 ${cost} · 🚀首token {ftl}s`

3. **状态标签改为 emoji + 中文**:
   - ❌出错（原: Error）
   - ⏹️已停止（原: Stopped）
   - ✅已完成（原: Complete）
   - 使用 `metrics.status === 'error' ? '❌出错' : metrics.status === 'aborted' ? '⏹️已停止' : '✅已完成'`

4. **耗时格式**: 添加 `⏳️` 前缀，格式 `⏳️{minutes}m {seconds}s` 或 `⏳️{seconds}s`

5. **showGlobalTokens opt-out**: Line1 用 `showGlobalTokens !== false` 控制（默认显示）

6. **上下文窗口 robustness**:
   - 移除 `totalTokensFresh` 检查（不再要求数据新鲜）
   - 3级 totalTokens fallback: `metrics.totalTokens → metrics.contextTokens → cfg.contextWindow`
   - `inputTokens >= 0` 允许显示 0 值

7. **calcModelCost**: 在 builder.js 中调用（实际函数在 streaming-card-controller.js）
   - 公式: `(input/1M * cost.input) + (output/1M * cost.output) + (cacheRead/1M * cost.cacheRead)`

8. **首token延迟**: `metrics.firstTokenLatencyMs > 0` 时显示

**关键函数**: `formatFooterRuntimeSegments(metrics, cfg)`, `buildCompleteCard(state, opts)`

### 2. reply-mode.js（1处改动）

**目的**: 群聊默认使用 streaming 而非 static

**改动点**: `expandAutoMode()` 函数中，group chat 返回 `'streaming'` 而非 `'static'`

```javascript
// 原: group 默认 static
// 改: group 默认 streaming
```

### 3. streaming-card-controller.js（改动最多）

**目的**: 采集 footer 所需的所有指标数据，发布到 event-bus

**改动点**:

1. **移除 `lark_client_1` import**: 不再依赖 LarkClient.runtime 读取 session store

2. **新增 `computeTranscriptTokenTotals(transcriptPath)`**:
   - 遍历 transcript JSONL 文件
   - 累加所有 `message.usage.inputTokens + outputTokens + cacheRead + cacheWrite`
   - 返回 `{inputTokens, outputTokens, cacheRead, cacheWrite, totalTokens}`
   - **注意**: cacheRead 从 `usage.cacheRead` 或 `usage.cache_read` 读取（兼容两种格式）

3. **新增 `collectFooterMetrics(entry, cfg, sessionKey)`**:
   - 从 session store entry 读取基础指标
   - 调用 `computeTranscriptTokenTotals` 获取精确 token 数据
   - 调用 `calcModelCost` 计算费用
   - 返回完整的 footer metrics 对象

4. **新增 `resolveContextWindowFromConfig(model, cfg)`**:
   - 从 `cfg.models.providers` 中查找匹配模型的 contextWindow
   - 支持模糊匹配（model 可能带 provider 前缀）

5. **重写 `getFooterSessionMetrics(sessionKey, cfg)`**:
   - 旧版: 使用 LarkClient.runtime 读取 session store
   - 新版: 使用 config-runtime API 直接读取 session store JSON 文件
   - 从 sessionKey 提取 agentId（格式 `agent:{agentId}:...`）
   - 构造路径 `~/.openclaw/agents/{agentId}/sessions/sessions.json`
   - **重要**: 不要依赖 `resolveStorePath()` 的默认值，它默认返回 main agent 的路径

6. **新增 `_publishTokenEvent(footerMetrics)`**:
   - 在 `StreamingCardController` 类上添加此方法
   - 发布 `session_tokens_accrued` 事件到 event-bus
   - payload: `{sessionKey, tokens: footerMetrics.totalTokens, timestamp}`
   - **v2026.05.03 修复**: `totalTokens` 现在包含 cacheRead + cacheWrite
     - `baseTotal = footerMetrics.totalTokens ?? (inputTokens + outputTokens)`
     - `totalTokens = baseTotal + (footerMetrics.cacheRead ?? 0) + (footerMetrics.cacheWrite ?? 0)`
     - 旧版只算 input+output，忽略 cacheRead，导致 footer 月累计比后端少 90%
   - **v2026.05.03 修复**: require 路径 `./event-bus.js` → `../channel/event-bus.js`
     - 旧版解析到 `src/card/event-bus.js`（不存在），catch 吞掉错误，事件静默丢失
   - 位置: 在 `abortCard` 方法之后、`ensureCardCreated` 方法之前

7. **三个终态路径调用 _publishTokenEvent**:
   - `onError()` — 出错时发布
   - `onIdle()` — 完成时发布
   - `abortCard()` — 中止时发布
   - 每个路径的调用位置: 在 `needsFooterMetrics()` → `collectFooterMetrics()` 之后

8. **首token延迟测量**:
   - 构造函数中: `this._transcriptStartTime = Date.now()`（捕获请求开始时间）
   - `onDeliver()` 中: `if (this._transcriptFirstTokenTs == null) this._transcriptFirstTokenTs = Date.now()`（捕获首个 token 到达时间）
   - `== null` guard 防止重复赋值
   - ftl = `_transcriptFirstTokenTs - _transcriptStartTime`

9. **needsFooterMetrics() 更新**: 检查所有 9 个 footer config 字段（status/elapsed/tokens/cache/context/model/cost/todayTokens/monthTokens）

### 4. monitor.js（3处改动）

**目的**: 启动 Token 聚合组件，确保健康检查

**改动点**:

1. **启动 TokenAggregator singleton**:
   ```javascript
   const { TokenAggregator } = require('./token-aggregator.js');
   // 在 monitorFeishuProvider() 中，WS 连接建立后启动
   ```

2. **启动 TokenAggregatorDaemon**:
   ```javascript
   const { startDaemon } = require('./token-aggregator-daemon.js');
   // 在 TokenAggregator 之后启动
   ```

3. **drainShutdownHooks 后重置守卫**:
   - 在两个 `drainShutdownHooks()` 调用后:
     ```javascript
     _tokenAggregator = null;
     _tokenAggregatorDaemonStarted = false;
     ```
   - 位置: 单账户路径和多账户路径各一处

4. **ensureHealthCheck() 看门狗**:
   - 60s 间隔检查
   - 检测 TokenAggregator.isAlive() 和 TokenAggregatorDaemon.isDaemonAlive()
   - 死了则 stop() → new → 重新订阅
   - **不注册到 drainShutdownHooks**（进程级生命周期）
   - 使用 `.unref()` 不阻止进程退出

### 5. footer-config.js（2处改动）

**目的**: 默认开启所有 footer 字段

**改动点**:

1. **DEFAULT_FOOTER_CONFIG**: 所有 9 个字段默认 `true`
   ```javascript
   {
     status: true,
     elapsed: true,
     tokens: true,
     cache: true,
     context: true,
     model: true,
     cost: true,        // 新增
     todayTokens: true,  // 新增
     monthTokens: true,  // 新增
   }
   ```

2. **resolveFooterConfig()**: 保持 merge 逻辑不变，确保新字段也参与合并

### 6. event-bus.js（新建）

**用途**: 进程级事件发布/订阅，连接 streaming-card-controller 和 token-aggregator

**API**:
- `eventBus.subscribe(event, handler)` → 返回 unsubscribe 函数
- `eventBus.publish(event, payload)`
- `eventBus.unsubscribe(event, handler)`

**事件**: `session_tokens_accrued` — payload: `{sessionKey, tokens, timestamp}`

### 7. token-aggregator.js（新建）

**用途**: 事件驱动的 Token 聚合器，订阅会话完成事件，累加到 token-stats.json

**关键逻辑**:
- `_sessionTotals` Map: sessionKey → cumulativeTotal（持久化到 token-stats.json）
- **delta = event.tokens（直接信任，不做减法）** — v2026.04.30 修复：旧版用 `event.tokens - prev`，重启后 prev > event.tokens 导致 delta=0
- `_loadedDaemonToday` / `_loadedDaemonMonth`: 启动时从文件加载的 daemon 快照，用于 Bug#10 重算公式
- `_flush()`: 30s 间隔，写入 token-stats.json
  - Bug#10 重算公式（非 Math.max）:
    - `eventPathToday = todayTokens - _loadedDaemonToday`（Event 路径贡献）
    - `globalToday = eventPathToday + currentDaemonToday`（合并 Daemon 路径）
    - `Math.max(0, ...)` 防止负值
  - 跨日检测: `dateChanged`/`monthChanged` 标志，跨日时重置 `_loadedDaemonToday=0`
  - 保留 existing.daemonToday/daemonMonth/scannedFiles/sessionTotals
- `_loadFromFile()`: 加载 sessionTotals（去重用）+ todayTokens/monthTokens（日期匹配时）+ _loadedDaemonToday/_loadedDaemonMonth 快照
- 日期辅助函数: UTC+8 偏移法（`new Date(Date.now() + SHANGHAI_OFFSET_MS)` + UTC 方法），不再用 `toLocaleString`
- `isAlive()`: 360s 无 flush 则判定死亡

**⚠️ 历史 bug（已修复）**:
- `getShanghaiDateKey()` 不要用 `.split('/')`，en-CA 返回的是 `YYYY-MM-DD`（横杠不是斜杠）
- `_onTokensAccrued` 不要用减法模式（`event.tokens - prev`），重启后 prev 是累计值、event.tokens 是单次值，delta=0 永久丢失
- 日期辅助函数改为 UTC+8 偏移法（`new Date(Date.now() + 8*3600*1000)` + UTC 方法），不再用 `toLocaleString`
- `_flush()` 跨日时必须重置 `_loadedDaemonToday=0`，否则 `eventPath = todayTokens - _loadedDaemon` 变成负数
- Bug#15: daemon 启动时必须立即写 `daemonToday=0` 到文件（在 tick() 之前），否则 aggregator 30s 内读到旧值
- Bug#16: daemon 启动写入时必须同时减去旧 daemonToday（`todayTokens -= oldDaemonToday`），否则 eventPath 被高估

### 8. token-aggregator-daemon.js（新建）

**用途**: 文件扫描 Token 聚合，扫描 cron/runs/*.jsonl，补充事件路径遗漏的 token

**关键逻辑**:
- 每 5 分钟扫描一次
- 支持 camelCase/snake_case/`ts`/`timestamp` 字段格式
- `daemonToday`/`daemonMonth` 独立跟踪
- 日期/月份边界: `lastLineIndex = 0` + `lastTotalTokens = 0` 全量重算
- **新文件必须走 recount + 日期过滤** — v2026.04.30 修复：旧版新文件从第 0 行扫描无日期过滤，把所有历史 token 算成今天
- **lastLineIndex 必须在循环顶部递进** — v2026.05.04 修复：旧版放在 continue 之后，导致被日期过滤跳过的行不递进，下次增量扫描重复计数
- flush 公式: `(global - oldDaemon) + newDaemon`
- `isDaemonAlive()`: 360s 无 flush 则判定死亡
- 不覆盖 token-stats.json 中的 `sessionTotals` 字段
- **Bug#11: 启动时强制 recount** — `currentDateKey=''` + `daemonToday=0`，触发 `dateChanged=true` 全量重算
- **Bug#15: 启动时立即写文件** — 在 `tick()` 之前写 `daemonToday=0` 到 token-stats.json，防止 aggregator 30s 内读到旧值
- **Bug#16: 启动写入时减旧值** — `existing.todayTokens -= existing.daemonToday`，防止 eventPath 被高估
- **statsPath 变量名** — 必须用 `_tokenStatsPath`（模块级变量），不能用 `statsPath`（未定义，catch 吞掉 ReferenceError）

**⚠️ 历史 bug（已修复）**:
- 新文件（fileState 里没有）必须强制 `isRecount=true` + `startOfDayMs` 日期过滤
- 否则首次启动时所有历史 cron token 都会被算成今天的
- 修复代码在 scanCronRuns() 中，约 111-121 行
- `scanJsonlFile` 中 `state.lastLineIndex = i + 1` 必须在循环顶部（continue 之前），否则被日期过滤跳过的行不递进
- 启动清理代码必须用 `_tokenStatsPath` 而非 `statsPath`，否则静默失败

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

每个文件对比 `original/` vs 新版，使用正确的路径映射：

```bash
SKILL=~/.openclaw/skills/footer-patch
BACKUP=~/.openclaw/skills/footer-patch/new-backup/$DATE

# 文件 → 路径映射（每个文件在插件中的确切位置）
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
  echo ""
  echo "❌ 有文件发生大变化！已保存 diff 到 $SKILL/diff-report.txt"
  echo "请将 diff-report.txt 发给 AI 分析修复方案。"
  echo "在 AI 确认前，不要执行后续步骤。"
  exit 1
fi
```

**判断标准**:
- 0 行差异 → ✅ 无变化，安全覆盖
- < 100 行差异 → ⚠️ 小变化，覆盖 + 提醒用户检查
- >= 100 行差异 → ❌ 大变化，**停止执行**，保存 diff，通知用户找 AI 修复

### Step 3: 检查新建文件是否冲突

新版插件可能自己新增了同名文件，覆盖前必须检查：

```bash
PLUGIN=~/.openclaw/extensions/openclaw-lark
SKILL=~/.openclaw/skills/footer-patch

for f in event-bus.js token-aggregator.js token-aggregator-daemon.js; do
  if [ -f "$PLUGIN/src/channel/$f" ]; then
    # 比较新版文件和我们的文件是否相同
    if diff "$SKILL/created/$f" "$PLUGIN/src/channel/$f" > /dev/null 2>&1; then
      echo "✅ $f: 新版有同名文件，但内容相同，跳过"
    else
      echo "❌ $f: 新版有同名文件且内容不同！"
      echo "   新版文件已备份到 $BACKUP/src/channel/$f"
      echo "   需要 AI 分析是否应该覆盖。"
      # 保存新版文件供 AI 分析
cp "$PLUGIN/src/channel/$f" "$SKILL/new-backup/$DATE/conflict-$f"
      CONFLICT=1
    fi
  else
    echo "✅ $f: 新版没有此文件，可以安全补回"
  fi
done

if [ "${CONFLICT:-0}" -eq 1 ]; then
  echo ""
  echo "❌ 有文件名冲突！请将 new-backup/$DATE/conflict-* 发给 AI 分析。"
  echo "在 AI 确认前，不要执行后续步骤。"
  exit 1
fi
```

### Step 4: 覆盖修改文件 + 补回新建文件

```bash
PLUGIN=~/.openclaw/extensions/openclaw-lark

# 覆盖 5 个修改文件
cp ~/.openclaw/skills/footer-patch/modified/builder.js "$PLUGIN/src/card/builder.js"
cp ~/.openclaw/skills/footer-patch/modified/reply-mode.js "$PLUGIN/src/card/reply-mode.js"
cp ~/.openclaw/skills/footer-patch/modified/streaming-card-controller.js "$PLUGIN/src/card/streaming-card-controller.js"
cp ~/.openclaw/skills/footer-patch/modified/monitor.js "$PLUGIN/src/channel/monitor.js"
cp ~/.openclaw/skills/footer-patch/modified/footer-config.js "$PLUGIN/src/core/footer-config.js"

# 补回 3 个新建文件
cp ~/.openclaw/skills/footer-patch/created/event-bus.js "$PLUGIN/src/channel/event-bus.js"
cp ~/.openclaw/skills/footer-patch/created/token-aggregator.js "$PLUGIN/src/channel/token-aggregator.js"
cp ~/.openclaw/skills/footer-patch/created/token-aggregator-daemon.js "$PLUGIN/src/channel/token-aggregator-daemon.js"

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
  echo ""
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
  echo "请将语法错误信息发给 AI 分析。"
  exit 1
fi
```

### Step 6: 检查 openclaw.json 配置

footer 需要 openclaw.json 中的配置才能生效：

```bash
# 检查 footer 配置是否存在
cat ~/.openclaw/openclaw.json | python3 -c "
import json, sys
cfg = json.load(sys.stdin)
footer = cfg.get('channels', {}).get('feishu', {}).get('footer', {})
required = ['status','elapsed','tokens','cache','context','model','cost','todayTokens','monthTokens']
missing = [k for k in required if not footer.get(k)]
if missing:
    print(f'⚠️ footer 配置缺少字段: {missing}')
    print('需要补全配置，否则对应字段不显示。')
else:
    print('✅ footer 配置完整')
"
```

如果缺少字段，需要 AI 修改 `~/.openclaw/openclaw.json` 中的 `channels.feishu.footer` 配置。

### Step 7: 重启 Gateway

```bash
openclaw gateway restart
```

### Step 8: 验证

1. 等 gateway 启动完成（约 30 秒）
2. 发一条消息给任意 agent
3. 等 agent 回复完成
4. 检查 footer 区域是否显示以下内容：
   - **Line1**: `🪙Token今/月: X丨X`（数字可以是 0，但文字必须出现）
   - **Line2**: `──────────────────`（分隔线）
   - **Line3**: `✅已完成` 或 `❌出错` 或 `⏹️已停止` + 耗时 + 模型名
   - **Line4**: `↑ X ↓ X` + `缓存` + `📑` + `💸` + `🚀`（至少出现 3 个）
5. 如果只显示 Line3（状态行）没有 Line1 和 Line4：
   - 检查日志: `tail -100 ~/.openclaw/logs/gateway.log | grep -iE 'error|footer|token-aggregator'`
   - 可能是 token-stats.json 不存在（首次启动需要等 30 秒 flush）
   - 可能是 session store 路径不对（看日志有无 "store not found"）
6. 检查日志有无致命错误: `tail -50 ~/.openclaw/logs/gateway.log | grep -iE 'FATAL|crash|uncaught'`

---

## 五、样式配置（恢复时可调整）

恢复补丁时，用户可以调整显示样式。以下是配置映射表：

### 用户选择 → 代码/配置改动

| 用户选择 | 改动位置 | 具体操作 |
|---------|---------|--------|
| 去掉某个字段（如不要费用） | `openclaw.json` | `footer.<字段>: false` |
| 不要分隔线 | `builder.js` | `formatFooterRuntimeSegments()` 去掉 Line 2 输出 |
| 中文状态标签 | `builder.js` | `formatFooterRuntimeSegments()` 状态字符串用中文 |
| 英文状态标签 | `builder.js` | 同上，改英文 |
| 双语状态标签 | `builder.js` | 同上，中英文拼接 |
| 粗略数字 | `builder.js` | `compactNumber()` 阈值从 1000 改回 100 |
| 改分隔线字符 | `builder.js` | `formatFooterRuntimeSegments()` 修改分隔线字符串 |

### 当前配置（主人确认）

- 全部 7 项显示（①②③④⑤⑥⑦）
- 中文状态标签（✅已完成 / ❌出错 / ⏹️停止）
- 精确数字（compactNumber 阈值 1000）
- 分隔线保留

### 修改编号总览（29 项）

| 文件 | 编号 | 修改内容 |
|------|------|----------|
| streaming-card-controller.js | 修改一 | 新增 `computeTranscriptTokenTotals()` |
| | 修改二 | 新增 `_transcriptTokenTrackers` + `_publishTokenEvent()` (v2026.04.30) |
| | 修改三 | 修改 `getFooterSessionMetrics()` 使用 transcript 数据 |
| | 修改四 | 新增 `resolveContextWindowFromConfig()` |
| | 修改五 | 修改 `calcModelCost()` 去掉 cacheWrite |
| | 修改六 | 修改 `needsFooterMetrics()` 增加 todayTokens/monthTokens/cost 门控 |
| | 修改七 | 事件发布：3 终态路径统一调用 `_publishTokenEvent()` |
| token-aggregator.js | 修改八 | 新增 `_sessionTotals` Map 持久化去重 (v2026.04.30) |
| | 修改九 | 修改 `_flush()` Bug#10 重算公式（eventPath + daemon）+ 跨日重置 _loadedDaemon |
| | 修改十 | 新增 `_lastFlushMs` + `isAlive()` 健康检查（360s 阈值） |
| | 修改二十四 | `_flush()` 增加 `_loadedDaemonToday`/`_loadedDaemonMonth` 快照 |
| | 修改二十五 | `_flush()` 跨日时重置 `_loadedDaemonToday=0` |
| | 修改二十六 | 日期辅助函数改为 UTC+8 偏移法（SHANGHAI_OFFSET_MS） |
| token-aggregator-daemon.js | 修改二十七 | Bug#15: 启动时立即写 `daemonToday=0` 到文件（tick 之前） |
| | 修改二十八 | Bug#16: 启动写入时减旧 daemonToday（`todayTokens -= oldDaemonToday`） |
| | 修改二十九 | `scanJsonlFile` lastLineIndex 递进移到循环顶部（continue 之前） |
| builder.js | 修改十一 | `compactNumber()` 阈值 100→1000 |
| | 修改十二 | Line 1 `showGlobalTokens` opt-out 门控 |
| | 修改十三 | Line 3 状态标签（emoji+中文） |
| | 修改十四 | Line 3 耗时 emoji `⏳️` |
| | 修改十五 | Line 4 First token 双语显示 |
| | 修改十六 | 上下文窗口鲁棒性修复（移除 totalTokensFresh 检查） |
| | 修改十七 | Line 2 分隔线（保留） |
| footer-config.js | 修改十八 | `DEFAULT_FOOTER_CONFIG` 9 字段默认 true |
| | 修改十九 | `resolveFooterConfig()` 增加 todayTokens/monthTokens/cost |
| monitor.js | 修改二十 | 引入并启动 TokenAggregator + Daemon 单例 |
| | 修改二十一 | 新增 `ensureHealthCheck()` 看门狗（60s，不注册到 drainShutdownHooks） |
| | 修改二十二 | `drainShutdownHooks` 后重置守卫 `_tokenAggregator=null` |
| reply-mode.js | 修改二十三 | `expandAutoMode()` 群聊改用 streaming |

---

## 六、回滚方法

如果覆盖后运行出错：

```bash
DATE=$(ls -t ~/.openclaw/skills/footer-patch/new-backup/ | head -1)
BACKUP=~/.openclaw/skills/footer-patch/new-backup/$DATE
PLUGIN=~/.openclaw/extensions/openclaw-lark

# 恢复 5 个修改文件到新版原始
for f in \
  src/card/builder.js \
  src/card/reply-mode.js \
  src/card/streaming-card-controller.js \
  src/channel/monitor.js \
  src/core/footer-config.js; do
  cp "$BACKUP/$f" "$PLUGIN/$f"
done

# 删除 3 个新建文件
rm -f "$PLUGIN/src/channel/event-bus.js"
rm -f "$PLUGIN/src/channel/token-aggregator.js"
rm -f "$PLUGIN/src/channel/token-aggregator-daemon.js"

# 重启
openclaw gateway restart
echo "✅ 已回滚，footer 补丁已移除"
```

---

## 七、依赖关系图（合并时必看）

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

**如果新建文件缺失**: streaming-card-controller.js import event-bus.js 会崩溃 → gateway 启动失败
**如果 monitor.js 未修改**: TokenAggregator 不会启动 → token-stats.json 不更新 → Line1 永远为 0
**如果 reply-mode.js 未修改**: 群聊可能用 static 模式，不显示 footer
**如果 footer-config.js 未修改**: 默认配置所有字段 false → footer 不显示

---

## 八、关键技术细节（合并时必看）

### 首token延迟
- `_transcriptStartTime`: 在 StreamingCardController 构造函数中赋值 `Date.now()`
- `_transcriptFirstTokenTs`: 在 `onDeliver()` 中首次调用时赋值 `Date.now()`
- 使用 `== null` guard 防止重复赋值
- 只在两个值都有且 `typeof ftl === 'number'` 时才显示

### getFooterSessionMetrics 路径
- **不要用 `resolveStorePath()` 默认值**，它返回 main agent 的路径
- 从 sessionKey 提取 agentId: `sessionKey.split(':')[1]`
- 构造路径: `~/.openclaw/agents/{agentId}/sessions/sessions.json`
- 如果文件不存在，返回 undefined（不要报错）

### 日期格式
- 使用 UTC+8 偏移法：`new Date(Date.now() + SHANGHAI_OFFSET_MS)` + UTC 方法（getUTCFullYear/getUTCMonth/getUTCDate）
- 返回 `YYYY-MM-DD` 格式
- **禁止使用 `toLocaleDateString()` / `toLocaleString()`** — 不同 locale 分隔符不同
- getShanghaiTimeWindow() 计算 todayStartMs/monthStartMs（用于日期过滤）

### isAlive 阈值
- TokenAggregator: 360s（30s flush × 12 倍安全系数）— v2026.05.03 修复：旧版 120s 太短，系统负载高时误判死亡
- TokenAggregatorDaemon: 360s（5min 扫描 × 1.2 倍安全系数）

### drainShutdownHooks 重置
- 在两个 `drainShutdownHooks()` 调用后必须重置:
  ```javascript
  _tokenAggregator = null;
  _tokenAggregatorDaemonStarted = false;
  ```
- 否则 WebSocket 重连后不会重新启动聚合组件

### Token 统计双路径
- **Event 路径**: Feishu 会话 → transcript JSONL → _publishTokenEvent → TokenAggregator → token-stats.json
- **Daemon 路径**: Cron/Dreaming → cron/runs JSONL → daemon 扫描 → 累加到 token-stats.json
- 两路径互补，不重复计数（通过 _sessionTotals 去重）

---

## 九、验证清单（恢复后逐项确认）

1. Gateway 启动完成（约 30 秒）
2. 检查日志出现 `[TokenAggregator] started: today=... month=...`
3. 检查日志出现 `[token-aggregator-daemon] started — scan=300s...`
4. 发送消息给任意 agent，等回复完成
5. 检查 footer 4 行是否全部显示：
   - **Line1**: `🪙Token今/月: X丨X`（数字可以是 0，文字必须出现）
   - **Line2**: `──────────────────`（分隔线）
   - **Line3**: `✅已完成` 或 `❌出错` 或 `⏹️已停止` + 耗时 + 模型名
   - **Line4**: `↑ X ↓ X` + `缓存` + `📑` + `💸` + `🚀`（至少 3 个）
6. 如果只显示 Line3 没有 Line1 和 Line4：
   - 检查日志: `tail -100 ~/.openclaw/logs/gateway.log | grep -iE 'error|footer|token-aggregator'`
   - 可能是 token-stats.json 不存在（首次启动需要等 30 秒 flush）
   - 可能是 session store 路径不对（看日志有无 "store not found"）
7. **验证群聊 Footer**：发送群聊消息，确认群聊也显示完整 Footer
8. 等 30 秒后检查 `~/.openclaw/token-stats.json` 是否更新
9. 验证双路径运行：
   - Event: `grep 'TokenAggregator.*flushed' ~/.openclaw/logs/gateway.log`
   - Daemon: `grep 'token-aggregator-daemon.*scanned' ~/.openclaw/logs/gateway.log`
10. 检查日志无致命错误: `tail -50 ~/.openclaw/logs/gateway.log | grep -iE 'FATAL|crash|uncaught'`

---

## 十、常见问题

### Q: 覆盖后 footer 不显示？
A: 检查 `openclaw.json` 中 `channels.feishu.footer` 配置。所有 9 个字段应为 `true`。

### Q: Token 今/月显示为 0？
A: 正常。token-stats.json 需要至少一次完整 flush（30秒）才会更新。首次启动时为 0。

### Q: 费用不显示？
A: 需要模型配置中有 `cost` 字段（input/output/cacheRead 单价）。如果模型没有定价配置，费用显示为 0 会被隐藏。如 xiaomi-coding 免费模型，费用永远不显示——这是正常的。

### Q: 插件版本号变了但文件没变？
A: 直接覆盖即可，无需担心兼容性。

### Q: 新版插件已经有 footer 功能了？
A: 如果新版已经包含我们的全部功能，可以不打补丁。但如果新版 footer 不够全面（比如只有 2 行、没有中文标签、没有 token 累计），仍然建议打补丁。

### Q: 新版插件自己加了 event-bus.js / token-aggregator.js？
A: 这就是 Step 3 检查冲突的原因。如果冲突了，需要 AI 对比新版文件和我们的文件，决定是合并还是覆盖。新版可能有更好的实现。

### Q: 覆盖后 gateway 启动崩溃？
A: 最常见原因是 event-bus.js 没有被补回（新建文件被插件升级删除了）。检查 `$PLUGIN/src/channel/event-bus.js` 是否存在。

### Q: 恢复后只显示 Line3（状态行），没有 Line1 和 Line4？
A: 三种可能：
1. token-stats.json 不存在 → 等 30 秒再试
2. session store 路径不对 → 看日志有无 "store not found"
3. 模型没有 cost 配置 → 费用行会跳过，但其他行应该还在

### Q: 我想恢复到完全不打补丁的状态？
A: 用 `new-backup/` 里的文件覆盖回去，删除 3 个新建文件，重启 gateway。见「六、回滚方法」。

### Q: 多个 agent 都需要 footer 吗？
A: 补丁是插件级的，所有 agent 共享。打一次补丁，所有 agent 的卡片都有 footer。

### Q: 想改样式（比如去掉分隔线、换英文标签）？
A: 恢复补丁时告诉 AI 你的选择，AI 会按「五、样式配置」的映射表修改对应代码。不需要重新部署全部 8 个文件。

### Q: 双路径（Event + Daemon）怎么确认都在运行？
A: 检查日志：
- Event 路径：`grep 'TokenAggregator.*flushed' ~/.openclaw/logs/gateway.log`
- Daemon 路径：`grep 'token-aggregator-daemon.*scanned' ~/.openclaw/logs/gateway.log`
- 健康检查：`grep 'health-check' ~/.openclaw/logs/gateway.log`
三个都应该有输出。

### Q: token-stats.json 数据准不准？
A: 验证方法：对比 `token-stats.json` 中的增量与 API 后台计费数据。Event 路径覆盖 Feishu 实时会话，Daemon 路径覆盖 cron/dreaming。如果只有一边有数据，另一边可能没启动。

---

## 十一、禁止事项

- ❌ 禁止修改 openclaw-lark 插件目录以外的任何文件
- ❌ 禁止跳过语法验证步骤
- ❌ 禁止在用户未确认前覆盖任何文件
- ❌ 禁止修改本文档中未列出的文件或函数
- ❌ 禁止假设目标机器的路径、版本、配置与当前机器相同
- ❌ 禁止同时扫描 agents/ 和 cron/runs/ 导致双重计数
- ❌ 禁止将旧版代码作为修改依据（修改和新建文件以 SKILL.md 里的 `modified/` 和 `created/` 为准）

---

## 十二、已知问题

| 版本 | 问题 | 状态 | 修复方式 |
|------|------|------|----------|
| v2026.04.29 | WebSocket 重连后 token 统计永久中断 | ✅ 已修复 | monitor.js 修改二十二：drainShutdownHooks 后重置守卫 |
| v2026.04.29 | Error/Abort 路径 token 丢失 | ✅ 已修复 | streaming-card-controller.js 修改七：3 终态统一发布事件 |
| v2026.04.30 | Gateway 重启后首次 token 不增长 | ✅ 已修复 | 修改二 delta=currentTotal + 修改八信任 event.tokens |
| v2026.04.30 | 日期/月份边界后 daemon 停止增长 | ✅ 已修复 | daemon recount 时 `s.lastLineIndex = 0` |
| 当前 | ⑥ 费用不显示（模型 cost 全为 0） | ⚠️ 需配置 | `openclaw.json` 中 `models.providers` 添加 cost 字段 |
| 当前 | ⑦ 首 token 不显示 | ✅ 已修复 | streaming-card-controller.js 构造函数 + onDeliver |
| v2026.04.30 | Event 路径 require 路径错误（`./event-bus.js` → `../channel/event-bus.js`） | ✅ 已修复 | streaming-card-controller.js 中 import 路径改为 `../channel/event-bus.js` |
| v2026.04.30 | TokenAggregator `_onTokensAccrued` 减法模式导致重启后 token 丢失 | ✅ 已修复 | 改为直接信任 `delta = event.tokens`，不做 `event.tokens - prev` 减法 |
| v2026.04.30 | Daemon 新文件未做日期过滤，历史 token 算成今天的 | ✅ 已修复 | scanCronRuns() 中新文件强制 `isRecount=true` + `startOfDayMs` 过滤 |
| 当前 | 月累计基数（如 195M）跨月会丢失 | ⚠️ 正常行为 | 每月 1 日 daemon 重置 daemonMonth=0，monthTokens 从 0 开始。需手动初始化保留历史 |
| v2026.05.04 | 跨日时 _flush() 今天 token 不归零（Bug#10） | ✅ 已修复 | token-aggregator.js: _flush() 增加 dateChanged/monthChanged 标志，跨日时重置 _loadedDaemonToday=0 |
| v2026.05.04 | daemon 启动后 aggregator 读到旧 daemonToday（Bug#15） | ✅ 已修复 | token-aggregator-daemon.js: 启动时在 tick() 之前立即写 daemonToday=0 到文件 |
| v2026.05.04 | daemon 启动写入导致 todayTokens 被高估（Bug#16） | ✅ 已修复 | token-aggregator-daemon.js: 启动写入时同时减去旧 daemonToday（todayTokens -= oldDaemonToday） |
| v2026.05.04 | scanJsonlFile lastLineIndex 不递进导致重复计数（Bug B） | ✅ 已修复 | token-aggregator-daemon.js: lastLineIndex = i + 1 移到循环顶部（continue 之前） |
| v2026.05.04 | 启动清理代码 statsPath 变量未定义静默失败 | ✅ 已修复 | token-aggregator-daemon.js: statsPath → _tokenStatsPath |
| v2026.05.04 | 日期辅助函数 toLocaleString 跨平台不一致 | ✅ 已修复 | 两个 aggregator 文件: 改用 UTC+8 偏移法（SHANGHAI_OFFSET_MS） |
