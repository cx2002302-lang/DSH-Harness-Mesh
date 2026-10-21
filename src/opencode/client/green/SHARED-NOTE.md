# 共享组件说明(绿模不随本包分发)

**绿模(ann-agent/harnessd_win/keepalive/mesh-guardian)与 workbuddy 发布包共用同一实例**——zcode 和 workbuddy 在同一台 WinPC(node-win-01)上,一个 7080 端口服务所有 harness。

**为什么不在本包复制一份**:复制部署会产生第二个 guardian/ann-agent——这正是 2026-10-17 修掉的"三解释器各起一份 guardian"多实例 bug 的成因。**绿模是单例资产,只能有一份**。

**绿模的正确来源**:
- 运行副本:<MESH_ROOT>(harnessd_win 的加载源,已与共享同步)
- 版本库:<INSTALL_DIR>(git,权威源)
- 发布备份:releases/workbuddy/client/green/(结构参考)

**zcode 特有的客户端文件只有两个**:`../adapters/zcode-adapter.py` + `../config/plugs.json` 里的 zcode-exec 条目。部署见 DEPLOY.md。
