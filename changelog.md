# Changelog

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
