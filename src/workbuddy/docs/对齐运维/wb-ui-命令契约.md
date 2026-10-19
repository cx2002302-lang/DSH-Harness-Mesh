# wb-ui 命令契约表 v2（最终版）

> 更新：2026-10-17 13:57 | 实现：`C:\wb-mesh\wb-ui.js`（同步副本 `D:\AgentHome\DshData\wb-green\wb-ui.js`）
> 协议：stdin 每行 `{cmd, ...}` → stdout 每行 `{ok, ...}`；失败统一 `{"ok":false,"cmd":"<cmd>","error":"<原因>"}`
> 调用入口：插头 `plugId="wb-ui"`（kind:line）→ `task.open` → `attach` → 发 JSON 行

## 〇、核心原则（老徐定）

**能走命令/接口的就不用 CDP**（避免影响用户前台使用）。下表标注每个命令的实现方式与界面影响：

| 实现方式 | 命令 | 对界面影响 |
|---|---|---|
| **HTTP API**（零界面） | `send` | **完全不动界面** |
| **CDP 只读**（不动界面） | `status` `sessions` `screenshot` | **不动界面**（纯读渲染数据） |
| **CDP 写操作**（改状态但不抢焦点） | `switch-session` `new-session` `delete-session` `rename` `model(set)` | 改 WorkBuddy 状态；**实测最小化下可用且不抢焦点** |

> WorkBuddy 只开放了"派任务"HTTP 接口，**没有会话管理 API**——所以会话类操作只能走 CDP（已实测不打扰用户）。

## 一、命令全集（9 个）

| cmd | 实现 | 必填入参 | 出参主要字段 | 状态 |
|---|---|---|---|---|
| `status` | CDP 只读 | 无 | `model` `sessions`(数) `hasInput` `title` `engineBusy` `sendEnabled` | ✅ |
| `sessions` | CDP 只读 | 无 | `sessions[{title,meta,selected}]` | ✅ |
| `screenshot` | CDP 只读 | `out`(可选) | `path` `bytes` | ✅ |
| `model` | CDP | `set`(可选，省略=只读) | 读:`model`；写:`opened` `pick` `current` | ✅ |
| `new-session` | CDP | `model`(可选，新建后自动切) | `action:"CTRL_N"` `modelSwitched` `currentModel` `sessions` | ✅ |
| `switch-session` | CDP | **`name`** | `action` `clickedAt` `selected` | ✅ |
| `delete-session` | CDP | **`name`**、`confirm`(默认 false=dry-run) | `action:"MENU"` `menuItems[]` `deleted` | ✅ dry-run / 🟡 真删未生产验证 |
| `rename` | CDP | **`name`**、**`newName`** | `action:"RENAME_ATTEMPTED"` `filled` `sessions` | ✅ |
| **`send`** | **HTTP API** | **`text`** | `ok` `runId` `status` `elapsed` `text`(回复内容) | ✅ **已实测** |

## 二、send（API 版）详细契约

```json
// 请求
{"cmd":"send","text":"只回复 API-SEND-OK"}

// 成功返回（实测）
{"ok":true,"cmd":"send","runId":"ba399d58-...","status":"completed",
 "elapsed":52.3,"text":"API-SEND-OK"}
```

- 底层：`send_via_api.py` → `POST /api/v1/runs` → 接 SSE 等终态（**零 CDP**）
- `status` 值：`completed` / `failed` / `cancelled` / `timeout`
- `elapsed`：秒；引擎忙时含排队时间（实测 52.3s，其中大部分是排队）
- **注意**：任务会进入 **WorkBuddy 当前会话**（附会话语义），会带上当前对话上下文
- 超时：默认 180s，可通过 Python 脚本 `--timeout N` 调整

## 三、语义口径

| 字段 | 口径 | 用法 |
|---|---|---|
| `engineBusy` | 页面出现"停止/取消生成"按钮即 true，**全局态**（不按会话隔离） | true → 派活会排队，**等，别当失败** |
| `sendEnabled` | 发送按钮存在且可点 | 仅 CDP 版 send 有用；API 版忽略 |
| `sessions` | 当前账号可见任务卡片数 | 规模感知，不是 ID 列表 |

## 四、实现要点（稳定性依据）

- **选择器只用稳定锚点**：`.cb-agent-card`、`_selected_`、`aria-label` —— 不依赖易变 class
- **点击一律走 CDP 真实鼠标事件**（`Input.dispatchMouseEvent`：moved→pressed→released）——`element.click()` 对 React 无效
- **会话切换后自校验**（读 `_selected_`），不是"点完就报成功"
- **发送按钮定位**：`div.cr-input-toolbar__send` 内的 button；**引擎忙时它是"停止"键**（aria-label），API 版 send 不涉及此问题
- **新建会话用 Ctrl+N**（真实点按钮会撞到卡片右键菜单）
- **不抢焦点**：最小化状态下连续采样验证（60ms/次），操作期间 WorkBuddy 变前台 0 次、被还原 0 次

## 五、多 harness 扩展（当前状态）

| harness | exec 插头 | ui 插头 | 状态 |
|---|---|---|---|
| workbuddy | `workbuddy-exec`（ACP） | `workbuddy-ui`（line） | ✅ 全通 |
| zcode | `zcode-exec` | — | enabled=false 待接 |
| kimicode | `kimicode-exec` | — | enabled=false 待接 |
| opencode | `opencode-exec` | — | enabled=false 待接 |

接新 harness：写 `<harness>-adapter.py` → plugs 加一条 `{plugId:"<harness>-exec", harness, capabilities, enabled, command, args}` → 重载 harnessd。

## 六、变更记录

- **2026-10-17 13:57 v2**：send 改为 HTTP API 版（零 CDP，实测 52.3s 返回 API-SEND-OK）；新增 rename；补"实现方式/界面影响"标注；补多 harness 状态。
- 2026-10-17 13:38 v1：初版 8 命令契约（自动盯 agent 起草）。
