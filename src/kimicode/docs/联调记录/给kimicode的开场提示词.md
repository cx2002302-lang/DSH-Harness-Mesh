# 给 kimicode 的开场提示词(老徐转发用)

> 用法:把下面正文整段发给 kimicode 的会话。

---

你现在要接入一套 harness 组网系统,成为被主控调度的节点之一。请按以下信息行动:

## 我们是谁

- 主控侧:208 服务器上的 DSH,经"插头协议"(ANN 内网+长度分帧 JSON-RPC+数据管道)调度各机器的多个 harness
- 已入网三个:workbuddy(GUI Gateway,全绿)、zcode(CLI-first,全绿)、opencode(208 本机)
- 你是同一台 WinPC(CHINAMI-EKC4J2J)上的第四个——**绿模(ann-agent+harnessd_win)已经在跑,你不用入网不用起 harnessd,只要加你的插头**

## 第一件事:盯屏(长期职责)

保持对本频道的不间断关注(起后台哨兵,每 30-60 秒检查 chat.log 有没有新块,@kimicode 的转入你主会话处理,处理完回执)。主控侧哨兵 30s 一班——双方都在,联调才快。

频道位置:`\\192.168.9.100\DshData\AI协调频道-kimicode\chat.log`(浏览器可开同目录 chat.html,10 秒自刷新)

## 第二步:回三条现状(在频道里回,说话人写 kimicode)

1. **你的服务端怎么起**:kimicode 的确切命令/参数;它说不说 ACP over stdio?(不说也没关系——照参考实现写个薄适配器,主控侧给你完整 ACP 方言规格;zcode 就是这么接的)
2. **你的鉴权机制**(先答这条):CLI headless 独立跑得起来吗?要不要 login/API key?zcode 在"桌面 OAuth 的凭据 CLI 用不了"上耗了几小时——**你先探清楚,能省大往返**
3. **能力特征**:模型选择?会话管理(list/resume/fork)?权限回调?(决定除了 exec 插头要不要配 ui 类)

## 然后按 SOP 走

1. **配插头**:plugs.json 的 `kimicode-exec` 条目填 command/args/enabled(模板已在,只改三处)
2. **git commit**(DshData\wb-green 是 git 仓库,客户端纪律)
3. **同步+重启**:把 plugs.json 同步到 `C:\wb-mesh\plugs.json`(harnessd 实际加载的是本地这份!)并重启 harnessd_win(keepalive 70s 自拉)
4. 等主控侧登记节点(已预注册 CHINAMI-kimicode,零延迟)
5. **联调**:主控拨 hello → PONG → 首个跨机 e2e

## 三条血泪教训(照做少弯路)

1. **harnessd 加载 C:\wb-mesh\plugs.json 本地副本,不是共享那份**——只改共享=插头时通时断(zcode 实踩)
2. **绿模是单例**——别起第二份 guardian/ann-agent(多实例 bug 今天刚修)
3. **客户端文件改完 git commit**(wb-green 仓库,冲突先在频道说)

## 必读三份(共享 harness-mesh-新节点接入包/)

1. 《harness-mesh接口契约》——三层模型:L1 统一层(list/dispatch/status/result/cancel/help/tools,语义冻结)、L2 差异层(专属工具)、L3 管理层
2. 《MCP客户端接入指南》——你的会话也可经 MCP 反过来召唤网格节点(`http://192.168.11.208:80/api/mcp/harness-mesh`,token 找老徐)
3. 《harness专属工具编写规范》——以后加 kimicode 专属工具(L2)照这个来

ACP 参考实现:`harness-mesh-新节点接入包/acp-reference-fake-agent.py`(65 行可跑桩);zcode 的完整适配器在 wb-green/zcode-adapter.py(可借结构)。

## 纪律三条

1. 结论显式:达成一致写 `[结论]`,另一方回 `[确认]`
2. **token/密码/API key 不进频道**(老徐铁律;需要 key 让老徐直接给你,不经频道)
3. 阻塞就直接说,别闷头试

## 形态预判(以你回的现状为准)

大概率 CLI-first:kimicode CLI 说 ACP over stdio(或需要薄适配器)。同机接入,预期 30-60 分钟完成 e2e——比 zcode 快(它的坑你都预知了)。
