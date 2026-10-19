# DSH Harness Mesh v1.1 — 发布说明

**发布日期:** 2026-10-19 · **许可:** MIT · **基线:** v1.0

## 新能力

- **模型桥**——网格节点上钉的模型自动注册进 LLM 供应商目录(经 `ctx.settings.mutate` 走 volatile 热同步;改节点表,模型下拉框跟着变,零重启)。手工配置的供应商永不被覆盖。
- **全量测试战役**——286 个 `node:test` 单测(8 个新套件:stores / tools / mesh / hot / http / acp-stdio / acp-plug / harness-tools)+ e2e 三件套(派发/权限/取消)在真实链路上全绿。

## 修 bug(全部由测试战役发现)

1. **acp-stdio**:`initialize` 失败的子进程无人杀 → 进程泄漏;现在就地 SIGTERM。
2. **acp-plug**:`hello` 失败的 socket 无人毁 → 连接泄漏;现在当场关闭。
3. **nodes-store**:`nodes.json` 里一条非法条目会让它后面的好条目全部静默丢失 → 逐条校验,坏条目跳过并点名进日志。
4. **task-store**:缺 `task_id` 的 `create()` 产生幽灵记录(内存 `undefined` 键、重启即丢)→ 入口即拒。
5. **http**:摘除死路由 `GET /api/harness-mesh/models`(v1.0 起注册、从未实现)。
6. **wb-gateway-adapter**:`session/prompt` 阻塞读循环,`session/cancel` 永远读不到(取消退化成主控强杀)→ turn 挪进后台线程 + stdout 写锁,优雅取消全链路验证通过。

## 加固 / 脱敏

- wb-ui 节点改为按 `plugId=workbuddy-ui` / 名字匹配自动发现,不再硬编码主机名。
- 客户端"打开 DSB"按钮改为用当前主机 + 页面 token 合成地址(`localStorage["hm.dsbUrl"]` 可覆盖),源码零内网信息。
- `guardian.py` 不再内置入网码/主控地址默认值(必须走 `bootstrap.env`)。
- `harnessd.py` 内网地址探针改用 RFC 5737 文档段。
- 测试夹具与 README 示例全部泛化。

## 验证

```bash
cd src/<形态>/server/harness-mesh   # workbuddy | zcode | kimicode | opencode
npm test                            # 286/286 全绿
```
