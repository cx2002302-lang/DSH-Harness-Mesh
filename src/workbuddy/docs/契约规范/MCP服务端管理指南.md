# harness-mesh 服务端管理指南(主控侧专用)

> 2026-10-17 · 适用:208 主控侧(GUI/主会话 LLM/受信编排者如 workbuddy-编排模式)
> 客户端请用《MCP客户端接入指南》——本入口工具全、权限大,客户端不该看。

## 1. 两个入口的分工

| 入口 | 工具数 | 给谁 | 说明 |
|---|---|---|---|
| `/api/mcp/harness-mesh` | **5**(list/dispatch/status/result/cancel) | 所有客户端 harness | 最小上下文,防幻觉;客户端调服务端工具会被拒 |
| `/api/mcp/harness-mesh-admin` | **9**(5+team/team_result/tasks/session) | 主控侧/受信编排者 | 开团、任务清查、会话控制(两段式确认+审计) |

> admin 路由随插件重启激活;若 404 说明还没重启过(下次重启后可用)。

## 2. 服务端专有工具(4 个)

| 工具 | 用途 | 要点 |
|---|---|---|
| `harness_team` | 开团:`{task, members:[{harness, role?}]}` 并行派多节点 | role 以【你的角色:xxx】注入 prompt;返回 team_id+各 task_id |
| `harness_team_result` | `{team_id}` → 全员聚合(state/summary/changes/all_done) | 轮询到 all_done=true 再汇总 |
| `harness_tasks` | `{harness?, state?="running", limit?}` 查任务 | 默认在跑;带 pending_permission 和 last_progress |
| `harness_session` | 会话控制:`{harness, action: stop/pause/resume/start, task_id, confirm_token?}` | **两段式确认**:首次返回 token(60s),带 token 重调才执行;全程审计 |

## 3. 管理面(REST,GUI 同款)

| 面 | 位置 |
|---|---|
| 节点 CRUD | `GET/POST /api/harness-mesh/nodes`、`DELETE /api/harness-mesh/node?name=` |
| AI 辅助配置 | `POST /api/harness-mesh/ai-config`(自然语言→节点草案→表单) |
| 任务会话分组 | GUI 控制台(📋 图标右侧的 Harness 图标);REST `/tasks?harness=&state=` |
| 会话控制 REST | `POST /api/harness-mesh/session`(与 MCP 同逻辑,随重启激活) |
| 项目管理 | `📋 project-hub` 驾驶舱(今日聚焦/项目池/任务/员工档案) |

## 4. 标准编排 SOP

1. **派活**:`harness_list` 选节点 → `dispatch`(prompt 自包含)→ `status` 轮询 → `result`
2. **开团**:`harness_team` → 各成员 `status` 跟进(或 `harness_tasks` 总览)→ `team_result` 聚合
3. **批权**:status 见 pending_permission → GUI 控制台点允许/拒绝(默认拒绝;LLM 通道走 dsh approval)
4. **会话控制**:`harness_session` 两段式;stop/pause 前想清楚(暂停留现场、resume 产生新任务)
5. **审计**:`session-control.log`(控制动作)、`tasks.jsonl`(任务全量)、ann-ctrl 审计(节点入网)

## 5. 节点管理要点

- 命名规:`<计算机名>-<harness类型>`(如 node-win-01-workbuddy)
- 新节点接入:`harness-mesh-新节点接入包/`(含《适配器编写指南》——先判定 CLI-first/GUI-first 再动手)
- 对齐规约:共享 `_对齐/`(manifest+changelog+check_alignment.py);**共享=权威源**
- IP 漂移:以 `ann-ctrl node list` 的 IP 为准更新节点 address

## 6. 排错(服务端视角)

| 现象 | 处理 |
|---|---|
| admin 入口 404 | 路由未激活,等下次重启 |
| 客户端能调 admin 工具 | 不该发生;检查入口路径是否写错 |
| 改了 hot.js 不生效 | 查硬链接是否被 sed -i 掰断(master-plan §7.4.1) |
| 任务秒 failed | 看 error;远程死因回传(harnessd task.exit)会带 stderr |
| 开团成员 role 丢失 | team-roles.json 是热区文件,重启 dreamx 不丢;丢了重派 |
