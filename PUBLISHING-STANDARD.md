# DSH Harness Mesh 发布标准(v1.0 · 2026-10-19)

本文件是本项目对外发布的**强制规范**。任何内容进入 GitHub 发布物(仓库/Release/镜像)前必须逐条过检。

## 1. 发布物构成

```
仓库 cx2002302-lang/DSH-Harness-Mesh
├── README.md / README.zh-CN.md    双语项目页(必挂架构图)
├── index.html                     双语切换查看页(可挂 Pages)
├── infographic-*.jpg              架构信息图(MiniMax image-01 生成,置页顶)
├── screenshots/                   真实界面截图(≤4 张,见 §3)
├── src/                           ★源码树(唯一随仓库发布的程序内容)
│   ├── workbuddy/  zcode/  kimicode/  opencode/     四形态 harness 适配
│   └── (各含 server 插件 / client 绿模 / 部署文档 / 构建说明)
├── LICENSE                        MIT
└── PUBLISHING-STANDARD.md         本文件
```

## 2. 源码发布(硬规则)

**只发源码,不发编译产物。** 用户下载后自行编译。

| 允许 | 禁止 |
|---|---|
| .py/.js/.ts/.tsx/.json/.yml/.md | .exe / .dll / .so / .bin |
| 构建脚本(build.sh/Makefile) | node_modules / __pycache__ |
| 配置样例(*.example.*) | 含真实 key/token 的 .env |
| 部署文档(含内网 IP 说明) | 日志 / *.bak-* / 临时文件 |

**构建方式必须写进各包的 DEPLOY.md**(依赖、命令、产物位置),不得让用户猜。

## 3. 截图标准(发布页门面)

1. **必须突出本项目能力**(调度/派发/多节点协作),禁止放空界面、通用皮肤、与项目无关的页面。
2. 数量 ≤4 张,2×2 排布,英文/中文双语 caption。
3. 必须是**真实运行截图**(无头或实拍),不得用渲染图冒充界面。
4. 压缩为 JPEG(质量 4/scale 1400),单张 ≤350KB。
5. 含他人 UI(DSB 等上游项目)时,主体须是**本项目的集成效果**(如 Bot 调 harness 的对话),非上游原生页面。

## 4. 敏感信息(发布前一票否决)

发布前必过(任一命中即打回):

```bash
# 在发布物根目录执行
grep -rnE "sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|Bearer [A-Za-z0-9]{20,}" .   # API key / token
grep -rnE "(password|secret)['\"]?\s*[:=]\s*['\"][^'\"]{6,}" .                      # 硬编码密码
find . -name "*.exe" -o -name "*.dll" -o -name "*.pem" -o -name ".env" -o -name "*.bak-*"
```

- 内网 tailnet IP(100.64.0.x)/局域网 IP 可出现在**部署文档**(用户部署必需),不得出现在截图与代码注释。
- `.env`/凭据文件一律 `git rm --cached` + `.gitignore`,只留 `*.example.*`。
- token 类(ghp_ 等)只走环境变量/一次性 remote URL,**推完即擦**(`grep -c ghp_ .git/config` 必须为 0)。

## 5. 发布流程(固定顺序)

1. **源同步**:`releases/build-release.sh`(四包重建,必须幂等——连跑两次零变化)
2. **源码树**:rsync 四包 → `github/src/`(排除规则见 §2)
3. **体检**:敏感扫描(§4)+ 二进制零残留 + `node --check` 全过
4. **页面**:README 双语(架构图置顶)+ index.html 双语切换 + 截图按 §3
5. **推送**:`git push`(token 走 remote URL,推完 `set-url` 擦净)
6. **Release**:建 tag(vX.Y),正文=英文发布页,资产挂:信息图×2 + 截图×4 + 源码 zip
7. **验证**:raw 链接逐个 200;Release 资产 downloadable
8. **归档**:changelog.md 记一条(时间+内容+链接)

## 6. 版本号

语义化 `v主.次.修订`。补丁级修复(客户端 patch/harness-mesh 工具)→ 修订+1;新 harness 形态/新工具面 → 次+1;协议/架构变更 → 主+1。

## 7. 回退

任何发布后发现问题:Release 页可编辑/删资产;代码问题 `git revert` 后按 §5 全流程重发,changelog 记回退原因。
