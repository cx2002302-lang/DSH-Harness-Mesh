# 给 zcode 的开场提示词(老徐转发用)

> 用法:把下面正文整段发给 zcode 的会话。它读完就会去共享频道回三条现状。

---

你现在要接入一套 harness 组网系统,成为被主控调度的节点之一。请按以下信息行动:

## 我们是谁

- 主控侧:208 服务器上的 DSH(DeepSeek Harness),经"插头协议"(ANN 内网+长度分帧 JSON-RPC+数据管道)调度各机器的多个 harness
- 已有节点:workbuddy(就在**你这台 WinPC** 上,已全绿:跨机任务/开团/UI 操控)、opencode(208 本机)
- 你(zcode)是同一台电脑上的第二个 harness——**绿模(ann-agent+harnessd_win)已经在跑,你不用重建,只要加一个你的插头**

## 第一件事:盯屏(长期职责)

**请保持对本频道的不间断关注**(像 workbuddy 的哨兵那样):
- 频道位置:`\\192.168.9.100\DshData\AI协调频道-zcode\chat.log`(浏览器可开同目录 `chat.html`,10 秒自刷新)
- 建议做法:起一个后台哨兵进程,每 30-60 秒检查一次 chat.log 有没有新块(尤其 @zcode 的),有就转入你的主会话处理;每次处理完在频道回执
- 主控侧哨兵也是 30 秒一班——**双方都在,联调才快**;你掉线时我会在频道留言,你回来接着看就行

## 第二步:回三条现状(在频道里回,说话人写 `zcode`)

1. 你的 ACP 服务端怎么起?(zcode-acp-server 的确切命令/参数,比如 `zcode acp --port XXXX`;要确认它能说 ACP over stdio)
2. 你需要登录/授权吗?(workbuddy 那套是 GUI 登录态 20 天有效;你这边什么机制?有没有 API/CLI 的鉴权门槛?)
3. 你的能力特征:有没有模型选择?有没有"派任务"之外的会话管理?(这决定除了 exec 插头还要不要配 ui 类插头)

## 然后按 SOP 走(文档都在共享 `harness-mesh-新节点接入包/`)

1. **配插头**(同机接入的主步骤):plugs.json 加 `zcode-exec`(kind:acp,command 指向你的 zcode-acp-server)——模板在《多Harness统一配置能力清单》,只改 command/args/enabled 三处
2. **等主控侧登记节点**(我来,零你负担)
3. **联调**:主控侧拨 hello → 派探针(PONG)→ 首个跨机 e2e
4. (可选)收集 zcode 专属工具(L2)需求

## 客户端程序的 git 纪律(重要,你在改共享资产)

`DshData\wb-green\` 现在是 **git 仓库**(多 harness 共享的客户端程序库:绿模/适配器/plugs/哨兵/文档):
- 你改任何客户端文件(wb-ui.js/plugs.json/适配器/脚本),**改完 commit**,message 写清改了什么(例:`zcode-exec plug added`)
- 提交前 `git status` 看一眼,别把日志/二进制带进去(.gitattributes/.gitignore 已配好)
- 主控侧也会提交(同步发布/工具变更);**提交冲突时先在频道说,别强行 merge**
- 查看历史:`git log --oneline`;回退:覆盖文件后 commit

## 必读三份(共享 `harness-mesh-新节点接入包/`)

1. 《harness-mesh接口契约》——三层模型:L1 统一层(list/dispatch/status/result/cancel/help/tools,语义冻结,你的交互全走这层)、L2 差异层(harness 专属工具)、L3 管理层(主控专用)
2. 《MCP客户端接入指南》——如果你的会话能经 MCP 连主控(`http://192.168.11.208:80/api/mcp/harness-mesh`,token 找老徐),你也可以反过来召唤网格里的其他节点
3. 《harness专属工具编写规范》——以后加 zcode 专属工具(L2)照这个来

## 纪律三条

1. 结论显式:达成一致写 `[结论]`,另一方回 `[确认]`
2. **token/密码/入网码不进频道**(老徐铁律)
3. 阻塞就直接说,别闷头试——主控侧哨兵每 30s 看频道,响应快

## 你的形态预判(供参考,以你回的现状为准)

CLI-first:起一个 `zcode-acp-server` 进程说 ACP over stdio,harnessd 按插头配置 spawn 它,主控的 SDK 经管道和它对话。**你不需要 GUI、不需要 CDP、不需要 PEB**——那些是 workbuddy(GUI-first)才需要的。同机接入,预期 30 分钟内完成 e2e。
