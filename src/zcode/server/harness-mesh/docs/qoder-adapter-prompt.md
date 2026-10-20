# 给 Qoder IDE 里的 AI:写 C:\wb-mesh\qoder-adapter.py(ACP 适配器)

你在 Windows 机器上(与 workbuddy 同机)干活。目标:写一个纯标准库 Python 3 的 ACP 适配器 `C:\wb-mesh\qoder-adapter.py`,把本机已装的 Qoder CN CLI(`qoderclicn.exe`)包装成 harness-mesh 的 acp-plug 插头,让远端主控能按会话 spawn 它、发 prompt、收回复。用这个解释器:`C:\Users\Administrator\AppData\Local\Programs\Python\Python312\python.exe`。下面是全部背景、协议形状和验收标准,照做即可,不需要再问。

## 1. 背景:这套系统怎么跑

- DSH harness-mesh:每台被控机跑一个 `harnessd`(本机监听 127.0.0.1:7080),按 `C:\wb-mesh\plugs.json` 里登记的插头,**每来一个任务就 spawn 一个适配器进程**。适配器与主控之间跑的是:stdio 上的 NDJSON,JSON-RPC 2.0(ACP 子集)。也就是说:你的适配器从 stdin 读行、往 stdout 写行,每行一个 JSON;不用管 socket、不用管 harnessd 的内部协议——那是 harnessd 的事。
- 下游引擎是 Qoder CN CLI:`C:\Users\Administrator\.qoder-cn\bin\qoderclicn\qoderclicn.exe`(版本 1.0.25),已知支持这些参数:`-p/--print`(非交互一次性执行)、`-m/--model`、`--list-models`、`-w/--cwd`、`--output-format`、`-c/--continue`、`--permission-mode`。适配器的职责就是把 ACP 请求翻译成对它的 spawn 调用。

## 2. 动手前:先实测 CLI,别先写解析

写代码前先跑两条命令,把输出原样记进你的汇报里:

1. `qoderclicn.exe --list-models` — 摸清模型清单输出的真实格式(JSON?纯文本?带表头?),据此写解析。
2. `qoderclicn.exe -p "回复两个字:收到" -w <某个临时目录>` — 摸清 `-p` 的 stdout 长什么样(纯回复?带装饰行?),再试试 `--output-format` 有哪些取值、选一个最适合机器解析的。

解析逻辑以你实测到的输出为准,不要凭想象编。`--list-models` 失败或解析不出 → 模型表静默置空,不能让适配器崩。

## 3. 必须实现的协议(形状如下,不可自由发挥)

主控按行发请求,你按行回响应/通知:

### 3.1 `initialize`(请求)
回 `result`,内容:
```json
{"protocolVersion": 1, "contractVersion": "hm-1",
 "agentCapabilities": {"promptCapabilities": {"image": false}}, "authMethods": []}
```
`initialize` 必须零依赖秒回,不碰 CLI。

### 3.2 `session/new`(请求)
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

### 3.3 `session/prompt`(请求)
- 从 `params.prompt` 数组里取所有 `type=="text"` 块的 `text` 拼成一段文本。
- spawn `qoderclicn -p <text>`,带上 `-w <会话cwd>`;若该会话已 set_model,带上 `-m <模型>`。
- **在后台线程跑**(prompt 是阻塞的,不能卡住主循环读 stdin,否则 `session/cancel` 永远收不到;stdout 输出加锁串行化,JSON-RPC 靠 id 配对)。
- CLI 结束后:把回复文本通过 `session/update` 通知推给主控(`agent_message_chunk`,content `{"type": "text", "text": ...}`),然后回 prompt 的 result:`{"stopReason": "end_turn"}`;被取消回 `{"stopReason": "cancelled"}`;CLI 出错回 `{"stopReason": "refusal"}`(错误详情也走一条 update 通知,让主控能看到死因)。
- 一次 `qoderclicn -p` 就是一个完整回复,没有流式增量,不需要逐字推。

### 3.4 `session/cancel`(通知,无 id 不回)
置会话取消标志 + `terminate()` 正在跑的 qoderclicn 子进程;正在跑的 turn 随后以 `stopReason: "cancelled"` 收尾。注意 Windows 上 `proc.terminate()` 对管道里的孙进程不一定够,杀完确认进程真的没了,必要时收尸。

### 3.5 `session/set_model`(请求)
真支持:把 `params.modelId` 记到该 session 状态上,后续该会话的 prompt 都带 `-m`。校验 modelId 在模型表里,不在就回 JSON-RPC error `-32602`。成功就正常回空 result——**不要学 zcode 那套诚实拒绝,zcode 是因为它的 CLI 没有 `-m`,qoderclicn 有**。

### 3.6 未知方法 / 错误处理
- 未知方法且带 id → `{"jsonrpc": "2.0", "id": <rid>, "error": {"code": -32601, "message": "method not found: ..."}}`。
- 任何 handler 抛异常都只回一条 JSON-RPC error(`-32603` 或 `-32000`),主循环继续读下一行,**绝不让适配器进程崩**。

## 4. 注册插头

改 `C:\wb-mesh\plugs.json`,数组里追加一项(照抄现有 workbuddy-exec 条目的形状,只改 plugId/command/args):

```json
{"plugId": "qoder-exec", "kind": "acp",
 "command": "C:\\Users\\Administrator\\AppData\\Local\\Programs\\Python\\Python312\\python.exe",
 "args": ["C:\\wb-mesh\\qoder-adapter.py"], "cwd": null, "model": null}
```

harnessd 支持热重载、按会话 spawn,改 plugs.json 即生效,不需要重启 harnessd。如果 workbuddy 那条登记用了不同的字段名,以文件里现有条目为准照抄其结构。

## 5. 工程细节(都是 Windows 实踩会咬人的点)

- 启动时对 stdin/stdout/stderr 做 `reconfigure(encoding="utf-8")`;写 stdout 每行后 flush。
- 读 stdin 用 `for line in iter(sys.stdin.readline, "")`,不要 `for line in sys.stdin`(read-ahead 缓冲会吞行,阻塞 prompt 期间 cancel 读不到)。
- 文件统一 LF 落盘;路径全部用原始字符串或正斜杠写全(CLI 路径、python 路径都给全,不赌 PATH)。
- 所有诊断日志写 `C:\wb-mesh\logs\qoder-adapter.log`(目录不存在就建);**日志绝不写 stdout**——stdout 只准有 NDJSON,混进一行日志整条流就废了。
- 自测:`python -m py_compile C:\wb-mesh\qoder-adapter.py` 过了才算写完。
- NDJSON 冒烟:写个小脚本(或直接往进程 stdin 喂行),按顺序发四条——`initialize` → `session/new` → `session/prompt`(内容用"回复两个字:收到")→ `session/cancel`,把进程 stdout 原始输出完整收下来。

## 6. 验收标准(全满足才算完)

1. `py_compile` 通过。
2. 冒烟输出里:`initialize` 回了 `protocolVersion:1` + `contractVersion:"hm-1"`;`session/new` 的 result 里带 `configOptions`(模型表来自 `--list-models` 实测解析)。
3. `session/prompt` 能拿到 qoderclicn 的真实回复文本(不是空、不是报错占位),stopReason 正确。
4. `session/cancel` 后,qoderclicn 子进程无残留(用 `tasklist` 或等价方式确认)。
5. 汇报里给出:适配器文件完整路径、plugs.json 改动、`--list-models` 和 `-p` 实测的原始输出、四连冒烟的原始 NDJSON 输出。

干吧。遇到 CLI 行为和本文件描述不符的,以实测为准,并在汇报里说明差异。
