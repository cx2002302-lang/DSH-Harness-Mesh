# workbuddy 集成发布包

> 版本:v1.0(2026-10-17)· 状态:**全绿验收**(跨机任务+UI 操控 10/10)
> 适用:WinPC(CHINAMI-EKC4J2J)+ 主控机(master)的 workbuddy 接入全套

## 这个包里有什么

| 目录/文件 | 内容 | 部署到 |
|---|---|---|
| `DEPLOY.md` | **部署说明(先读它)**——架构图/三站部署/升级/验收/回滚/排错 | — |
| `server/` | 主控侧插件+运维(harness-mesh 全量、监控脚本) | 208(已部署,备份/升级用) |
| `client/` | WinPC 侧全套(绿模/适配器/配置/哨兵) | WinPC(共享 wb-green 是运行副本) |
| `docs/` | 全部开发文档(五类 24 份) | 随包分发 |

## 部署三步走(详见 DEPLOY.md)

1. **服务端**:`server/harness-mesh/` → `deploy.sh` → `pnpm install` → 分离式重启(约 10 秒断会话)
2. **客户端**:`client/green/`(绿模)+ `client/adapters/` + `client/config/plugs.json` → 运行目录(共享即运行副本)
3. **节点登记**:208 上加两条节点(exec+ui,同 address 不同 plugId),IP 以 `ann-ctrl node list` 实测为准

## 关键文档索引(先读这几份)

1. **《harness-mesh接口契约》**(docs/契约规范/)——三层模型+客户端对齐规则,**所有接入方第一份读的**
2. **《MCP客户端接入指南》**(docs/契约规范/)——客户端 5+2 工具怎么用
3. **《WorkBuddy授权唤醒作业指南》**(docs/对齐运维/)——授权层全景(20 天一次人工门)
4. **《WorkBuddy可操控能力清单》**(docs/对齐运维/)——UI 操控能力上限(HTTP vs CDP)
5. **《多Harness适配架构》+《统一配置能力清单》**(docs/适配架构/)——一个端口多 harness 的配置法

## 已知遗留(不阻塞)

- 管道间歇层:WG 抖动导致约 30% 任务需重试(失败有界:30s 建立/10min 任务)
- admin MCP 入口 + /session REST 待重启批激活
- 3 个 disabled 插头(zcode/kimicode/opencode)待接,SOP 见适配架构文档

## 维护纪律

- **本包由 `releases/build-release.sh` 从权威源生成**(server←项目、client←共享、docs←共享+项目);README/DEPLOY 是手写的,重新生成不会覆盖
- 每月或大变更后跑一次 build 防漂移
- 服务端插件改动的三条铁律(禁 sed -i / node --check 不过不 ln / 重启先问)见 DEPLOY.md §2

## 变更

- v1.0(2026-10-17):首个发布包。B 架构适配器 v5.2.1、wb-ui 行协议、10 工具验收、契约 hm-1、DEPLOY 部署说明
