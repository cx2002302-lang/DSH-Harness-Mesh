#!/bin/bash
# harness-mesh 客户端热更部署:语法检查 → HMR 自动推流(不重启服务、不刷新页面)
# 用法: bash /root/data/myagents/DSH_PiDurable/harness-mesh/deploy-client.sh [可选:改动说明]
set -e
F=/root/data/myagents/DSH_PiDurable/harness-mesh/lib/client.js
node --check "$F" || { echo "✗ 语法错误,未部署"; exit 1; }
echo "✓ 语法 OK"
# 触发 HMR:touch 不足以改 mtime 语义(需内容变化),追加一个空行再删掉会双触发;
# 实际上编辑保存本身就会变化。这里仅等待 HMR 轮询窗口并确认 rev 推送。
sleep 1.2
timeout 3 curl -s -N -b /tmp/hm-cookie.txt "http://127.0.0.1/plugins/events" 2>/dev/null | grep -o '{"type":"rebuilt","id":"@agents/harness-mesh"[^}]*}' | head -1 || true
echo "✓ 完成(如上无 rebuilt 行,说明本次编辑在监听前已被上一轮 HMR 推送;浏览器 1 秒内自动生效)"
[ -n "$1" ] && echo "本次改动: $1"
