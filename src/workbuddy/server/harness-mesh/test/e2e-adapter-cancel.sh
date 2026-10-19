#!/bin/bash
# 适配器 cancel 路径回归:SLOW 慢任务 → cancel → 断言 Gateway 真收到 cancel
# 用法:先起 mock(9999)+harnessd(plugs 含 wb-adapter 插头),再跑本脚本
# 判定:PASS = mock.log 有 "CANCELLED via gateway";FAIL = 只靠主控强杀(mock 0 次)
BASE=http://127.0.0.1:80; JAR=/tmp/hm-cancel-jar.txt
curl -s -m 5 -c $JAR -L -o /dev/null "$BASE/?token=<DSH_TOKEN>"
R=$(curl -s -m 10 -b $JAR -X POST "$BASE/api/harness-mesh/dispatch" -H 'Content-Type: application/json' \
  -d '{"harness":"wb-adapter-test","prompt":"SLOW cancel-test:跑一个 30 秒的慢任务","cwd":"/tmp"}')
TID=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin).get('task_id',''))" 2>/dev/null)
echo "task_id=$TID"; sleep 6
curl -s -m 5 -b $JAR -X POST "$BASE/api/harness-mesh/cancel" -H 'Content-Type: application/json' -d "{\"task_id\":\"$TID\"}" > /dev/null
sleep 10
S=$(curl -s -m 8 -b $JAR "$BASE/api/harness-mesh/task?task_id=$TID" | python3 -c "import sys,json;d=json.load(sys.stdin);print((d.get('result') or {}).get('state') or d['status']['state'])" 2>/dev/null)
GWC=$(grep -c "CANCELLED via gateway" /tmp/mock.log 2>/dev/null || echo 0)
echo "任务终态: $S | Gateway 实收 cancel: $GWC 次"
if [ "$GWC" -gt 0 ]; then echo "PASS: 优雅取消生效(Gateway run 被回收)"; exit 0
else echo "FAIL: cancel 只靠主控强杀——适配器 session/cancel 未被处理(阻塞式 prompt);Gateway run 泄漏"; exit 1; fi
