#!/bin/bash
# workbuddy 插头一键验证:hello 自报 → 探针任务 → 结构化汇报(节点上线后跑)
set -e
BASE=http://127.0.0.1:80; JAR=/tmp/hm-verify-jar.txt
DD=/home/myxia/.local/share/ann-ctrl
rm -f $JAR; curl -s -m 5 -c $JAR -L -o /dev/null "$BASE/?token=88888888"
IP=$(/home/myxia/.local/bin/ann-ctrl node list --data-dir=$DD 2>/dev/null | awk '$2 ~ /chinami/ && $5=="yes"{print $3}' | head -1 | cut -d, -f1)
[ -z "$IP" ] && { echo "chinami 不在线"; exit 1; }
echo "节点 IP: $IP"
# 节点地址同步(IP 可能变)
curl -s -m 5 -b $JAR -X POST "$BASE/api/harness-mesh/nodes" -H 'Content-Type: application/json' \
  -d "{\"name\":\"CHINAMI-EKC4J2J-workbuddy\",\"type\":\"acp-plug\",\"address\":\"$IP:7080\",\"plugId\":\"CHINAMI-EKC4J2J-workbuddy\",\"socks\":\"127.0.0.1:11090\",\"description\":\"Windows PC(CHINAMI-EKC4J2J)workbuddy,ANN 绿模\"}" > /dev/null
echo "--- 派探针任务 ---"
R=$(curl -s -m 10 -b $JAR -X POST "$BASE/api/harness-mesh/dispatch" -H 'Content-Type: application/json' -d '{
  "harness":"CHINAMI-EKC4J2J-workbuddy",
  "prompt":"探针任务:请汇报 1) 你当前的工作目录(cwd)2) 当前时间 3) 你所在机器的磁盘列表(盘符+总容量)4) 你使用的模型名。每项一行。",
  "cwd":null}')
TID=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin).get('task_id',''))" 2>/dev/null)
echo "task_id=$TID"
for i in $(seq 1 45); do
  S=$(curl -s -m 10 -b $JAR "$BASE/api/harness-mesh/task?task_id=$TID" | python3 -c "import sys,json;print(json.load(sys.stdin).get('status',{}).get('state'))" 2>/dev/null)
  echo "poll$i: $S"
  case "$S" in succeeded|failed|cancelled|timeout) break;; esac
  sleep 6
done
curl -s -m 10 -b $JAR "$BASE/api/harness-mesh/task?task_id=$TID" | python3 -c "
import sys,json
d=json.load(sys.stdin); r=d.get('result') or {}
print('=== 结果 ==='); print('state:',r.get('state')); print('summary:',r.get('summary')); print('changes:',r.get('changes')); print('duration_ms:',r.get('duration_ms')); print('error:',r.get('error'))"
