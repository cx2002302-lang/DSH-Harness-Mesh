# 多 Harness 适配架构（一个 IP / 一个端口 / 多个 harness）

> 2026-10-17 13:30 | 状态：架构定版，workbuddy 已实现，zcode/kimicode/opencode 留空待接

## 1. 目标与约束

| 项 | 要求 |
|---|---|
| 端口 | **唯一 7080**（一个 IP 一个端口，不为每个 harness 开新端口） |
| 客户端 | DSH 主控侧、未来的 zcode / kimicode / opencode 等，**共用同一插头协议** |
| 隔离 | 不同 harness 的插头互不干扰；一个挂了不影响其他 |
| 扩展 | 接新 harness = **加一条 plug 配置 + 一个 adapter 文件**，不改协议、不改 harnessd 主逻辑 |
| 兼容 | 现有 `plugId=node-win-01-workbuddy` 必须继续可用（DSH 在用，不能断） |

## 2. 核心概念

```
harness（能力域，如 workbuddy / zcode / opencode）
  └── plug（插头，一个可 spawn 的命令，是该 harness 的一个能力）
        ├── exec  : 派任务执行（ACP 协议）
        └── ui    : 操控界面（行协议，如 wb-ui）
```

**规则**：
- `plugId` 全局唯一，命名 `<harness>-<capability>`（如 `workbuddy-exec`、`workbuddy-ui`）
- `harness` 字段标识归属能力域
- `capabilities` 声明该插头能力（exec / ui / 其他）
- `enabled: false` 或 `command: null` = **预留未实现**（hello 里可见，task.open 报明确错误）

## 3. plugs.json 结构（定版）

```json
[
  {
    "plugId": "workbuddy-exec",
    "harness": "workbuddy",
    "capabilities": ["exec"],
    "kind": "acp",
    "command": "<pythonw.exe>",
    "args": ["<wb-gateway-adapter.py>"],
    "aliases": ["node-win-01-workbuddy"],
    "enabled": true,
    "env": {...}
  },
  {
    "plugId": "workbuddy-ui",
    "harness": "workbuddy",
    "capabilities": ["ui"],
    "kind": "line",
    "command": "<node.exe>",
    "args": ["<wb-ui.js>"],
    "aliases": ["wb-ui"],
    "enabled": true,
    "env": {"WB_CDP_PORT": "9222"}
  },
  {
    "plugId": "zcode-exec", "harness": "zcode", "capabilities": ["exec"],
    "kind": "acp", "command": null, "args": [], "enabled": false,
    "note": "待接：zcode CLI/API 适配器"
  },
  {
    "plugId": "kimicode-exec", "harness": "kimicode", "capabilities": ["exec"],
    "kind": "acp", "command": null, "args": [], "enabled": false,
    "note": "待接：kimicode 适配器"
  },
  {
    "plugId": "opencode-exec", "harness": "opencode", "capabilities": ["exec"],
    "kind": "acp", "command": null, "args": [], "enabled": false,
    "note": "待接：opencode 适配器（DSH 已做过直连验证）"
  }
]
```

## 4. harnessd 侧行为（需要的最小改动）

| 场景 | 行为 |
|---|---|
| `hello` | 返回全部 plug（含 harness/capabilities/enabled/note），客户端可据此发现能力 |
| `task.open(plugId)` | 1) 按 plugId 精确匹配 2) 按 aliases 匹配 3) **找不到回退默认 plug**（保持旧行为） |
| `task.open` 命中的 plug `enabled=false` | 返回明确错误 `plug disabled: <note>`（不 spawn，不静默失败） |
| `task.open` 命中的 plug `command=null` | 返回 `plug not configured: <note>` |

**兼容策略**：现有 `node-win-01-workbuddy` 放进 `aliases`，DSH 侧零改动。

## 5. 接一个新 harness 的步骤（SOP）

1. 写 `<harness>-adapter.py`（或 .js），实现 ACP stdio（initialize / session-new / prompt / cancel）
2. plugs.json 加一条：`plugId: <harness>-exec`，填 command/args，`enabled: true`
3. 重载 plugs（重启 harnessd 或 hot-reload）
4. 验证：`hello` 能看到 → `task.open` 能起 → `prompt` 能回
5. 共享侧 changelog + 对齐表补一行

**不改动**：harnessd_win 主逻辑、插头协议、7080 端口、DSH 侧除节点表外的任何东西。

## 6. 当前状态

| harness | exec | ui | 状态 |
|---|---|---|---|
| workbuddy | ✅ wb-gateway-adapter (v5.2.1) | ✅ wb-ui.js（status/sessions/screenshot 已验） | 已通 |
| zcode | — | — | 预留（enabled=false） |
| kimicode | — | — | 预留（enabled=false） |
| opencode | — | — | 预留（enabled=false；DSH 侧已有直连经验可复用） |

## 7. 风险与边界

- **一个 harness 崩不影响其他**：每个 plug 独立 spawn 进程，进程级隔离
- **资源**：每个执行中的插件一个进程（适配器有空闲自退 600s，防堆积）
- **安全**：7080 只监听内网/隧道（0.0.0.0 但受 ANN 隧道访问控制）；插头能力差异由 enabled + command 控制
- **UI 类插头**（wb-ui）需要 WorkBuddy 带 `--remote-debugging-port=9222` 启动
