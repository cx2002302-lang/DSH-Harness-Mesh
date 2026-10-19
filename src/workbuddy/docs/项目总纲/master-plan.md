# DSH_PiDurable 系统总纲 v3.3（从顶部理顺 · 决策已确认）

> 2026-10-15 产出并确认三轮决策。本文是**上位总纲**:把 harness 组网(v1/v2)、ANN 传输、DeepSeekBot 入口,与本轮新增的四块——**数据存储、项目管理、文件管理、本地+Samba 备份**——合成一个系统。
> 定位一句话:**一个 DSH(主 harness)管所有**;旧项目只归档不迁数据;备份最后做;**ANN 混合协议先行研究(重点)**;**设备/harness 信息先对齐再动手**。

---

## 0. 已确认决策(2026-10-15 三轮,逐条)

| # | 决策 | 落地影响 |
|---|---|---|
| D-a | **项目数据全部重做** | project-hub 从零开始;掌盘 DB+导出只归档 Samba 作参考 |
| D-b | **备份系统最后做**;先按 DshData,后迁专用服务器 | backup-hub 排 M15;备份目标可切换配置 |
| D-c | **备份明文** | tar+zstd 无加密 |
| D-d | **file-hub 先默认** | 三根视图:项目区(可管)+`/root/.dreamx`(只读默认折叠)+DshData(只读) |
| D-e | **排班系统不搬** | 只在 project-hub 登记 |
| D-f | **旧实验件归档,代码留参考** | 归档 Samba+索引,本地删,不判废 |
| D-g | **掌盘 schema 按项目内容重构** | §3.2 新数据模型;掌盘三表仅反面参考 |
| D-h | **ANN 混合协议先行研究(重点)** | R1 先于 M6;7 个必答问题见 §7 |
| D-i | **Windows 绿模+进程守护** | ann-agent.exe 非服务直跑+`--forward`+guardian;无 admin |
| D-j | **workbuddy 隧道搁置,等 ANN** | ssh -R 方案作废;acp-tcp.py 归档 |
| D-k | **harness 适配锁定 5 个** | opencode/kimicode/workbuddy/zcode/dsh,一个一个适配 |
| D-l | **DSB 随 M14 处理** | 到 M14 验证 DSH 版本后安装 |
| D-m | **旧 ANN 停用,服务端重做** | 停 /opt 旧 agent(旧控制面);208 部署**我们自己的** ann-ctrl + 208 节点 agent;tailscale0 名字释放 |
| D-n | **ANN 先做内网版,易启易迁** | server-url=内网地址;STUN 打洞为主(DERP 留开关);数据目录自包含(拷走即迁);入网码只发内网 |
| D-o | **schema 加 harness"员工档案"** | 每个 harness 一行:计算机名/服务器地址/harness/版本/登录态/能力/状态(§3.2) |
| D-p | **适配全面铺开,但先对齐信息** | R0 信息对齐(设备/harness 清单填写)先行;harness 分布多台设备,逐个适配 |
| D-r | **ANN 内网版控制面明文**(用户拍板) | 弃 TLS:ctrl `--no-tls` 全明文(控制面/bootstrap/enroll);数据面仍 WireGuard 加密;根除 Windows 无 CA 信任问题(Go 在 Windows 不读 SSL_CERT_FILE);CLI 管理命令自动探测 https/http |
| D-q | **计算机名/服务器名动态自报** | agent 入网/连接时经协议自报(computer_name/os/lan_addr/ann_addr/plugs),服务端自动登记进 `harnesses` 员工档案;人工只做确认不打表 |

**仍待确认**:

| # | 问题 | 卡住谁 |
|---|---|---|
| O2' | kimicode/zcode/dsh 各跑在哪台设备(见 `info-alignment.md` 待填) | M7 后的适配排序 |
| O3' | 206 还跑着什么(盘点) | M13 归档前 |

---

## 1. 全景（模块叠在 v2 的四层栈上）

```
┌───────────────────────────────────────────────────────────────────┐
│ L4 入口层                                                          │
│  ① DSH 聊天 @召唤   ② DeepSeekBot(飞书/微信化身)   ③ MCP 客户端     │
│  ④ 项目管理 UI      ⑤ 文件管理 UI   ← 都是 DSH GUI 里的插件面板     │
├───────────────────────────────────────────────────────────────────┤
│ L3 模块层 · 208 内网服务器(唯一锚点)                                │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌───────────┐ │
│  │ harness-mesh │ │ project-hub  │ │  file-hub    │ │backup-hub │ │
│  │ 派活/任务/节点│ │ 驾驶舱/档案  │ │ 文件浏览管理 │ │ 快照/冷备 │ │
│  │ ✅运行中      │ │ ⬜ M11(从零, │ │ ⬜ M12       │ │ ⬜ M15    │ │
│  │              │ │  §3.2 schema)│ │              │ │  (最后做) │ │
│  └──────────────┘ └──────────────┘ └──────────────┘ └───────────┘ │
│  ┌──────────────┐ ┌──────────────┐                                │
│  │ deepseekbot  │ │  ann-ctrl    │  ← 我们自己的 ANN 服务(D-m/D-n) │
│  │ ⬜ M14       │ │ ⬜ M6         │                                │
│  └──────────────┘ └──────────────┘                                │
├───────────────────────────────────────────────────────────────────┤
│ L2 传输层 · ANN(内网版)+ ssh(插头协议;混合协议研究见 §7)             │
├───────────────────────────────────────────────────────────────────┤
│ L1 执行层 · 5 个 harness(D-k)+ 项目 git 工作区                      │
└───────────────────────────────────────────────────────────────────┘
```

---

## 2. 数据存储架构

### 2.1 数据分类与驻地

| 类 | 内容 | 驻地 | 规则 |
|---|---|---|---|
| **结构化·热** | 节点表、任务注册表、项目/任务/事件/harness 档案、备份任务状态 | 208 本地盘:`/root/.dreamx/<模块>/`;project-hub 用 SQLite | **绝不放 CIFS**(实测 SQLITE_BUSY) |
| **代码** | 全部项目 git 仓库 | 208 `/root/data/myagents/<项目>/` + 被控机就地 | git 即事实源;主控只收摘要 |
| **文件·温** | 文档、图片、产物、安装包、参考素材 | 208 本地盘,按 §5 目录规范 | 大件(>1G)下沉 Samba |
| **文件·冷** | 旧项目归档、历史备份、不再改的大文件 | Samba `//192.168.9.100/DshData`(~10.9T free) | 只读挂载;**不当运行驻地** |
| **缓存** | pnpm store、模型缓存、临时文件 | 本地,可弃 | 不备份、不进 git |

### 2.2 备份架构(M15 最后做;目标先 DshData,后迁专用服务器;明文)

| 副本 | 位置 | 内容 | 频率/保留 |
|---|---|---|---|
| ① 热 | 208 本地 | 全部活数据 | 实时 |
| ② 温 | 208 本地 `/backup/snapshots/` | 全量 tar+zst,hardlink 轮转 | 日×7 + 周×4 + 月×3 |
| ③ 冷 | **过渡期** Samba `9.100:/DshData/backup/208/`;**将来** 专用备份服务器 | 周全量+关键数据 | 周;保留 8 周 |

- RPO ≤ 24h,RTO ≤ 2h;每季度真实恢复演练。
- 必保:`/root/.dreamx`(58M)、`/root/data/myagents`、ann-ctrl 数据目录、各模块 SQLite/JSONL。
- ANN 数据目录**自包含**(SQLite+CA 一体),迁移=整目录拷走+改 server-url(D-n)。

---

## 3. 项目管理集成与旧系统退役(D-a/D-g/D-o:重构+从零+员工档案)

### 3.1 旧系统归宿

| 旧系统 | 现状(实测) | 归宿 |
|---|---|---|
| **掌盘 PalmBoard** `206:8400` | 活着,14 个项目在库 | **不迁数据**:export+DB 归档 Samba 作参考;206 服务停用(M13);schema 仅反面参考 |
| **工作排班系统** `9.234:3000` | 活着,已完成 | 不搬不淘汰(D-e);project-hub 登记,归档地址/负责人/备份方式 |
| **AI项目清单.md** | 手工 14 项 | 重新登记时的参考底稿;登记完成后归档 |
| **散落实验件**(MyDSH/backupfile/旧 md) | 散、无归属 | 归档 Samba `archive/参考代码/`+索引(D-f),本地删 |

### 3.2 project-hub 数据模型(§3.2-v2:四张表)

**项目内容五维度**:身份/进展/载体/工作/轨迹;再加 **harness 员工档案(D-o:每个 harness 一行,类似员工信息)**。

```sql
-- ① harnesses:harness 员工档案(每个 harness 实例一行)
harnesses(
  id, name,                    -- 档案名=harness-mesh 节点名(如 workbuddy-winpc)
  kind,                        -- opencode|kimicode|workbuddy|zcode|dsh
  version,                     -- CLI 版本(如 codebuddy v2.103.3)
  computer_name,               -- 计算机名(=ANN 节点名,三视图同钥匙)
  lan_addr,                    -- 内网地址(如 192.168.9.100)
  ann_addr,                    -- ANN tailnet IP(入网后回填)
  transport,                   -- acp-stdio|acp-plug|cli-oneshot(适配器形态)
  plug_port,                   -- 插座端口(默认 7080)
  login_state,                 -- ok|expired|unknown(主控不碰 token,只记状态)
  account_note,                -- 账号/费用备注(额度各落各的)
  capabilities_json,           -- 能力:[code,image,mcp,...]
  status,                      -- online|offline|degraded(由 mesh 健康探测回填)
  role_note,                   -- 分工备注(如"只接设计活")
  created_at, updated_at
)
-- ② projects:一个项目 = 身份 + 进展 + 载体
projects(
  id, name, one_liner,
  stage,                        -- 想法|未做|Base|开发中|Beta|完成|维护|退役
  priority, progress,           -- P0-P3 / 0-100
  next_action, blocked_reason,  -- 下一步行动(必填)/阻塞原因
  repo_path, docs_path, archive_path,
  links_json,                   -- 外部系统:[{name,url,note}]
  tags, created_at, updated_at
)
-- ③ tasks:工作项;mesh_task_id 关联派活
tasks(
  id, project_id, title, status,-- todo|doing|blocked|done
  due, priority, notes,
  harness_id,                   -- ← 指派给哪个 harness(员工档案外键)
  mesh_task_id,                 -- ← 派活后回填,双向可点
  created_at, done_at
)
-- ④ events:动态流,人/harness/bot 都能留痕
events(
  id, ts, kind,                 -- project|task|mesh|system
  project_id, task_id, harness_id,
  actor,                        -- 你/harness名/bot名
  summary, payload_json
)
```

与 harness-mesh 的关系:`harnesses.name` = mesh 节点表 name;mesh 负责"跑",project-hub 负责"档案+视角"(健康状态、派活记录、分工)。**初始数据:本系统自身+排班两条项目;5 个 harness 档案按 `info-alignment.md` 建。**

---

## 4. 文件管理(file-hub,D-d 按默认)

| 项 | 设计 |
|---|---|
| 形态 | DSH GUI 面板:目录树+列表+预览(文本/图片/pdf)+搜索+重命名/移动/删除(回收站) |
| 可见根 | `/root/data/myagents`(可管理)、`/root/.dreamx`(只读、默认折叠)、`/home/myxia/DshData`(只读) |
| 安全 | 路径锁死在允许根内(防穿越);删除=回收站(30 天);写操作过审批链 |
| 联动 | 项目卡片→开目录;派活 changes→逐文件预览;harness 档案→跳节点配置 |
| 分期 | v1(M12)只读+下载+回收站;v2 编辑/上传/批量 |

---

## 5. 目录与命名规范(208 本地,M10 落地)

```
/root/data/myagents/          # 一项目一目录,全部 git init;小写连字符
├── DSH_PiDurable/            # 本系统自身
└── <项目>/
/root/.dreamx/                # DSH 运行数据
├── harness-mesh/  project-hub/  file-hub/ backup-hub/
/opt/ann/                     # 我们自己的 ANN 服务(D-m:ctrl + 208 agent,替代 /opt/ann-agent)
/backup/snapshots/            # 温备(M15)
Samba://192.168.9.100/DshData/
├── backup/208/  archive/{palmboard,参考代码,<退役项目>}/
```

---

## 6. 里程碑(每步可验收、可回退)

### 6.0 总顺序

**R0(信息对齐) → R1(ANN 混合协议研究,重点) → M6(ANN 服务端重做+内网版) → M7(插头协议+harnessd+绿模守护+workbuddy 首节点) → M10(目录+归档) → M11(project-hub 从零) → M12(file-hub) → M13(旧系统退役) → M14(DSB 飞书入口) → M15(备份系统,最后做)**

### 6.1 harness 适配清单(D-k:锁定 5 个,一个一个适配)

| harness | 适配器 | 驻地 | 状态 |
|---|---|---|---|
| opencode | acp-stdio | 208 本机 | ✅ 已通(M1) |
| workbuddy | acp-plug(绿模) | WinPC(9.100) | ⬜ M7(等 ANN) |
| kimicode | acp-stdio/acp-plug | **待填(O2')** | ⬜ M7 后 |
| zcode | acp-plug | **待填(O2')** | ⬜ M7 后 |
| dsh | dsh-acp(DSH 互控) | 另一台 DSH | ⬜ 最后 |

### 6.2 部署形态

**ANN 节点命名与对齐规范(计算机名纳入,三视图同钥匙)**:
- **一个 ANN 节点 = 一台机器**(机器身份);机器上多个 harness 都是该节点下的插头,不按 harness 建节点
- **hostname 动态自报(D-q)**:agent 启动时自动取 OS 计算机名(`--hostname` 不传则自动生成;建议显式传 OS hostname 保证可读);入网/每次连接时经协议自报元数据:`{computer_name, os, lan_addr, ann_addr, plugs[]}`,服务端登记/更新,人工只确认不打表
- **tag 表达角色**:`tag:master`(208)/ `tag:agent`(被控机);将来按需加 `tag:win`/`tag:linux`
- **三视图主键统一**:ANN Web UI 节点列表 / project-hub `harnesses.computer_name` / harness-mesh 节点表,都用计算机名互相对齐;`ann_addr`(tailnet IP)入网后由自报回填档案,在线状态从 ann-ctrl REST(`/api/v1/nodes`)回填 `harnesses.status`

**208 服务端(D-m/D-n:我们自己的 ANN 服务,内网版)**:
- `ann-ctrl`:systemd --user 托管(myxia),数据目录自包含(默认本地盘),server-url=内网地址;STUN 打洞为主,DERP 留开关
- 208 节点 agent:root systemd 服务(我们自己的单元文件,TUN 模式→OS 级路由→插件直拨 tailnet IP,零 SOCKS 依赖)
- **旧 /opt/ann-agent 服务停用并禁用**(先停不断,保留二进制归档)
- 迁移路径:数据目录整拷 + 改 server-url + agent 重注册(节点少,重发码即可)

**ANN 重建记录(2026-10-16,ann-src/ 入项目库)**:
- 工具链 Go 1.26.3(`~/.local/go1.26.3`,goproxy.cn 镜像);产物 `ann-src/bin/{ann-ctrl,ann-agent,ann-agent.exe}`
- 补丁:P1 `--forward` 通用 TCP 转发(绿模核心);P2 短码修复(README 教短码→永远 401);P3 `pendingTags` 空 map panic(带 --tags 的码必崩);P4 重名主机 tag 被首个节点消费
- 部署:ann-ctrl(systemd --user `ann-ctrl.service`)+ 208 节点(`ann-agent-208.service`,myxia-ser=100.64.0.8,tag:master,SOCKS5 127.0.0.1:11090)
- M6 实测:短码入网 ✅ / tag 自动下发 ✅ / --forward 跨节点拨通 HTTP 200 ✅ / 无 tag 节点 ACL 丢弃(超时)✅

**Windows 绿模(D-i:无服务/无 admin/拷贝即用)**:
```
ann-agent.exe  --forward 7080=127.0.0.1:7080   ← 通用 TCP 转发(重建 ANN,spec 见 R1)
harnessd.py    监听 127.0.0.1:7080             ← 插头协议服务端
guardian.py    看护:崩溃重启/断线重连/空闲退出
```

### 6.3 里程碑明细

| 里程碑 | 内容 | 验收标准 | 状态 |
|---|---|---|---|
| **R0 信息对齐** | `info-alignment.md` 填全:设备清单+5 个 harness 档案;schema 定稿 | 每个 harness 有档案;每台设备有归属 | 🟡 schema 定稿;D-q 动态自报已实现(hello 自报实测);剩 O2'/O3' 待填 |
| **R1 混合协议研究** | §7 七个问题有结论+证据;`--forward`/守护 spec 定稿 | 研究文档评审通过 | ✅ **已完成**(`ann-hybrid-protocol-research.md`,2026-10-16;途中实锤 4 个 ANN bug 并修复) |
| **M6 ANN 服务端重做** | 停旧 agent;部署我们的 ann-ctrl+208 节点;ACL 收紧;WinPC 绿模入网 | 双节点互通;ACL 外拒绝;Web UI 可见 | 🟡 **ctrl+208 节点已上线**(systemd --user autostart;短码入网/tag 下发/--forward/SOCKS5 跨拨/ACL 拦截全实测);待:WinPC 绿模(包已交付 SMB,短码 24h)、旧 root agent 停用(待用户 sudo) |
| **M7 插头协议** | harnessd+acp-plug;workbuddy 首节点 | 派活 e2e 无回归 | 🟡 **回环三项全过**:dispatch 8.9s succeeded+结构化汇报;权限链(pending→API 放行→selected);cancel(挂起 agent→3s 宽限强制断流+杀远程进程→cancelled);待:workbuddy 真节点(绿模跑起后) |
| **M10 目录+归档** | §5 落地;散件归档+索引 | 本地无无主文件 | ⬜ |
| **M11 project-hub v1** | §3.2 四表;今日聚焦/项目池/看板/甘特/动态/导出+员工档案视图 | GUI 内管项目+档案;206:8400 可停 | ⬜ |
| **M12 file-hub** | 三根视图+预览+回收站+防穿越 | 浏览器管文件 | ⬜ |
| **M13 旧系统退役** | 停 206 掌盘归档;清单归档;重登记收尾 | 旧服务仅剩排班(在册) | ⬜ |
| **M14 DSB 入口** | 装 DSB→调度员 bot→MCP→飞书 | 手机飞书管全家桶 | ⬜ |
| **M15 备份系统** | 日快照+周冷备+恢复演练 | 2h 可恢复 | ⬜ 最后做 |

---

## 7. R1 · ANN 混合协议研究(重点中的重点)

**研究对象**:ANN = 控制面(Headscale)+ 数据面(tsnet/WireGuard)+ 打洞/中继(STUN/DERP)+ 本地 IPC(LocalAPI)+ 插头协议 + ssh 兜底。产出 `ann-hybrid-protocol-research.md`。

| # | 研究问题 | 现状/线索 |
|---|---|---|
| 1 | **准入**:短码 bug 修不修;bootstrap/enroll 审批/pre-auth token 选哪种;tag 自动下发 | 冒烟实锤短码 401;enroll 有审批流 |
| 2 | **数据面入站**:userspace 入站路径(in-process listener+`--forward` spec);DERP 何时必需;直连优先级 | echo 端口证明 listener 可用;`--forward` 需重建 |
| 3 | **连接生命周期**:plug 长连接建连→握手→保活→重连;netmap 更新时延;降级 ssh 的时机 | stale node/DB 污染有教训 |
| 4 | **安全**:CA 信任链;LocalAPI token;ACL 默认 allow-all 收紧;plug 签名+公钥钉扎;审计 | 冒烟实测无策略=放通 |
| 5 | **插头协议映射**:8 条 JSON-RPC 对传输的要求;TCP 长连接 vs 每次新建;权限同步语义 | 消息集见 v2 §2.3 |
| 6 | **绿模守护**:ann-agent+harnessd 看护策略;"MCP 连上后用进程守护"的对接点 | D-i 已定形态 |
| 7 | **实测矩阵**:建连时延/吞吐/DERP 回退/reconnect/stale 清理——208+第二节点实测 | 冒烟只验了同机双 agent |

**验收**:每问有结论+证据;决策回流 §0;未决点列预案。

---

## 7.4 日常功能:指定模型 + 开团(2026-10-17 建)

| 功能 | 入口(四层全通) |
|---|---|
| **指定模型** | MCP `harness_dispatch` 加 `model` 参数 / REST `/dispatch` 加 `model` / GUI 派活表单加模型输入框 / 适配器 `newSession(cwd, model)` 按任务覆盖节点默认(adapters 热生效,已向后兼容实测) |
| **开团(多节点并行)** | MCP `harness_team`{task, members:[{harness, role?}]} + `harness_team_result`{team_id} / REST `POST|GET /api/harness-mesh/team` / GUI 开团复选(多选节点)/ mesh `dispatchTeam`+`teamResult`(origin=team:<id> 归组聚合,零新存储) |

v1 范围:开团仅并行模式;role 经 prompt 前缀注入【你的角色:xxx】;聚合汇报按 origin 收齐。串行/DAG 在 Backlog。

## 7.4.0 进程模型不变量(2026-10-18 立,老徐确认)

**harness 进程一律"逐任务 spawn,干完即退"**:harnessd 每次 `task.open` spawn 一个全新进程(kimi.exe acp / zcode-adapter→zcode / wb-gateway-adapter→gateway / opencode acp),任务终态后退出。**没有任何 harness 有长驻进程。**

由此推导(全是体系设计的根):
1. **守护程序不需要为任何 harness 改代码**:keepalive 管隧道(ann-agent)+哨兵(mesh-guardian),start-all 管 harnessd——都是 harness 无关层;harness 的生死由 harnessd 按任务管,不归守护栈
2. **harness 私有长驻进程(如某 harness 自己的登录守护)不进 keepalive**——各 harness 私有进程不碰(绿模单例纪律的延伸;2026-10-17 修过"三 guardian 各起一份"的多实例 bug,根因就是违反了这条)
3. **改 harness 代码/配置零重启生效**:下次 task.open 自然加载最新文件(这就是"适配器热更新"的物理基础)
4. **任务间零状态泄漏**:每个任务是干净进程,崩溃隔离(一个任务崩不影响其他)
5. **harness 形态可以千差万别**(GUI Gateway/原生 ACP/薄适配器/-p 引擎),但只要遵守"被 harnessd spawn + stdio 说 ACP/行协议"这一个契约,上层全部统一

## 7.4.1 插件文件同步机制(2026-10-17 实锤,大坑)

**机制**:profile 的 `file:` 依赖由 pnpm 铺成 **node_modules 里的硬链接农场**(不是 symlink)。python `open(p,'w')` 原地写→硬链接同 inode→**node_modules 侧同步生效**(所谓"热路由"的物理基础)。
**坑**:**`sed -i` 会临时文件+重命名,把硬链接掰断**——之后项目侧的修改只进新 inode,node_modules 留旧 inode,表现为"改了不生效"且无任何报错(2026-10-17 审计丢失半小时,根菌在此)。
**纪律**:① 插件 lib 文件只用 python 原地写,禁用 sed -i;② **node --check 不过绝不 ln 进 node_modules**(`node --check X && ln -f X <nm路径>` 必须同链;2026-10-17 实踩:注释里混进一个裸 `#`,check 报了但 ln 已单独执行,运行侧挂了 3 分钟);② 每次批量改完跑一遍 inode 一致性检查(`for f in lib/*.js lib/adapters/*.js; do stat -c %i $f /root/.dreamx/profiles/web/node_modules/@agents/harness-mesh/$f; done`,两列相同即同步);③ 万一断过,`ln -f` 重建硬链接。

## 7.5 热加载架构(2026-10-16 重构,消灭适配器重启)

**背景**:适配器类静态 import 被 Node 进程缓存——改适配器代码必须重启 dreamx,每次重启打断进行中的会话(用户核心痛点,一天内发生 4 次)。

**重构**:`lib/adapters/index.js` 热加载器(mtime 缓存破坏动态 import)+ `mesh.js #adapterFor` 异步化(文件变→dispose 旧实例→新类重建;文件没变→原样复用连接)。

| 区域 | 文件 | 改动如何生效 |
|---|---|---|
| **热区(零重启)** | `lib/hot.js`、`lib/client.js`、`lib/adapters/*.js` | 保存即生效(API 每请求重导;适配器下个 dispatch 重建) |
| 重启区(低频) | `lib/mesh.js`、`lib/index.js`、`lib/http.js`、`lib/config.js` | 需重启进程;**纪律:先问用户、批量、说清理由** |

**实证**(2026-10-16 21:36):改 `acp-plug.js` → 派发 → 日志 `适配器热重载` → 进程启动时间不变(零重启)→ 任务正常跑。
**教训**(同记录):热加载补丁自身漏了一个 `await` 导致 `newSession is not a function`——修复它反而又需要一次重启(机制自身的鸡生蛋)。今后 mesh.js 级改动会先在回环节点全链验证再上线。

## 8. 文档家族(本仓库)

| 文档 | 角色 |
|---|---|
| `master-plan.md`(本文) | 总纲 |
| `system-blueprint.md` | **工程蓝本:思维导图/拓扑图/伪代码/审核报告/元信息索引** |
| `info-alignment.md` | **R0:设备/harness 信息对齐(待填)** |
| `harness-mesh-arch-v2.md` | harness 组网+ANN+插头协议+DSB |
| `harness-mesh-plan.md` | v1 决策史(M0–M5 事实源) |
| `ann-hybrid-protocol-research.md` | R1 产出 |
| `ops/monitor.sh` + `ops/status.md` + `ops/events.log` | **常驻跟踪**:30s 采样服务/ANN 节点/mesh 任务/频道/共享,变化记事件 |
| `\\192.168.9.100\DshData\AI协调频道\`(chat.log/chat.html/频道规约.md) | **DSH × WorkBuddy 协调频道**(append-only 留言板+自动渲染;plug 通后升级为任务驱动) |
| `\\192.168.9.100\DshData\harness-mesh-新节点接入包\`(接入指南.md+ann-agent.exe+harnessd.py+guardian.py+模板) | **新节点分钟级接入**(kimicode/zcode/dsh 将来各 ≤5 分钟;guardian 读 bootstrap.env 参数化) |
| `\\192.168.9.100\DshData\wb-green\harness-mesh-使用说明.md` | **harness-mesh 使用说明 v2 定稿**(DSH×WorkBuddy 合著;e2e 实录待回填) |
| `AI项目清单.md` | 旧清单(参考底稿,M13 归档) |

---

## 9. 目标与完成度(2026-10-19 全量盘点,实拨验证)

| 里程碑 | 预期目标 | 状态(实拨) | 备注 |
|---|---|---|---|
| R0 信息对齐 | 设备+harness 档案 | 🟢 超额 | 实际以"边做边对齐"完成:节点表/插头表/对齐 manifest/三频道 |
| R1 混合协议研究 | ANN 协议结论+spec | ✅ 完成 | 4 个 ANN bug 修复入 ann-src |
| M6 ANN 服务端 | ann-ctrl+208 节点+WinPC 绿模 | ✅ 完成 | 双节点互通+ACL;WinPC 绿模 systemd 保活在跑 |
| M7 插头协议+适配 | harnessd+插头;5 个 harness | ✅ **超额完成** | 四形态全通:workbuddy/zcode/kimicode/opencode(插头)+ opencode-local(stdio);MCP 入口+@直达+开团 |
| M10 目录+归档 | §5 落地;散件归档 | ⬜ 未开始 | |
| M11 project-hub | 四表+视图 | 🟢 **已上线**(驾驶舱,种子项目已灌) | 早于计划完成 |
| M12 file-hub | 三根视图+预览+回收站 | ⬜ 未开始 | |
| M13 旧系统退役 | 停 206 掌盘归档 | ⬜ 未开始 | |
| M14 DSB 入口 | DSB→bot→MCP→飞书 | 🟡 **DSB 已跑**(dev 实例,Bot 团队+harness 工具原生) | 待:飞书入口;正式化(挂 systemd/进主实例) |
| M15 备份系统 | 日快照+周冷备 | ⬜ 未开始 | git 已有三库;快照/冷备未做 |

### 剩余待办(按优先级)
1. **DSB 正式化**:dev 实例→systemd 服务(或并入主实例);飞书入口(M14 后半)
2. **M10 目录+归档**:散件归档+索引
3. **M12 file-hub**:文件管理
4. **M13 旧系统退役**
5. **M15 备份系统**:日快照+周冷备+恢复演练(最后)
