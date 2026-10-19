# harness-mesh 接口契约:统一化与差异化管理

> 2026-10-17 立(本机用户指示)· **目的:服务端统一化+差异化管理,客户端对齐——服务端演进不改崩客户端**
> 配套:契约版本号已进 MCP initialize 响应(`contractVersion: "hm-1"`),客户端握手时可自检。

## 1. 三层接口模型(核心)

| 层 | 工具 | 语义 | 演进规则 |
|---|---|---|---|
| **L1 统一层**(所有 harness 同语义) | `harness_list / harness_dispatch / harness_status / harness_result / harness_cancel / harness_help / harness_tools` | **冻结**:同一个工具对任何 harness 含义相同 | 只增字段/工具,**永不改语义**;破坏性变更=升 contractVersion |
| **L2 差异层**(harness 专属) | `wb_info`、未来的 `kimi_models` 等 | 按 harness 演进,互不影响 | 命名空间隔离(`<prefix>_`),按《harness专属工具编写规范》 |
| **L3 管理层**(服务端编排) | `harness_team / harness_team_result / harness_tasks / harness_session` | 主控侧/受信编排者专用 | admin 入口可见,客户端入口不可见不可调 |

**划分铁律**:删掉某个 harness 后工具还有没有意义?有→L1;没有→L2。**禁止为单个 harness 的特殊需求往 L1 加字段**(那会污染所有客户端的上下文和语义)。

## 2. L1 统一层契约(冻结,客户端可死记)

### 2.1 请求/响应形状

```
harness_list {} → { nodes:[{name,type,target,health,running}] }
harness_dispatch {harness,prompt,cwd?,model?,timeoutMs?} → {task_id,state:"queued"}
harness_status {task_id} → {state,progress[],pending_permission?,error?}
harness_result {task_id} → {state,summary,changes,tests,artifacts,next_hint,duration_ms}
harness_cancel {task_id} → {state:"cancelling"}
harness_help {tool?} → 该工具完整用法 / 全部速览+SOP
harness_tools {harness?} → 该 harness 的专属工具 schema / 已配列表
```

### 2.2 语义规则(不变式)

- **状态机**:`queued → running → succeeded|failed|cancelled|timeout`;非终态用 status 轮询,终态用 result
- **task_id 格式**:`t-YYYYMMDD-xxxxxxxx`,原样传递,禁止拼装
- **prompt 自包含**:对端看不到客户端对话上下文(铁律)
- **pending_permission 非空**=等主控侧批权,等待而非重派
- **错误分类**(客户端按类处理,**禁止按错误文本匹配**):
  - 连接类(ECONNREFUSED/超时/握手)→ 网络或对端未就绪,重试或上报
  - 对端类(ACP closed/进程退出)→ 对端问题,上报主控侧
  - 参数类(缺字段/节点不存在)→ 客户端自己的 bug,修请求
  - 业务类(429 配额/401 授权)→ 见《授权唤醒作业指南》

### 2.3 变更规则(服务端纪律)

1. L1 只做**加法**:新字段(老客户端忽略)、新工具(老客户端不用)
2. 任何 L1 语义变更(状态机/字段含义/错误分类)= **升 contractVersion**(hm-1→hm-2),旧版本至少保留一个大版本周期
3. 每次变更记 `_对齐/changelog.md`,客户端按 contractVersion 对齐

## 3. 客户端对齐规则(防错乱)

1. **握手自检**:initialize 响应的 `contractVersion` + `unified` 清单,与客户端预期不符→**提示对齐,不要硬调**(服务端可能已升级)
2. **只依赖 L1 做派活**:任何 harness 都能接 list/dispatch/status/result/cancel——这是客户端"一次学会,处处可用"的保证
3. **能力渐进发现**:专属能力先 `harness_tools` 披露再用,不猜工具名
4. **L3 不可见**:客户端入口的 tools/call 碰 L3 会被拒(-32601)——这是设计不是故障
5. **model/cwd 等可选字段**:老服务端没有就忽略,客户端不报错(向前兼容)

## 4. 服务端差异化管理

- 每个 harness 的差异能力进 L2(专属工具),按《harness专属工具编写规范》登记/命名/写档
- harness 间差异(CLI-first/GUI-first/daemon-first)由适配器吸收, **L1 语义不受影响**——这是"统一化"的根基:客户端永远面对同一套语义,脏活在下行适配层
- 新 harness 接入 = 下行适配器 + (可选)L2 专属工具,**L1 零改动**

## 4.5 进程模型不变量(2026-10-18 立)

**harness 进程 = 逐任务 spawn,干完即退**(harnessd 每次 task.open spawn 新进程)。推论:① 改你的代码/配置零重启,下次任务自动加载 ② 任务间零状态泄漏、崩溃隔离 ③ 你的私有长驻进程(如有)不要期望被 keepalive 管——各 harness 私有进程不碰(单例纪律)④ 你的形态(原生 ACP/薄适配器/Gateway)只要遵守"被 spawn + stdio 说 ACP/行协议",上层全部统一。

## 5. 防错乱机制清单(今天建成+已有的)

| 机制 | 位置 | 作用 |
|---|---|---|
| 契约版本号 | initialize 响应(hm-1) | 客户端握手自检 |
| 对齐表 | `_对齐/双边状态对齐表.md` | 双边状态偏差显式化 |
| 变更台账 | `_对齐/changelog.md` | 每次变更可追溯 |
| 文件校验 | `_对齐/check_alignment.py` | 共享文件 drift 检测 |
| 入口隔离 | 客户端/admin 两入口 | L3 不污染客户端上下文 |
| 渐进披露 | harness_help/harness_tools | 重内容按需加载 |

## 6. 变更记录

- 2026-10-17 立约:hm-1。统一层 7 工具(含 help/tools 两个自描述工具)、管理层 4 工具、契约版本号进 initialize。
