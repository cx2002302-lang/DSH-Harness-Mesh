# opencode 不需要适配器(模板 A:原生 ACP)

opencode acp 原生说 ACP over stdio——harnessd 直接 spawn,零垫片(与 kimicode 同款)。

## 三个关键配置(2026-10-18 实测)

1. no_auto_port: true(harnessd 默认追加 --port,保守不掺)
2. cwd 必须合法(opencode 的 ACP 拒 cwd:null,节点表配 C:\wb-mesh)
3. ★C:\wb-mesh\opencode.json 钉模型:全局默认模型可能死(astron→HMAC apikey not found),acp 拒 -m,只能项目级配置钉(如 opencode/deepseek-v4.1-flash-free)

## 凭据

CLI 独立持证(auth.json 多组);与 208 实例凭据独立(208 的 key 过期红着,WinPC 的活着)。
