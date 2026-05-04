# OpenClaw Skill: 飞书卡片 Footer 全量显示补丁

> 飞书卡片 Footer 完整显示 Token 累计消耗、回复时间、耗时、模型、输入输出 Token、缓存命中率、上下文用量、首 token 延迟。

**适用插件版本**: openclaw-lark 2026.4.10
**补丁版本**: v1.3（2026-05-03）  
**适配 OpenClaw**: 2026.4.23+  
**当前 Skill 版本**: v1.2

---

## 效果预览

```
🪙Token今/月: 73.7M丨188.9M · 04/27-22:15
──────────────────
✅已完成 · ⏳️ 12m 32s · xiaomi-coding/mimo-v2.5-pro
↑ 37.8k ↓ 95 · 缓存 1.9k/0 (5%) · 📑 39.7k/205k (19%) · 💸 $0.3379 · 🚀首token 611.64s
```

## 功能特性

- **4 行完整 Footer**：Token 今/月累计 → 分隔线 → 状态·耗时·模型 → Token 详情·缓存·上下文·费用·首 token 延迟
- **双路径 Token 计数**：Event 路径（实时 Feishu 会话）+ Daemon 路径（cron/dreaming 文件扫描），互补覆盖不重复
- **跨 Gateway 重启去重**：`_sessionTotals` 持久化到 `token-stats.json`，重启后从文件恢复
- **健康检查自愈**：60s 看门狗自动检测并重启死掉的聚合组件
- **中文状态标签**：✅已完成 / ❌出错 / ⏹️已停止
- **精确数字**：compactNumber 阈值 1000（1,234 显示为 1.2k，不是 1k）

## 文件结构

```
├── SKILL.md              # 12 章恢复指南（AI 读取用）
├── original/             # 5 个插件原始文件（备份用，对比差异用）
│   ├── builder.js
│   ├── footer-config.js
│   ├── monitor.js
│   ├── reply-mode.js
│   └── streaming-card-controller.js
├── modified/             # 5 个打好补丁的文件（覆盖到插件目录）
│   ├── builder.js
│   ├── footer-config.js
│   ├── monitor.js
│   ├── reply-mode.js
│   └── streaming-card-controller.js
├── created/              # 3 个新建文件（补到插件目录）
│   ├── event-bus.js
│   ├── token-aggregator.js
│   └── token-aggregator-daemon.js
└── new-backup/           # 恢复时自动备份新版插件文件
```

## 使用方法

### 安装（克隆到 skills 目录）

```bash
gh repo clone moduat/openclaw-skill-footer-patch ~/.openclaw/skills/footer-patch
```

### 恢复补丁

当 openclaw-lark 插件升级后，Footer 功能会被覆盖。对 AI 说：

> **"footer 补丁需要恢复"**

AI 会读取 `SKILL.md`，按 8 步流程自动完成恢复：
1. 备份新版文件
2. 对比差异
3. 检查冲突
4. 覆盖 5 个修改文件 + 补回 3 个新建文件
5. 语法检查 + 自动回滚
6. 检查 openclaw.json 配置
7. 重启 Gateway
8. 验证 Footer 显示

### 手动回滚

如果补丁导致问题，用 `new-backup/` 里的文件恢复：

```bash
BACKUP=~/.openclaw/skills/footer-patch/new-backup/<最新日期>
PLUGIN=~/.openclaw/extensions/openclaw-lark

# 恢复修改文件
for f in src/card/builder.js src/card/reply-mode.js src/card/streaming-card-controller.js src/channel/monitor.js src/core/footer-config.js; do
  cp "$BACKUP/$f" "$PLUGIN/$f"
done

# 删除新建文件
rm -f "$PLUGIN/src/channel/event-bus.js" "$PLUGIN/src/channel/token-aggregator.js" "$PLUGIN/src/channel/token-aggregator-daemon.js"

openclaw gateway restart
```

## 样式自定义

恢复时可以调整显示样式：

| 选项 | 说明 |
|------|------|
| 去掉某个字段 | `openclaw.json` 中 `footer.<字段>: false` |
| 英文状态标签 | `builder.js` 中改状态字符串 |
| 粗略数字 | `builder.js` 中 compactNumber 阈值改回 100 |
| 去掉分隔线 | `builder.js` 中去掉 Line 2 输出 |

## 已知问题

| 问题 | 状态 | 说明 |
|------|------|------|
| 费用不显示（模型 cost 全为 0） | ⚠️ 需配置 | `openclaw.json` 中 `models.providers` 添加 cost 字段 |
| Token 今/月首次为 0 | ✅ 正常 | 等待首次 flush（30秒）后更新 |
| WebSocket 重连后统计中断 | ✅ 已修复 | drainShutdownHooks 后重置守卫 |
| Error/Abort 路径 token 丢失 | ✅ 已修复 | 3 终态统一发布事件 |

## 部署文档

详细架构和修改说明见飞书文档：  
https://wxuuvv5r88d.feishu.cn/docx/CedkdiDevoeslxxuM0pcdeQAnte

## License

MIT（插件源码来自 openclaw-lark，MIT licensed by ByteDance Ltd.）
