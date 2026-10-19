# harness-mesh 客户端接入指南(给被接进来的 harness)

> 2026-10-17 · 适用:workbuddy / DeepSeekBot / 任何经 MCP 接入的客户端 harness
> 目标:用最少上下文(5 个工具)把活派进来、拿结果走。**看不到的工具不要猜、不要调。**

## 1. 连接

```
POST http://<主控IP>:80/api/mcp/harness-mesh?token=<dsh令牌>
```
- 协议:MCP over Streamable HTTP,JSON-RPC 2.0,`application/json` 响应(无 SSE 流)
- 鉴权:URL token 首次种 cookie(会自己处理 cookie 的客户端无感;纯 HTTP 客户端先 `GET /?token=` 种 cookie 再 POST)
- 握手:`initialize` → `notifications/initialized` → `tools/list`(只会看到 5 个工具)

## 2. 你的全部工具(就 5 个)

| 工具 | 什么时候用 |
|---|---|
| `harness_list` | 开场看一眼:有哪些节点、谁健康、谁在忙 |
| `harness_dispatch` | 派活。`{harness, prompt, cwd?, model?, timeoutMs?}` → `task_id` |
| `harness_status` | 盯进度。`{task_id}` → state/progress/**pending_permission** |
| `harness_result` | 任务 `succeeded` 后取汇报。`{task_id}` → summary/changes/tests |
| `harness_cancel` | 叫停。`{task_id}` |

## 2.5 渐进披露(省 context 的用法)

`tools/list` 只给你 **6 个一句话定义**(约 1.3K 字符)。完整的参数说明/示例/SOP 不常驻你的上下文,按需拉:

```
harness_help {}                          → 全部工具速览 + 标准 SOP
harness_help {"tool":"harness_dispatch"} → 该工具的完整用法(参数/示例/注意事项)
```
**建议**:第一次用某工具前先 `harness_help` 一下;已经熟悉的直接调。查不存在的工具会返回可用清单(含服务端工具名,但那些你调会被拒)。

## 2.6 harness 专属工具(按需披露)

某些 harness 有只有它才有的能力(如 workbuddy 的 `wb_info` 节点档案)。这些**默认不在你的工具表里**,按需拉:

```
harness_tools {"harness":"workbuddy"}   → 披露它的专属工具(schema+完整用法)
harness_tools {}                        → 看哪些 harness 配了专属工具
```
拿到后直接 `tools/call` 调用(如 `wb_info`)。公用 `harness_*` 之外的名字都走这条路;调不存在的名字会收到可用清单。

## 3. 标准流程(照这个走,别发明)

```
harness_list → 选节点 → harness_dispatch(拿 task_id)
  → 每隔几秒 harness_status,直到 succeeded/failed
  → harness_result 拿汇报 → 汇总给你的用户
```

- **prompt 必须自包含**:对端看不到你的对话历史。任务背景、输入、输出要求、保存位置,全写进 prompt。
- **pending_permission 非空** = 对端在等主控侧批权(危险操作)。等几秒再看,**不要**反复重派。
- **失败看 error 字段**:`ACP connection closed`=对端进程起来就退(它侧问题,回报给主控侧);`connect ECONNREFUSED/超时`=网络或对端没起。
- **terminal 状态**:`succeeded / failed / cancelled / timeout`。非终态就一直 status。

## 4. 纪律(减少幻觉)

1. **只用上面 5 个**。看到别的工具名(team/session/tasks 等)是服务端工具,你调会被拒,想了也别试。
2. **task_id 原样传**,不要拼装、不要猜。
3. **harness_result 只在 succeeded 后调**(提前调会报错)。
4. **一次派一个任务**,要并行多个节点找主控侧开团(harness_team 是服务端能力)。
5. 派活前先 `harness_list` 确认节点在(health 未知≠一定不可用,但 failed 的活先回报)。

## 5. 排错

| 现象 | 处理 |
|---|---|
| initialize 401 | token 错或没种 cookie |
| tools/list 只见 5 个 | 正常,你就在客户端入口 |
| 调 team/session 被拒(-32601) | 正常,那是服务端工具 |
| dispatch 后一直 queued | 等 2 分钟;超了回报主控侧(可能是对端未就绪) |
| ACP connection closed | 对端 CLI 问题,回报主控侧,带上 task_id |

## 6. 给用户的一句话

"我通过 harness-mesh 把活派到指定节点的 harness 上,盯进度,完成后拿结构化汇报。"
