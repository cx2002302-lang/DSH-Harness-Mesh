# 多 Harness 统一配置能力清单（给 DSH 与未来 harness）

> 2026-10-17 14:01 | 用途：**新 harness 接入的统一配置模板 + 能力矩阵 + 接口适配性检查**
> 前置阅读：`多Harness适配架构.md`（架构）| `wb-ui-命令契约.md`（workbuddy UI 命令细节）

---

## 一、统一配置 schema（plugs.json 单条）

```jsonc
{
  "plugId": "<harness>-<capability>",   // 全局唯一，如 workbuddy-exec
  "harness": "<harness>",                // 能力域：workbuddy / zcode / kimicode / opencode
  "capabilities": ["exec"],              // exec（派任务）| ui（界面操控）| 其他自定义
  "kind": "acp",                         // acp（ACP 协议）| line（裸行协议 JSON）
  "command": "<可执行文件绝对路径>",       // null = 未配置
  "args": ["<脚本路径>", "..."],
  "aliases": ["<旧 plugId>"],            // 兼容旧名（可选）
  "enabled": true,                       // false = 预留未接（task.open 会明确拒绝）
  "note": "<待接说明>",                   // enabled=false 时必填
  "model": null,                         // 可选：强制模型
  "env": {}                              // 可选：环境变量
}
```

**规则**
| 规则 | 说明 |
|---|---|
| plugId 命名 | `<harness>-<capability>`，全小写中划线 |
| kind=acp | 适配器需实现 ACP：`initialize` / `session/new` / `session/prompt` / `cancel` |
| kind=line | 适配器只需 **stdin 每行一个 JSON → stdout 每行一个 JSON** |
| enabled=false | `hello` 可见（带 note），`task.open` 返回 `plug disabled: <note>`；**不静默回退** |
| 未知 plugId | 回退到第一个 enabled 且有 command 的插头（兼容旧行为） |

---

## 二、当前 4 个 harness 配置（workbuddy 完整，其余为模板）

### 2.1 workbuddy（已实现，可直接复制改）

```jsonc
// ① 执行口（ACP）
{"plugId":"workbuddy-exec","harness":"workbuddy","capabilities":["exec"],"kind":"acp",
 "command":"C:\\Users\\Administrator\\.workbuddy\\binaries\\python\\versions\\3.13.12\\pythonw.exe",
 "args":["C:\\wb-mesh\\wb-gateway-adapter.py"],
 "aliases":["CHINAMI-EKC4J2J-workbuddy"],"enabled":true,
 "env":{"ADAPTER_MAX_TURN_WAIT":"1800","PYTHONIOENCODING":"utf-8"}}

// ② 界面口（行协议）
{"plugId":"workbuddy-ui","harness":"workbuddy","capabilities":["ui"],"kind":"line",
 "command":"C:\\Users\\Administrator\\.workbuddy\\binaries\\node\\versions\\22.22.2-6\\node.exe",
 "args":["C:\\wb-mesh\\wb-ui.js"],"aliases":["wb-ui"],"enabled":true,
 "env":{"WB_CDP_PORT":"9222"}}
```

### 2.2 zcode / kimicode / opencode（留空模板）

```jsonc
// 接的时候只改 3 处：command、args、enabled
{"plugId":"zcode-exec","harness":"zcode","capabilities":["exec"],"kind":"acp",
 "command":null,"args":[],"enabled":false,
 "note":"待接：写 zcode-adapter.py 后填 command + enabled=true"}

{"plugId":"kimicode-exec","harness":"kimicode","capabilities":["exec"],"kind":"acp",
 "command":null,"args":[],"enabled":false,"note":"待接：kimicode 适配器"}

{"plugId":"opencode-exec","harness":"opencode","capabilities":["exec"],"kind":"acp",
 "command":null,"args":[],"enabled":false,"note":"待接：opencode 适配器（DSH 侧已有直连经验）"}
```

---

## 三、能力矩阵（新 harness 该配哪些插头）

| 能力域 | exec（派任务） | ui（界面操控） | 说明 |
|---|---|---|---|
| **workbuddy** | ✅ ACP（`workbuddy-exec`） | ✅ line（`workbuddy-ui`，9 命令） | 双插头已验证 |
| zcode | 待接 | 视其他是否有 UI | 按需 |
| kimicode | 待接 | — | 按需 |
| opencode | 待接 | — | DSH 已有直连经验可复用 |

**UI 能力命令集（workbuddy-ui 已实现 9 个）**：
`status` / `sessions` / `screenshot` / `model` / `new-session` / `switch-session` / `delete-session` / `rename` / `send`
> 其他 harness 若也有 UI，建议对齐这套命令命名，DSH 侧工具可复用同一套 wrapper。

---

## 四、接口适配性检查（本轮结论）

### 4.1 一致性 ✅

| 检查项 | 结论 |
|---|---|
| 失败返回结构 | 统一 `{"ok":false,"cmd":"<cmd>","error":"<原因>"}` ✅ |
| 成功返回结构 | 统一 `{"ok":true,"cmd":"<cmd>", ...业务字段}` ✅ |
| 入参命名 | 会话类统一 `name`；文本统一 `text`；路径统一 `out`；新名 `newName` ✅ |
| plugId 兼容 | 旧 `CHINAMI-EKC4J2J-workbuddy` 通过 `aliases` 保留 ✅ |
| 未启用拦截 | `enabled=false` 返回明确错误，不静默回退 ✅ |
| kind 自动识别 | DSH 侧 `plug.list` 拿 kind → `line` 自动切裸行协议，`acp` 走握手 ✅ |

### 4.2 已知不一致 / 待改进 🟡

| # | 问题 | 影响 | 建议 |
|---|---|---|---|
| 1 | `delete-session` 返回 `action:"MENU"`，而 `switch-session` 返回 `action:"CLICKED"` | 调用方需按命令分别判断 action 值 | 契约里已写明；或统一为 `action:"<cmd>_DONE"` |
| 2 | `send` 的 CDP 版与 API 版返回结构不同（API 版无 `action`，有 `runId/status/elapsed`） | 调用方要分支处理 | **建议统一用 API 版**（契约已标注） |
| 3 | `status.engineBusy` 是**全局 UI 态**，不按会话隔离 | 多会话场景下误判"某会话忙" | 契约已写明；需要精确时用 gateway `/api/v1/status` |
| 4 | `sessions` 只返回数量/标题，无稳定 ID | 调用方只能用标题模糊匹配 | 可接受（标题唯一性由用户保证）；未来可补 conversationId |
| 5 | **CDP 与用户操作冲突**（见第五节） | 用户正在用 WorkBuddy 时操作可能失败 | 加"重试 + 状态校验"（见下） |

### 4.3 第五节：CDP 冲突（老徐提出的实际问题）

**现象**：用户正在操作 WorkBuddy（切换会话/输入）时，wb-ui 的 CDP 操作可能失败或产生偏差。

**原因**：CDP 操作基于"操作瞬间的 DOM 快照"，用户同时操作会改变 DOM。

**已加/建议的加固**：
1. **操作前校验**：switch/delete/rename 先确认目标卡片存在且 rect 有效，不存在返回 `NOT_FOUND`
2. **失败重试**：建议加 2 次重试（间隔 1s），仍失败返回 `UI_CONFLICT` 明确错误
3. **调用方策略**：DSH 侧遇到 `UI_CONFLICT` 应**延后重试**，不要当永久失败
4. **最佳实践**：**写操作（switch/new/delete/rename）尽量在用户不操作时进行**；读操作（status/sessions/screenshot）不受影响

---

## 五、接入新 harness 的检查清单（10 项）

- [ ] 1. plugId 按 `<harness>-<capability>` 命名
- [ ] 2. `harness` 字段填能力域名
- [ ] 3. `kind` 选对（acp / line）
- [ ] 4. command 用**绝对路径**（pythonw/node，不用控制台版，避免弹窗）
- [ ] 5. 适配器**全程无窗**（CREATE_NO_WINDOW / windowsHide）
- [ ] 6. 适配器有**空闲自退**（防进程堆积，建议 600s）
- [ ] 7. 适配器写**文件日志**（stdout 在 pythonw 下不可见）
- [ ] 8. 失败返回统一 `{"ok":false,"error":"..."}`
- [ ] 9. `hello` 里能正确列出（enabled/capabilities/note）
- [ ] 10. `task.open` → `attach` → 发一条 → 能收到回包（端到端）
