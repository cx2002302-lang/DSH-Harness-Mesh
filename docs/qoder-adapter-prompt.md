# 给 qoder 的开场提示词(管理员转发用)

> 用法:把下面正文整段发给 qoder 的会话。

---

你要接入 harness 组网系统,成为被主控调度的节点之一。

**我们是谁**:主控侧 = DSH 服务器,插头协议调度;已入网 workbuddy / zcode / kimicode / opencode。你是同机第五个,绿模(ann-agent + harnessd_win)已经在跑,你只需要加插头。

**第一件事:盯屏(长期职责)**。30-60 秒哨兵盯频道 chat.log,`@qoder` 的转主会话处理并回执。频道位置:`\\<LAN-IP>\<MESH_ROOT>\AI协调频道-qoder\chat.log`;浏览器可开同目录 chat.html,10 秒自刷新。

**第二步:我们已探明的现状(你确认/纠偏即可)**:

- CLI = `<USERPROFILE>\.qoder-cn\bin\qoderclicn\qoderclicn.exe`,版本 1.0.25,已知支持 `-p/--print`、`-m/--model`、`--list-models`、`-w/--cwd`、`--output-format`、`-c/--continue`、`--permission-mode`。
- 鉴权待你确认:headless 模式是否独立可跑。
- 能力特征:`--list-models` 模型选择、`--list-sessions`/`-c` 会话、`--permission-mode`。

**核心任务**:写 `<MESH_ROOT>\qoder-adapter.py`,把 qoderclicn 包装成 harness-mesh 的 acp-plug 插头。适配器为纯标准库 Python 3,解释器用 `<USERPROFILE>\AppData\Local\Programs\Python\Python312\python.exe`。技术规格见下方「适配器技术规格」章节(先实测 CLI、六个协议方法的确切形状、工程细节五条、验收标准五条,原文照做)。

**按 SOP 走**:

1. wb-green 仓库配插头(`qoder-exec` 条目);
2. git commit;
3. 同步 plugs.json 到 `<MESH_ROOT>\plugs.json` 并重启 harnessd_win(keepalive 70 秒自拉);
4. 等主控登记 node-win-01-qoder 节点;
5. 联调 hello → PONG → e2e。

插头条目形状(照抄现有 workbuddy-exec 条目结构,只改 plugId/command/args;若现有条目字段名不同,以文件为准):

```json
{"plugId": "qoder-exec", "kind": "acp",
 "command": "<USERPROFILE>\\AppData\\Local\\Programs\\Python\\Python312\\python.exe",
 "args": ["<MESH_ROOT>\\qoder-adapter.py"], "cwd": null, "model": null}
```

**三条血泪教训**(照抄):① harnessd 加载的是本地 `<MESH_ROOT>\plugs.json` 副本;② 绿模单例,别起第二个;③ wb-green 改完必须 git commit。

**必读**(共享目录 `harness-mesh-新节点接入包/`,UNC `\\<LAN-IP>\<MESH_ROOT>\harness-mesh-新节点接入包\`):《harness-mesh接口契约》(L1/L2/L3 三层)、《MCP客户端接入指南》(你的会话可经 MCP 反召唤网格,对接网址 `http://<ANN-NODE-IP>:<ANN-PORT>/api/mcp/harness-mesh`,token 找管理员)、《适配器编写指南》、acp-reference-fake-agent.py(65 行可跑桩);zcode 完整适配器 `wb-green/zcode-adapter.py` 可借结构。

**纪律三条**:[结论]/[确认] 前缀;token/密码/API key 不进频道;阻塞直说。

**形态预判**:已确认 CLI-first 且 CLI 能力齐全,比 kimicode 还顺,预期 30 分钟 e2e。

---

## 适配器技术规格

### 一、动手前:先实测 CLI,别先写解析

写代码前先跑两条命令,把输出原样记进你的汇报里:

1. `qoderclicn.exe --list-models` — 摸清模型清单输出的真实格式(JSON?纯文本?带表头?),据此写解析。
2. `qoderclicn.exe -p "回复两个字:收到" -w <某个临时目录>` — 摸清 `-p` 的 stdout 长什么样(纯回复?带装饰行?),再试试 `--output-format` 有哪些取值、选一个最适合机器解析的。

解析逻辑以你实测到的输出为准,不要凭想象编。`--list-models` 失败或解析不出 → 模型表静默置空,不能让适配器崩。

### 二、必须实现的协议(形状如下,不可自由发挥)

主控按行发请求,你按行回响应/通知(stdio 上的 NDJSON,JSON-RPC 2.0,ACP 子集):

#### 2.1 `initialize`(请求)
回 `result`,内容:
```json
{"protocolVersion": 1, "contractVersion": "hm-1",
 "agentCapabilities": {"promptCapabilities": {"image": false}}, "authMethods": []}
```
`initialize` 必须零依赖秒回,不碰 CLI。

#### 2.2 `session/new`(请求)
本地生成 sessionId(如 `qo-<时间戳>-<序号>`),记下 `params.cwd`。然后在 result 里带模型表(opencode 方言的 select 型 `configOptions`),形状:

```json
{"sessionId": "<本地sid>",
 "configOptions": [{
   "id": "model", "name": "Model", "category": "model", "type": "select",
   "currentValue": "<默认模型>",
   "options": [{"value": "<模型id>", "name": "<模型id>"}, ...]
 }]}
```

- 模型来源:`qoderclicn --list-models` 的输出,解析后按序去重;**缓存 60 秒**,期内不重复调 CLI。
- CLI 失败/解析为空 → result 不带 `configOptions` 字段(静默空表),照常回 sessionId。

#### 2.3 `session/prompt`(请求)
- 从 `params.prompt` 数组里取所有 `type=="text"` 块的 `text` 拼成一段文本。
- spawn `qoderclicn -p <text>`,带上 `-w <会话cwd>`;若该会话已 set_model,带上 `-m <模型>`。
- **在后台线程跑**(prompt 是阻塞的,不能卡住主循环读 stdin,否则 `session/cancel` 永远收不到;stdout 输出加锁串行化,JSON-RPC 靠 id 配对)。
- CLI 结束后:把回复文本通过 `session/update` 通知推给主控(`agent_message_chunk`,content `{"type": "text", "text": ...}`),然后回 prompt 的 result:`{"stopReason": "end_turn"}`;被取消回 `{"stopReason": "cancelled"}`;CLI 出错回 `{"stopReason": "refusal"}`(错误详情也走一条 update 通知,让主控能看到死因)。
- 一次 `qoderclicn -p` 就是一个完整回复,没有流式增量,不需要逐字推。

#### 2.4 `session/cancel`(通知,无 id 不回)
置会话取消标志 + `terminate()` 正在跑的 qoderclicn 子进程;正在跑的 turn 随后以 `stopReason: "cancelled"` 收尾。注意 Windows 上 `proc.terminate()` 对管道里的孙进程不一定够,杀完确认进程真的没了,必要时收尸。

#### 2.5 `session/set_model`(请求)
真支持:把 `params.modelId` 记到该 session 状态上,后续该会话的 prompt 都带 `-m`。校验 modelId 在模型表里,不在就回 JSON-RPC error `-32602`。成功就正常回空 result——**不要学 zcode 那套诚实拒绝,zcode 是因为它的 CLI 没有 `-m`,qoderclicn 有**。

#### 2.6 未知方法 / 错误处理
- 未知方法且带 id → `{"jsonrpc": "2.0", "id": <rid>, "error": {"code": -32601, "message": "method not found: ..."}}`。
- 任何 handler 抛异常都只回一条 JSON-RPC error(`-32603` 或 `-32000`),主循环继续读下一行,**绝不让适配器进程崩**。

### 三、工程细节(都是 Windows 实踩会咬人的点)

- 启动时对 stdin/stdout/stderr 做 `reconfigure(encoding="utf-8")`;写 stdout 每行后 flush。
- 读 stdin 用 `for line in iter(sys.stdin.readline, "")`,不要 `for line in sys.stdin`(read-ahead 缓冲会吞行,阻塞 prompt 期间 cancel 读不到)。
- 文件统一 LF 落盘;路径全部用原始字符串或正斜杠写全(CLI 路径、python 路径都给全,不赌 PATH)。
- 所有诊断日志写 `<MESH_ROOT>\logs\qoder-adapter.log`(目录不存在就建);**日志绝不写 stdout**——stdout 只准有 NDJSON,混进一行日志整条流就废了。
- 自测:`python -m py_compile <MESH_ROOT>\qoder-adapter.py` 过了才算写完。
- NDJSON 冒烟:写个小脚本(或直接往进程 stdin 喂行),按顺序发四条——`initialize` → `session/new` → `session/prompt`(内容用"回复两个字:收到")→ `session/cancel`,把进程 stdout 原始输出完整收下来。

### 四、验收标准(全满足才算完)

1. `py_compile` 通过。
2. 冒烟输出里:`initialize` 回了 `protocolVersion:1` + `contractVersion:"hm-1"`;`session/new` 的 result 里带 `configOptions`(模型表来自 `--list-models` 实测解析)。
3. `session/prompt` 能拿到 qoderclicn 的真实回复文本(不是空、不是报错占位),stopReason 正确。
4. `session/cancel` 后,qoderclicn 子进程无残留(用 `tasklist` 或等价方式确认)。
5. 汇报里给出:适配器文件完整路径、plugs.json 改动、`--list-models` 和 `-p` 实测的原始输出、四连冒烟的原始 NDJSON 输出。

干吧。遇到 CLI 行为和本文件描述不符的,以实测为准,并在汇报里说明差异。
