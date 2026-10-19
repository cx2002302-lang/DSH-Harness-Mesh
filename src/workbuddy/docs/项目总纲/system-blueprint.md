---
doc: system-blueprint
version: 1.0
date: 2026-10-15
status: draft(供审核)
scope: DSH_PiDurable 全系统(harness 组网 + ANN + 项目管理 + 文件管理 + 备份)
inputs:
  - master-plan.md(v3.3 总纲,决策事实源)
  - harness-mesh-arch-v2.md(ANN/插头协议/DSB)
  - harness-mesh-plan.md(v1,M0-M5 建成记录)
  - info-alignment.md(R0,设备/harness 待填)
  - 实测记录:ANN 冒烟(2026-10-15)、服务盘点(206/9.234/208)
query_hint: "查实体→§0.2 索引;查现状→§1;查结构→§2/§3;查流程→§4;查数据→§5"
---

# DSH_PiDurable 系统蓝本(思维导图 + 拓扑图 + 伪代码 + 元信息)

> 本文是**可查询的工程蓝本**:§0 元信息与索引(给未来的我/协作者查)、§1 重新审核报告、§2 思维导图、§3 拓扑图、§4 伪代码、§5 数据模型、§6 开放问题。
> 原则不变:一个 DSH 管所有;旧系统只归档不迁;备份最后做;ANN 混合协议先行研究;信息先对齐再动手。

---

## 0. 元信息与查询索引

### 0.1 文档元信息

| 字段 | 值 |
|---|---|
| 文档 ID | `system-blueprint` v1.0 |
| 生成时间 | 2026-10-15(晚) |
| 状态 | draft,待用户审核 |
| 上游文档 | `master-plan.md`(决策)、`harness-mesh-arch-v2.md`(ANN 细节)、`harness-mesh-plan.md`(v1 史)、`info-alignment.md`(R0) |
| 下游动作 | R0 填表 → R1 研究 → M6 部署 |
| 事实基线 | 本文 §1 的所有"已实测"标记均来自 2026-10-15 当天在 208 上的验证 |

### 0.2 实体索引(查这里)

| 实体 | ID | 状态 | 定义在 | 关键事实 |
|---|---|---|---|---|
| harness-mesh 插件 | `M-harness-mesh` | ✅ 运行中 | harness-mesh/(lib/) | M0-M5 完成;hot 路由;MCP 入口;@ 召唤 |
| project-hub | `M-project-hub` | ⬜ M11 | master-plan §3.2 | 四表 schema;从零;掌盘继任 |
| file-hub | `M-file-hub` | ⬜ M12 | master-plan §4 | 三根视图+回收站 |
| backup-hub | `M-backup-hub` | ⬜ M15 | master-plan §2.2 | 最后做;DshData→专用服务器 |
| DeepSeekBot 接线 | `M-dsb` | ⬜ M14 | v2 §4 | 装 deepseekbot@1.3.1;MCP 接线;飞书 |
| ANN 控制面 | `S-ann-ctrl` | 🟢 已部署 | §3.2 | ann-ctrl;8443/8444/8445/3478;内网版;systemd --user autostart;ACL(mesh@ann);短码/tag/--forward 三补丁已合入 |
| ANN 数据面 | `S-ann-agent` | 🟢 208 节点在线 | §3.2/§4.6 | tsnet;myxia-ser=100.64.0.8(tag:master);--forward 已重建;Windows 绿模包已交付 |
| 插头协议 | `P-plug` | ⬜ R1 定稿 | §4.1/4.2 | 8 条 JSON-RPC;TCP 长连接 |
| harnessd | `C-harnessd` | 🟢 回环验证通过 | §4.1 | Python 单文件;控制+数据双连接;hello 自报(D-q) |
| guardian | `C-guardian` | 🟢 已交付 Windows 包 | §4.5 | 绿模看护;崩溃重启退避;随绿模包发布 |
| acp-plug 适配器 | `C-acp-plug` | 🟢 回环验证通过 | §4.2 | 主控侧;TUN 直拨/SOCKS5 兜底(零依赖内置);回环 e2e+权限链实测 |
| 旧 ANN agent | `X-old-ann` | 🔴 待停 | §1.2 | /opt/ann-agent root 服务;旧控制面 |
| 掌盘 palmboard | `X-palmboard` | 🟡 活着,待退役 | §1.2 | 206:8400;DB 归档不迁 |
| 排班系统 | `X-paiban` | 🟢 在册不搬 | §1.2 | 9.234:3000 |
| SMB DshData | `S-smb` | 🟢 挂载中 | §3.1 | 9.100;~10.9T;冷备+归档 |

### 0.3 常见查询 → 章节路由

| 问题 | 去哪 |
|---|---|
| 现在到哪一步了? | §1.1 + master-plan §6.3 |
| workbuddy 怎么接入? | §3.2 目标拓扑 + §4.1/4.5 |
| 插头协议长什么样? | §4.1/4.2 + v2 §2.3 |
| ANN 怎么装/迁? | §3.2 + master-plan §6.2 |
| 数据放哪、备份怎么配? | §5 + master-plan §2 |
| schema 长什么样? | §5(权威:master-plan §3.2) |
| 文档之间什么关系? | §0.4 |

### 0.4 文档家族关系

```
master-plan.md ──┬──> system-blueprint.md(本文:导图/拓扑/伪代码/审核)
   (决策总纲)    ├──> info-alignment.md(R0 填表)
                 ├──> ann-hybrid-protocol-research.md(R1 待写)
                 ├──> harness-mesh-arch-v2.md(ANN/插头/DSB 细节)
                 └──> harness-mesh-plan.md(v1 史,M0-M5)
```

---

## 1. 重新审核报告(2026-10-15)

### 1.1 已建成(实测事实)

| 项 | 证据 |
|---|---|
| harness-mesh 插件全链运行 | 208 DSH profile file: 依赖;节点/任务 API 实测;@ 召唤+回执卡验收 |
| MCP 入口可用 | `POST /api/mcp/harness-mesh?token=`;Python-urllib 与 WorkBuddy/5.8.2 均连过;01:50 workbuddy 经 MCP 派发成功(succeeded) |
| opencode 节点打通 | M1 e2e:产物+summary+changes+权限链 |
| 服务端热路由 | http.js 薄壳 + hot.js 每请求破缓存;改 hot.js/client.js 零重启 |
| ANN 自建控制面冒烟通过 | ctrl+双 agent 入网;SOCKS5 拨对端 echo 通(WireGuard);REST /api/v1/nodes 通 |
| 旧服务盘点 | palmboard 206:8400 **活着**;排班 9.234:3000 **活着**;旧 ANN agent(root,9/23 起)在跑 |
| **MCP 远程控制 e2e(当晚实测)** | curl 模拟 MCP 主控:initialize→dispatch→5.9s succeeded→结构化汇报;**远程调试链路今天就可用** |
| **ann-ctrl 上线(当晚)** | systemd --user `ann-ctrl.service`(autostart,本地盘数据目录);healthz 200;user=mesh;ACL 收紧为 master↔agent:7080;Web 密码存 `~/.local/share/ann-ctrl/web-cred.txt` |
| **ANN 重建+四补丁(10-16 凌晨)** | Go 1.26.3 装好;ann-src 入项目库;P1 --forward / P2 短码 / P3 pendingTags 空 map / P4 重名 tag 消费;三产物 linux+windows |
| **M6 五重实测(10-16)** | 短码入网 ✅;tag 自动下发 ✅;--forward 跨节点 HTTP 200 ✅;无 tag 节点 ACL 超时拒绝 ✅;208 节点(myxia-ser 100.64.0.8,tag:master,SOCKS5:11090)systemd --user autostart ✅ |
| **M7a 回环 e2e(10-16)** | harnessd+acp-plug:dispatch 8.9s succeeded+结构化汇报;权限链经假 ACP agent 实测(pending→API 放行→selected→succeeded);fake-acp-agent.py 留作回归测试 |
| **Windows 绿模包(10-16)** | `DshData/wb-green/`:ann-agent.exe+harnessd.py+guardian.py+plugs.json+使用说明;短码 45a5cde9(24h 单次);等用户执行 |

### 1.2 审核发现(文档 vs 现实差异,逐条)

| # | 文档说的 | 实际 | 处置 |
|---|---|---|---|
| A1 | v1 §3:"208 已在官方 Tailscale 网 100.64.0.2" | 是**旧 ANN agent**(root,/opt,连旧控制面,peer 100.64.0.4 不可达) | 按 D-m 停用,部署我们自己的 |
| A2 | v1 M4 示例:workbuddy 在 192.168.9.234 | 9.234 是**排班系统**;workbuddy 在 **9.100**(Windows PC) | info-alignment 已按 9.100 填 |
| A3 | 计划备注:"palmboard 在 206 已停机,先用需迁 208" | **活着**(HTTP 200) | M11 建成后再停(M13) |
| A4 | ANN README:`ann-ctrl quickstart` 一键启动 | 二进制**无 quickstart 命令**(比 README 旧);docker-compose 的 quickstart 会失败 | 用 `serve` 手动起(§4.x 已按此写) |
| A5 | ANN README:bootstrap 用短码 | **bug**:Validate 按全码查表,短码永远 401(源码实锤) | R1 决策:修 ANN 或强制全码 |
| A6 | AI项目清单 #2:"Tailscale 魔改版 Base 版尚未实装" | 就是现在的 ANN;已有二进制+208 旧部署+冒烟通过 | 状态更新为"M6 部署中" |
| A7 | v1 M5:workbuddy 走 CLI one-shot 兜底 | workbuddy 支持 ACP(`codebuddy --acp`);CLI one-shot 没跑通(疑登录态) | 走 acp-plug;登录态入网后验 |
| A8 | /opt/ann-agent(9/4 构建)vs 项目副本(8/29 构建) | **副本二进制更旧** | M6 前二选一(建议用副本保持"我们的代码库"单一来源,或先比对版本) |
| A9 | MCP 端点 `?token=` 直接 POST | **401**:URL token 只能首次种 cookie(`GET /?token=`→303→dsh-auth cookie);POST 必须带 cookie | MCP 客户端必须是"会种 cookie"的(workbuddy 5.8.2 已验证可以);纯 API 客户端先用 GET 种 cookie 再 POST |
| A10 | LAN token 已轮换 | `/root/.dreamx/lan-token` = 新值,但 dsh 内部 token 仍 88888888(journalctl 可见);GUI/直连续用 88888888 即可 | 密码类信息不进文档,用时从 journalctl/文件取 |

### 1.3 风险与遗留(按优先级)

| # | 风险 | 缓解 |
|---|---|---|
| R1 | ANN 默认 ACL = allow-all(实测) | M6 第一件事:policy set 收紧 |
| R2 | SQLite 不能放 CIFS(实测 BUSY) | 硬规则:活数据只驻本地盘(已写入 master-plan §2.1) |
| R3 | IP 撞号:自建 ctrl 从 100.64.0.1 发,与旧网 208=100.64.0.2 可能重 | 208 重注册后 `node cleanup` 清旧记录 |
| R4 | MCP token `88888888` 弱 | M9 换强随机+绑内网 |
| R5 | DSH 版本未验证是否 ≥0.2.0-rc.2(DSB 前提) | M14 第一步验证 |
| R6 | DSH_PiDurable 无 git(曾提议未答复) | 建议 M10 时 `git init`(回退基线) |
| R7 | Go 工具链缺失(--forward 重建需要) | R1 定 spec,M6/M7 时装 Go 1.26.3 |
| R8 | 旧 ANN agent 停用影响面未知(有没有别的东西依赖旧 tailnet) | 停之前:journalctl 复盘+ping  peer 确认无人用 |

### 1.4 审核结论

- 建设面健康:M0-M5 全部有实测支撑;ANN 冒烟通过把最大未知数消灭了。
- 主要债务在**文档漂移**(A1-A8 已逐条处置)和**旧资产退役**(X-old-ann/X-palmboard)。
- 下一步严格按 R0(填表)→ R1(研究)→ M6(部署)走,不抢跑。

---

## 2. 思维导图(全系统)

```
DSH_PiDurable 系统
│
├── 入口层(L4)
│   ├── @召唤 ──────────── ✅ 已建(GUI 圆形图标→菜单→弹窗;按会话分组;零 LLM)
│   ├── DeepSeekBot ───── ⬜ M14(调度员 bot;人格/记忆/定时;飞书/微信)
│   └── MCP 客户端 ────── ✅ 已建(/api/mcp/harness-mesh;5 工具;任意客户端可主控)
│
├── 编排层(L3 · 208 唯一锚点)
│   ├── harness-mesh ──── ✅ 运行中
│   │   ├── 节点表 nodes.json / 任务注册表 tasks.jsonl(带 origin 会话归属)
│   │   ├── hot 热路由(http.js 壳 + hot.js 逻辑;改保存即生效)
│   │   ├── GUI:图标菜单+居中弹窗(任务按会话分组/节点 CRUD/AI 配置/MCP 卡)
│   │   └── 审批链(request_permission → DSH UI,默认拒绝)
│   ├── project-hub ───── ⬜ M11(四表:harnesses 员工档案/projects/tasks/events)
│   ├── file-hub ─────── ⬜ M12(三根视图/预览/回收站/防穿越)
│   └── backup-hub ───── ⬜ M15(日快照+周冷备+恢复演练;目标可切换)
│
├── 传输层(L2)
│   ├── ANN(内网版 · 我们自己的服务)
│   │   ├── ann-ctrl ───── 控制面(Headscale 内核;8443/8444/8445/3478;SQLite 本地)
│   │   ├── ann-agent ──── 数据面(tsnet/WireGuard;TUN 或 userspace;绿模)
│   │   ├── 插头协议 ───── 8 条 JSON-RPC over TCP(plug.list/dispatch/event/permission/send/cancel/result)
│   │   └── 混合策略 ───── 直连 P2P 优先 → DERP 中继 → ssh 兜底(R1 研究)
│   └── ssh ─────────── 降级为:注册引导 + 应急 + 无 ANN 兜底
│
├── 执行层(L1 · 5 个 harness,逐个适配)
│   ├── opencode ─────── ✅ acp-stdio @208(M1 已通)
│   ├── workbuddy ───── ⬜ acp-plug 绿模 @WinPC(9.100;codebuddy --acp)
│   ├── kimicode ────── ⬜ 驻地待填(O2')
│   ├── zcode ───────── ⬜ 驻地待填(O2')
│   └── dsh ─────────── ⬜ dsh-acp 互控(另一台 DSH)
│
├── 数据
│   ├── 热(SQLite/JSONL)── /root/.dreamx/<模块>/ + ann-ctrl 数据目录(只本地!)
│   ├── 温(git)──────── /root/data/myagents/<项目>/ + 被控机就地
│   ├── 冷(归档/备份)── Samba 9.100:/DshData(archive/ + backup/208/)
│   └── 缓存 ─────────── 本地可弃,不备份
│
├── 运维
│   ├── 备份 3-2-1 ──── ①本地热 ②本地日快照 ③Samba 周全量(M15;明文;DshData→专用服务器)
│   ├── 恢复演练 ────── 每季度,RTO≤2h,报告落 project-hub
│   └── 退役路线 ────── 旧 ANN(停)→ 掌盘(停+归档)→ AI清单(归档);排班在册不搬
│
└── 路线图
    R0 信息对齐 → R1 ANN 混合协议研究(重点) → M6 ANN 服务端重做
    → M7 插头协议+workbuddy 首节点 → M10 目录+归档 → M11 project-hub
    → M12 file-hub → M13 旧系统退役 → M14 DSB → M15 备份
```

---

## 3. 拓扑图

### 3.1 现状拓扑(2026-10-15 实测)

```
                         ┌─────────────────────────────┐
                         │      你的浏览器/手机          │
                         └──────────────┬──────────────┘
                                   HTTP :80(401 鉴权)
                         ┌──────────────▼──────────────┐
                         │  208 myxia-SER               │
                         │  ┌────────────────────────┐  │        ┌─────────────────┐
                         │  │ DSH + harness-mesh      │  │        │ 206             │
                         │  │ · 节点表/任务注册表     │  │        │ palmboard :8400 │🟡活着,待退役
                         │  │ · MCP /api/mcp/...      │  │        └─────────────────┘
                         │  │ · @召唤/会话分组         │  │
                         │  └───────┬─────────────────┘  │        ┌─────────────────┐
                         │          │ stdio(ACP)         │        │ 9.234           │
                         │  ┌───────▼─────────────────┐  │        │ 排班 :3000      │🟢在册不搬
                         │  │ opencode acp ✅          │  │        └─────────────────┘
                         │  └─────────────────────────┘  │
                         │  ┌─────────────────────────┐  │        ┌─────────────────┐
                         │  │ 旧 ANN agent(root) 🔴   │──┼──旧控制面(不可达)     │
                         │  │ /opt tailscale0 .2      │  │        └─────────────────┘
                         │  └─────────────────────────┘  │
                         │  /root/.dreamx(58M 本地)     │        ┌─────────────────┐
                         └──────────────┬───────────────┘        │ 9.100 WinPC      │
                                   CIFS 挂载(soft,automount)────▶│ · workbuddy      │
                         ┌──────────────▼───────────────┐        │ · SMB DshData    │🟢~10.9T
                         │ /home/myxia/DshData(CIFS)    │        └─────────────────┘
                         │ ⚠ SQLite 放这会 BUSY,只放归档│
                         └──────────────────────────────┘
   外部 MCP 客户端(WorkBuddy/5.8.2 等)──HTTP──▶ 208 /api/mcp/harness-mesh ✅
```

### 3.2 目标拓扑(M6+M7 后)

```
   [手机飞书]──┐
   [浏览器]────┼──HTTP:80──▶［208 myxia-SER · tag:master］
   [MCP 客户端]┘                  │
                                  │ DSH profile 插件族
              ┌───────────────────┼────────────────────────┐
              │                   │                        │
      ┌───────▼───────┐  ┌───────▼────────┐  ┌─────────────▼────┐
      │ harness-mesh  │  │ project-hub    │  │ file/backup-hub  │
      │ · 派活/审批   │  │ · 员工档案     │  │ (M12/M15)        │
      └───┬───────┬───┘  └───────┬────────┘  └──────────────────┘
          │       │              │ 任务↔派活联动(mesh_task_id)
          │       │              ▼
          │       │      ┌───────────────┐
          │       │      │ ann-ctrl      │◀──HTTPS:8443/8444 · WebUI:8445 · STUN:3478
          │       │      │ (我们自己的)  │    ACL: tag:master→tag:agent:7080
          │       │      └───┬───────┬───┘
          │       │  入网(全码)│       │入网(全码)
          │       ▼          ▼       ▼
   ┌──────▼──────────────┐  ┌──────────────────────────────────┐
   │ 208 节点 agent      │  │ WinPC 绿模(tag:agent)             │
   │ · root systemd(TUN) │  │ ┌──────────────────────────────┐ │
   │ · OS 路由→插件直拨  │  │ │ ann-agent.exe --forward      │ │
   └──────┬──────────────┘  │ │   7080→127.0.0.1:7080         │ │
          │ plug(TCP 长连接)│ │ harnessd.py :7080(插头服务)  │ │
          │                │ │ guardian.py(看护+空闲退出)    │ │
          │                │ └───────────┬──────────────────┘ │
          │                │             │ stdio(ACP)          │
          │                │      ┌──────▼───────┐             │
          │                │      │ codebuddy    │             │
          │                │      │ --acp ✅待验 │             │
          │                │      └──────────────┘             │
          ▼                └──────────────────────────────────┘
   [opencode acp ✅]      [kimicode/zcode/dsh:按 info-alignment 填]

   数据流:派活 → plug.task.dispatch → harnessd spawn CLI → ACP 事件流回 →
          task.event → 任务注册表+GUI → (需审批)DSH UI → permission.reply →
          终态 result(结构化摘要;产物在被控机就地 git)
```

### 3.3 端口/协议清单

| 端口 | 属谁 | 协议 | 暴露面 | 备注 |
|---|---|---|---|---|
| 80 | DSH web | HTTP | 内网(401) | GUI+MCP+插件 API 都在这 |
| 8443 | ann-ctrl | HTTPS 自签 | 内网 | 控制面 gRPC/HTTP |
| 8444 | ann-ctrl bootstrap | HTTPS | 内网 | 入网换 token(用全码!) |
| 8445 | ann-ctrl Web UI | HTTP+JWT | 内网 | admin 密码要换(M6) |
| 3478 | ann-ctrl STUN | UDP | 内网 | 打洞 |
| 7080 | harnessd(每台被控机) | TCP,长度分帧 JSON-RPC | **仅 ANN tailnet**(ACL 锁) | 插头插座端口 |
| 11080 | ann-agent SOCKS5(可选) | SOCKS5 | 本机 | 零 root 兜底拨号用 |
| 8400 | palmboard | HTTP | 206 | M13 停用 |
| 3000 | 排班 | HTTP | 9.234 | 在册不搬 |
| 445 | SMB | CIFS | 9.100 | 只读挂载;冷备+归档 |

### 3.4 一条派活的生命周期(端到端)

```
① 手机飞书 @调度员bot:"让 workbuddy 把 X 改了"
② DSB bot(LLM)→ MCP tools/call harness_dispatch{harness:workbuddy-winpc, prompt}
③ harness-mesh:建任务(running,origin=bot会话) → 查节点(acp-plug)
④ acp-plug 拨 100.64.x.x:7080(经 208 节点 agent 的 TUN 路由)→ plug.task.dispatch
⑤ harnessd:spawn codebuddy --acp → ACP initialize→session/new→session/prompt
⑥ ACP session/update → task.event 流回 → 任务注册表/GUI/事件总线
⑦ (危险操作)ACP request_permission → plug.task.permission → DSH 审批 UI(默认拒绝)→ reply
⑧ 终态:harness 就地 git commit;result 回结构化摘要(summary/changes/tests)
⑨ DSB bot 汇总 → 飞书回复你;project-hub events 留痕(actor=bot/harness)
```

---

## 4. 伪代码(关键流程)

### 4.1 harnessd:插头协议服务端(每台被控机,M7)

```python
# harnessd.py —— 绿模三件套之一;监听 127.0.0.1:7080(由 ann-agent --forward 暴露到 tailnet)
FORWARDS = {"7080": "127.0.0.1:7080"}       # 与 ann-agent --forward 对应
PLUGS    = load_plugs("plugs.json")          # [{plugId, kind, command, args, model, cwd}]

def self_report():                           # D-q:动态自报,服务端登记,人工只确认
    return {"computer_name": OS_HOSTNAME,    # 动态取,不手打
            "os": platform.system() + platform.release(),
            "lan_addr": lan_ipv4(),
            "plugs": [p.plugId for p in PLUGS]}

def serve():
    ln = listen("0.0.0.0", 7080)             # 生产绑定 ANN IP;绿模绑 127.0.0.1 由 forward 暴露
    while True:
        conn = ln.accept()
        spawn(handle_master, conn)           # 一主控一协程;主控多连接按需扩展

def handle_master(conn):
    hello = recv_jsonrpc(conn)               # 期望:hello{node_key_sig, master_pubkey}
    if not verify(hello, TRUSTED_MASTERS):   # 公钥钉扎:只认登记过的主控
        conn.close(); return
    send(conn, ok{"node": COMPUTER_NAME, "report": self_report(), "plugs": PLUGS})
    # 服务端(harness-mesh)拿 report 自动登记/更新 harnesses 员工档案:
    #   computer_name/os/lan_addr/plugs → upsert;ann_addr 由控制面 node list 回填
    sessions = {}
    while conn.open:
        msg = recv_frame(conn)               # 长度分帧 JSON-RPC 2.0
        match msg.method:
            "task.dispatch":
                plug = PLUGS[msg.plugId]
                proc = spawn(plug.command + plug.args, cwd=msg.cwd or plug.cwd)
                sessions[msg.taskId] = AcpSession(proc, on_event=lambda e: send(conn, notify("task.event", e)))
                sessions[msg.taskId].run(msg.prompt, model=msg.model)   # ACP: initialize→new→prompt
            "task.send":      sessions[msg.taskId].send(msg.message)    # needs_input 回答/续跑
            "task.cancel":    sessions[msg.taskId].cancel(); proc.kill()
            "task.permission.reply":
                sessions[msg.taskId].resolve_permission(msg.allow)      # 回给 ACP permission 回调
            "task.result":    send(conn, result(sessions[msg.taskId]))  # 结构化摘要
            "ping":           send(conn, pong)                          # keepalive
    # 断线:会话按策略保留 N 分钟(可恢复),否则 kill 子进程并记事件
```

### 4.2 主控 acp-plug 适配器(harness-mesh 插件内,M7)

```js
// adapters/acp-plug.js —— 拨对端 ANN IP:7080;TUN 模式下直连,零 root 兜底走 SOCKS5
class AcpPlugAdapter {
  async dial(node) {
    const sock = node.tunRoute
      ? await tcpConnect(node.annAddr)                    // 208 节点 agent TUN → 系统路由直拨
      : await socks5Dial("127.0.0.1:11080", node.annAddr) // 零 root 兜底(内置 ~40 行 SOCKS5 客户端)
    this.conn = framedJsonRpc(sock)
    await this.conn.call("hello", {masterPubkey: MY_PUBKEY})
  }
  async dispatch(task) {
    await this.conn.call("task.dispatch", {plugId: task.plugId, prompt: task.prompt,
                                           cwd: task.cwd, model: task.model})
    this.conn.onNotify("task.event", e => bus.emit(`task:${task.id}`, e))
    this.conn.onRequest("task.permission", async p => {     // 插座→主控询问
      const allow = await approvalUI.ask(p, {default: "deny"}) // DSH 审批链,默认拒绝
      return this.conn.call("task.permission.reply", {taskId: task.id, allow})
    })
  }
  keepalive() { setInterval(() => this.conn.call("ping"), 30_000) }  // 90s 无 pong → 重连
}
```

### 4.3 派发全链路(harness-mesh 现有 + plug 新增)

```
function harness.dispatch({harness, prompt, cwd, model, origin}):
    node  = nodes.find(harness)                    # nodes.json;origin=会话 id(按会话分组用)
    task  = store.create({state:"running", origin, prompt, harness})
    adapter = pick(node.transport)                 # acp-stdio | acp-plug | cli-oneshot
    try:
        adapter.dispatch(task)
        loop:  await bus.wait terminal(task)       # succeeded/failed/cancelled/timeout
              on needs_input → 转问你 → harness.send(task, answer) → 继续
              on permission → approvalUI(default deny) → adapter.reply
        result = collectStructured(task)           # summary/changes/tests/artifacts(D4)
        store.finish(task, "succeeded", result)
    except e:
        store.finish(task, "failed", {error: e})
    return task.id
```

### 4.4 断线重连与保活(插头连接)

```
on connection lost:
    backoff = [1s, 2s, 5s, 10s, 30s, 60s(cap)]
    for delay in backoff:
        sleep(delay); try dial() → success: break
    after reconnect:
        send hello → plug.list → 对每个 running task:
            if harnessd 保留了 session(按 taskId): 订阅 task.event 继续
            else: 标记 task "interrupted",结果里记 next_hint:"重连后需重新派发/续跑"
    keepalive: 每 30s ping;90s 无响应判定死亡;harnessd 侧同样心跳主控
```

### 4.5 guardian:绿模看护(Windows/被控机,M7)

```
# guardian.py —— 绿模三件套之一;无服务/无 admin;拷贝即用
CHILDREN = [("ann-agent", ["ann-agent.exe","run","--config","agent.json","--forward","7080=127.0.0.1:7080"]),
            ("harnessd",  ["python","harnessd.py"])]

def supervise():
    procs = {name: spawn(cmd) for name, cmd in CHILDREN}
    last_conn = now()
    while True:
        for name, p in procs.items():
            if p.exited: procs[name] = spawn(CHILDREN[name])      # 崩溃重启(退避 1→60s)
        if harnessd.idle_for() > 30min and no running task:       # 空闲退出:省资源
            stop_all(); sleep()                                   # 有新连接/任务再被拉起(开机项或主控唤醒)
        sleep(5)
# 唤醒:harnessd 每次 accept 到连接即报 guardian 重置空闲计时;
#       "MCP 连上后用进程守护"= 主控连上→ guardian 保活→断线自愈
```

### 4.6 ANN `--forward` 补丁 spec(需重建,R1 定稿/M7 实现)

```go
// cmd/ann-agent/main.go + pkg/client:通用 TCP 转发(把本地端口插上 tailnet)
// flag: --forward 7080=127.0.0.1:7080(可重复);持久化进 AgentConfig.Forwards []string
func runServices(c *client.Client, cfg *AgentConfig) {
    for _, f := range cfg.Forwards {                    // "tailnetPort=localAddr"
        tp, la := parseForward(f)
        ln, err := c.Listen("tcp", ":"+tp)              // tsnet tailnet 监听(冒烟已验证可用)
        if err != nil { log.Error("forward listen failed"); os.Exit(1) }
        go func() {
            for {
                cc, err := ln.Accept(); if err != nil { continue }
                go pump(cc, la)                         // 双向 copy;连接断→两边 close
            }
        }()
    }
}
// 顺手修:短码 bug —— Validate() 支持 8 位短码前缀匹配(m.codes 建 short→full 索引)
// 重建前提:208 装 Go 1.26.3;产物双平台(linux+windows);版本与 /opt 旧二进制比对后定基
```

### 4.7 project-hub:任务↔派活联动(M11)

```
task.assign(taskId, harnessId):
    h = harnesses.find(harnessId)                       # 员工档案(计算机名/ann_addr/transport)
    t = tasks.find(taskId)
    meshId = mesh.dispatch({harness: h.name, prompt: t.title + "\n" + t.notes,
                            cwd: projects.find(t.project_id).repo_path, origin: session})
    t.mesh_task_id = meshId; t.status = "doing"
    events.add(kind:"mesh", actor:"你", summary:"派给 "+h.name)

on mesh task terminal(meshId, result):                  # harness-mesh 事件总线回调
    t = tasks.find_by_mesh(meshId)
    t.status = result.state == "succeeded" ? "done" : "blocked"
    events.add(kind:"mesh", actor:h.name, summary:result.summary, payload:result.changes)
    projects.recalc_progress(t.project_id)              # 进度自动算
```

### 4.8 备份流程(M15,最后做)

```
MUST_BACKUP = ["/root/.dreamx", "/root/data/myagents", ANN_CTRL_DATA_DIR]
daily():   # systemd timer
    snap = "/backup/snapshots/daily-" + today()
    hardlink_rotate(keep_daily=7, keep_weekly=4, keep_monthly=3)   # rsync -a --link-dest
    for p in MUST_BACKUP: tar_zstd(p, snap + "/" + base(p) + ".tar.zst")   # 明文
weekly():
    rsync(snapshots/weekly-latest, SMB + ":/DshData/backup/208/")          # 目标可切换→专用服务器
quarterly():
    drill = restore_random_snapshot_to_tmp(); verify(); report_to(project_hub.events)
```

### 4.9 @召唤(已建成,现状记录)

```
slot register: conversation.input.left {id:"hm-icon", order}   # 圆形图标,与 +/盾牌同排
inject(sessionKey): currentSessionId = sessionKey              # session-scoped slot 直捕会话 id
onEnter: matchEnter claim 整行("@节点名 任务内容")
onSubmit: POST /api/harness-mesh/dispatch {harness, prompt, origin: currentSessionId}
GUI: 任务列表按 origin 分组(本会话优先→其他→未标记);完成回执卡
```

### 4.10 MCP 入口(已建成,现状记录)

```
POST /api/mcp/harness-mesh?token=<token>   # header: mcp-session-id=harness-mesh-main
jsonrpc: initialize | tools/list | tools/call
tools: harness_list | dispatch | status | cancel | result     # → 内部直调 mesh 同款逻辑
响应 application/json(非 SSE);notifications/initialized 或无 id → 202
访问日志含 clientInfo.name(区分客户端;已见 Python-urllib、WorkBuddy/5.8.2)
```

---

## 5. 数据模型(权威定义:master-plan §3.2,此处速查)

| 表 | 主键 | 要点 |
|---|---|---|
| `harnesses` | name | kind/version/**computer_name(=ANN 节点名)**/lan_addr/ann_addr/transport/plug_port/login_state/capabilities/status/role_note |
| `projects` | id | stage/priority/progress/next_action(必填)/repo_path/docs_path/archive_path/links_json |
| `tasks` | id | project_id→harness_id→**mesh_task_id**(派活联动)/status/due |
| `events` | id | kind(project/task/mesh/system)/actor(人/harness/bot)/summary/payload |

运行数据(非 project-hub):`nodes.json`(mesh 节点表,与 harnesses.name 对齐)、`tasks.jsonl`(mesh 任务注册表)、ann-ctrl SQLite(自包含,可整目录迁移)。

---

## 6. 开放问题与下一步

| # | 问题 | 卡住 | 状态 |
|---|---|---|---|
| O2' | kimicode/zcode/dsh 驻地 | M7 后适配排序 | 待填(info-alignment) |
| O3' | 206 盘点 | M13 | 待填 |
| R1 | ANN 混合协议 7 问 | M6 | R0 填完即开工 |
| R8 | 旧 ANN 停用影响面 | M6 第一步 | 停前复盘 journalctl |

**下一步**:R0 填表(info-alignment.md)→ R1 研究出 `ann-hybrid-protocol-research.md` → M6 动 ANN。本文随每个里程碑更新版本号。
