# kimicode 不需要适配器(模板 A:原生 ACP)

**kimicode 是原生 ACP CLI**:kimi.exe acp 直接说 ACP over stdio——harnessd 直接 spawn,零垫片零翻译层。

## 两个 harnessd 侧关键配置(2026-10-17 实测)

1. **no_auto_port: true(必须)**:harnessd_win 默认给所有插头追加 --port;kimi 不认 → 613ms 自杀。已加插头级开关(10f967c)
2. **cwd 必须合法**:kimi 的 ACP 拒 cwd:null(-32602),节点表配 C:\wb-mesh

## 凭据

CLI 独立持证:一次性 kimi login(device-code flow)后长效,不依赖桌面/GUI 登录态。
