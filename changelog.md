# Changelog

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
