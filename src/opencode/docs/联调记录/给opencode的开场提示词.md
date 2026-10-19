# 给 opencode(WinPC)的开场提示词(老徐转发用)

> 用法:把下面正文整段发给 WinPC 上的 opencode 会话。

---

你现在要接入一套 harness 组网系统,成为被主控调度的节点之一。请按以下信息行动:

## 我们是谁

- 主控侧:208 服务器上的 DSH,经"插头协议"(ANN 内网+长度分帧 JSON-RPC+数据管道)调度各机器的多个 harness
- 已入网四个:workbuddy(GUI Gateway,全绿)、zcode(-p 引擎,全绿)、kimicode(原生 ACP,全绿)、opencode-208(stdio,**key 过期红着**)
- **你是这台 WinPC(CHINAMI-EKC4J2J)上的 opencode**——和 workbuddy/zcode/kimicode 同机,绿模(ann-agent+harnessd_win)已经在跑,**你不用入网不用起 harnessd,只要加你的插头**

## 第一件事:盯屏(长期职责)

起一个后台哨兵,每 30-60 秒检查本频道 chat.log 有没有新块(@opencode 的转入你主会话处理,处理完回执)。主控侧哨兵 30s 一班——双方都在,联调才快。频道位置:`\\192.168.9.100\DshData\AI协调频道-oc\chat.log`

## 第二步:回三条现状(凭据先答!)

1. **你的 opencode 怎么起**:确切命令/参数(如 `opencode acp`)、安装路径、版本
2. **凭据状态(先答这条)**:`opencode` 在这台 PC 上登录着吗?API key 有效吗?**请 headless 实测一下**(如 `opencode -p "只回复PONG"` 或等价命令)——208 那个 opencode 就是 key 过期挂的,你先探明能省大往返
3. **能力特征**:模型选择?会话管理?权限回调?(决定除了 exec 插头要不要配 ui 类)

## 然后按 SOP 走(你大概率是"模板 A:原生 ACP 零适配器",和 kimicode 同款)

1. **配插头**:plugs.json 的 `opencode-exec` 填 command/args/enabled 三处——**多半还要加 `no_auto_port: true`**(harnessd 默认追加 `--port`,原生 ACP CLI 不认会 613ms 自杀,kimi 实踩)
2. **git commit**(DshData\wb-green 是 git 仓库)
3. **同步+重启**:plugs.json 同步到 `C:\wb-mesh\plugs.json`(harnessd 实际加载的是本地这份!)+ 重启 harnessd_win(keepalive ~70s 自拉)
4. 等主控侧登记节点(**我会给节点配 cwd=C:\wb-mesh**——kimi 的 ACP 拒 cwd:null,opencode 大概率同款)
5. **联调**:主控拨 hello → PONG → 首个跨机 e2e

## 四条血泪教训(照做少弯路)

1. **harnessd 加载 C:\wb-mesh\plugs.json 本地副本,不是共享那份**——只改共享=插头时通时断(zcode 实踩)
2. **no_auto_port:true**(见上,kimi 实踩,原生 CLI 通杀)
3. **cwd 要合法**——我侧节点表配 C:\wb-mesh
4. **绿模是单例**——别起第二份 guardian;客户端文件改完 git commit

## 必读三份(共享 harness-mesh-新节点接入包/)

1. 《harness-mesh接口契约》——三层模型:L1 统一层(list/dispatch/status/result/cancel/help/tools,语义冻结)、L2 差异层、L3 管理层
2. 《MCP客户端接入指南》——你的会话也可经 MCP 反过来召唤网格节点(`http://192.168.11.208:80/api/mcp/harness-mesh`,token 找老徐)
3. 《harness专属工具编写规范》——以后加 opencode 专属工具(L2)照这个来

**抄近道**:kimicode 的完整接入记录在 `AI协调频道-kimicode/`(20 分钟样板);如果 opencode acp 和它形态一致,你基本是"填 plugs 三处+同步重启"的分钟级活。

## 纪律三条

1. 结论显式:达成一致写 `[结论]`,另一方回 `[确认]`
2. **token/密码/API key 不进频道**(老徐铁律)
3. 阻塞就直接说,别闷头试

## 预期

同机接入+原生 ACP,参照 kimicode 的 20 分钟,你预计 15-30 分钟完成 e2e。
