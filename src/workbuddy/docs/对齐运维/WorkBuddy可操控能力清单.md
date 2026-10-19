# WorkBuddy 可操控能力清单（给 DSH 主 harness）

> 生成时间：2026-10-17 11:18 | 验证方式：CDP 实测（WorkBuddy 5.8.3 / Electron 37.10.3）
> 前置条件：WorkBuddy 以 `--remote-debugging-port=9222` 启动（已在此机器启用）

## 一、能力总览

| # | 能力 | 通道 | 状态 |
|---|---|---|---|
| 1 | 派生任务（隔离 runs） | HTTP `POST /api/v1/runs` | ✅ 已验证（含 4 层隔离：独立 runId/SSE/会话） |
| 2 | 查任务状态/结果流 | HTTP `GET /api/v1/runs/:id` `/stream` | ✅ 已验证（事件 `{status,content.markdown,agent}`） |
| 3 | 取消任务 | HTTP `POST /api/v1/runs/:id/cancel` | ⚠️ 端点存在，行为待验证 |
| 4 | ACP 会话协议 | HTTP `GET/POST /api/v1/acp` | ✅ 已验证（免密，附会话） |
| 5 | **读 UI 状态**（会话列表/当前模型/页面文本） | CDP `Runtime.evaluate` | ✅ 已实测 |
| 6 | **截图**（任意时刻界面） | CDP `Page.captureScreenshot` | ✅ 已实测 |
| 7 | **点击任意元素**（tab/按钮/菜单） | CDP `Runtime.evaluate` + `.click()` | ✅ 已实测 |
| 8 | **切换模型** | CDP（点模型选择器） | ✅ **已实测（Step-5-Preview → Deepseek-V4.1-Flash）** |
| 9 | 新建会话 | CDP（需确认按钮路径） | 🟡 通道具备，路径待标定 |
| 10 | 会话列表/切换/重命名/删除 | CDP | 🟡 通道具备，路径待标定 |
| 11 | 输入并发送消息（GUI 方式） | CDP | 🟡 通道具备，路径待标定 |
| 12 | 读/改 WorkBuddy 配置 | 文件系统 `~/.workbuddy/*` | ✅ 已验证（models.json 等） |

## 二、通道说明

### A. HTTP Gateway（推荐，稳定）
- 地址：`http://127.0.0.1:<动态端口>`（每次启动变，需自动发现）
- 鉴权：`Authorization: Bearer <CODEBUDDY_GATEWAY_PASSWORD>`（从 serve 进程 env 读取，PEB 方式，已实测）
- 端点全集（OpenAPI 无独立文档端点，来自首页）：
  ```
  GET  /api/v1/health
  GET  /api/v1/status            → {busy, runStatus, activeSessionId}
  POST /api/v1/runs              → {runId}
  GET  /api/v1/runs/:runId       → {runId, active}
  GET  /api/v1/runs/:runId/stream → SSE: {status, content:{markdown}, agent:{sessionId,toolCalls}}
  POST /api/v1/runs/:runId/cancel
  POST /api/v1/acp               （ACP over HTTP：GET 建流→POST 发消息，响应体 SSE）
  POST /api/v1/webhooks/:platform （飞书/企微等入站模拟）
  ```
- **限制**：`runs` 会附到当前活跃会话（非独立会话）；执行引擎**单线程**（busy 时任务排队）

### B. CDP（UI 操控，能力上限更高，但脆弱）
- 端点：`http://127.0.0.1:9222/json/list` → 取 `webSocketDebuggerUrl`
- 核心方法：`Runtime.evaluate`（执行任意 JS）、`Page.captureScreenshot`
- 已验证可读写**整个 React 应用状态**（DOM/A11y/事件）
- **注意**：需 WorkBuddy 带 `--remote-debugging-port=9222` 启动；UI 改版会破坏元素定位

## 三、调用接口草案（WinPC 侧待实现）

建议封装 `wb-ui.py`（CDP 客户端，零依赖），供 DSH 经 harnessd 调用：

```
wb-ui.py list-sessions                    # 列出会话（名称/时间/ID）
wb-ui.py new-session [--title T]          # 新建会话
wb-ui.py switch-session <name|id>         # 切换会话
wb-ui.py delete-session <name|id>         # 删除会话
wb-ui.py rename-session <name> <new>      # 重命名
wb-ui.py model [--set NAME]               # 读/设当前模型
wb-ui.py send <session> <text>            # 在指定会话发消息
wb-ui.py screenshot [--out path]          # 截图
wb-ui.py status                           # JSON：模型/会话/引擎状态
```

DSH 侧接入方式（两种，任选）：
1. **MCP 工具**：把上述能力包装成 `wb_ui_*` 工具（推荐，和现有 harness-mesh 一致）
2. **HTTP 本地服务**：`wb-ui serve --port 7788`，DSH 直接 HTTP 调用

## 四、已验证的关键事实（供决策）

1. **WorkBuddy 会话的模型 ≠ AI 助理的模型**：UI 右下角显示的是**会话模型**（原 Step-5-Preview），助手层模型是另一套（DeepSeek V4.1 Flash）。429 来自会话模型配额。
2. **切模型可用 CDP 完成**：点模型选择器 → 选 `Deepseek-V4.1-Flash`，实测成功。
3. **执行引擎单线程**：`status.busy=true` 时新 run 排队；**派任务前应先查 busy**（接口应内置"等空闲"策略）。
4. **gateway 端口动态**：每次 WorkBuddy 重启变（已实测 5845→3884→7909→3586→1934→1546→8659→13402→...），必须自动发现。
5. **密码是池级独立**：多池并存时每个池一个密码（PEB 读，已实现自适应读取大小）。

## 五、风险与边界

- CDP 通道**高权限**（等于能执行任意 JS），仅限本机/可信网络
- UI 自动化对版本敏感（WorkBuddy 升级可能改 class/结构）
- 不支持绕过产品逻辑（如伪造登录、跳过配额）
- `--remote-debugging-port` 会暴露调试端口（本机监听 127.0.0.1，风险可控）
