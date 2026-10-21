# Changelog

## v1.3.1 — 2026-10-21

- harnessd f312dea:attach-EOF 宽限(plug.env HM_ATTACH_GRACE_S,默认 0=断开即收树)+ 交棒吞帧修复(_stream_out 单线程按当前连接投递)+ 收口统一(先杀树后关管;广播 reason=attach_lost|pipe_closed)
- 注意:日志信号变更——"数据管道结束 <sid>" 已移除,替代为 "流 <sid> 收口 reason=..."


## v1.3.0 — 2026-10-21

- 客户端件大修(必修 1-7):适配器并发/死锁/孤儿收尸/单例锁/频道写入锁全面加固
- wb-gateway-adapter 多轮丢终文修复
- harnessd:未知 plugId 由静默回退改**硬报错** + plug.env 注入 + 收树(承接 v1.2.9 备忘)
- 红线脱敏:入库文件全部清除内网 IP/机器名/人名/入网码/真实部署路径字面量,统一改 `<PLACEHOLDER>` 占位符 + env 覆盖说明;新增 src/qoder/client/config/plugs.example.json(6 插头全占位符模板)
- qoder 入网收录:新建 src/qoder/(qoder-adapter.py + README/DEPLOY),qoderclicn CN CLI 经适配器接入(承接 v1.2.9)

## v1.2.9 — 2026-10-21

- qoder(Qoder CN CLI qoderclicn)入网:qoder-adapter.py ACP 插头 + qoder-exec 注册,验收五项全绿(冒烟/节点登记/探测 2 模型/e2e 真回复/cancel)
- 实踩备忘:新节点须带 socks userspace 兜底;harnessd 未知 plugId 静默回退默认插头是隐患(待 wb-green 改硬报错)

## v1.2.8 — 2026-10-20

- qoder 开场提示词 v2:对齐 kimicode 频道模板,补接入包文档引用与 MCP 对接网址

## v1.2.7 — 2026-10-20

- 撤掉 qoder-chat 面板页(聊天改走 AI协调频道静态页惯例)

## v1.2.6 — 2026-10-20

- 面板新增 qoder-chat 聊天页(dispatch+轮询,错误路径实测)
- docs/qoder-adapter-prompt.md:Qoder CN CLI(qoderclicn)的 ACP 适配器编写提示词

## v1.2.5 — 2026-10-20

- 名册行名字左对齐(修复 space-between 把名字挤到行中间)

## v1.2.4 — 2026-10-20

- workbuddy 模型清单对齐 GUI 选择器:新增官方目录缓存(acc-product-config-v3.json)源,自带 45 + 自定义 4 全量上报,自定义项独立标记

## v1.2.3 — 2026-10-20

- wb-gateway-adapter 回收生产 v5 真身(端口自动发现/PEB 密码),补模型上报;修复 prompt 阻塞导致 session/cancel 失灵
- workbuddy 探测实测返回 4 型号(MiniMax-M3.1-Flash-Preview / kimi-K2.7-Code / kimi-k2.6 / glm-5.3)

## v1.2.2 — 2026-10-20

- workbuddy/zcode 适配器在 session/new 上报模型表(configOptions 方言),mesh 可直接探测
- 名册行加手填兜底;harness 不支持选模型时 set_model 诚实拒绝而非静默跑错

## v1.2.1 — 2026-10-20

- 交互调整:可用模型从编辑表单移到名册行内(▸ 展开 → 探测 → 勾选即自动保存)

## v1.2 — 2026-10-20

- 节点管理"可用模型":探测按钮读 harness 真实模型表(兼容标准 ACP availableModels 与 opencode configOptions 方言),折叠区勾选白名单;派发表单模型位随白名单变下拉;名单外模型 dispatch 拒绝
- 探测零重启:一次性适配器实例 + 热加载;DSB 按钮免 token 直开(v1.1.1/v1.1.2 并入本线)

## v1.1.2 — 2026-10-19(热修)

- 修 v1.1.1 的 iframe 预登录竞态:空 iframe 的 about:blank onload 抢跑导致预登录被提前摘除(无头浏览器实测抓到,先指 src 再入 DOM)

## v1.1.1 — 2026-10-19(热修)

- DSB 按钮免 token 直开:新端点 `GET /api/harness-mesh/dsb-open` 出一次性登录地址,客户端隐藏 iframe 预登录后开干净 URL,地址栏全程无 token(老实例经 `nodes?dsb=1` shim 热加载生效)

## v1.1 — 2026-10-19

- 模型桥:网格节点钉的模型自动注册为 LLM 供应商(volatile 热同步,零重启)
- 全量测试:286 单测 + e2e 三件套全绿;修 6 个真 bug(双泄漏/双静默丢失/死路由/阻塞式 cancel)
- 脱敏加固:wb-ui 节点自动发现、DSB 按钮地址合成、guardian 去内置入网码、harnessd 探针改文档段
- 发布说明:[RELEASE-v1.1.zh.md](RELEASE-v1.1.zh.md) · [English](RELEASE-v1.1.md)

## v1.0 — 2026-10-18

- 首次发布:四形态 harness 适配(workbuddy/zcode/kimicode/opencode)+ DSB Bot 团队集成
- 发布说明:[RELEASE-v1.0.zh.md](RELEASE-v1.0.zh.md) · [English](RELEASE-v1.0.md)
