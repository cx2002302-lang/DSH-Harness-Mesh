#!/bin/bash
# 项目跟踪监控(常驻):30s 采样;状态看板写在 ops/status.md,变化事件追加 ops/events.log
OPS=/root/data/myagents/DSH_PiDurable/ops
BASE=http://127.0.0.1:80
JAR=/tmp/hm-monitor-jar.txt
DD=${ANN_DATA:-/var/lib/ann-ctrl}
CHAT=${DSH_DATA:-/srv/dsh-data}/AI协调频道/chat.log
mkdir -p $OPS
prev_snap=""

plant() { curl -s -m 5 -c $JAR -L -o /dev/null "$BASE/?token=<DSH_TOKEN>" 2>/dev/null; }
plant

sample() {
  local snap=""
  # 服务
  for s in dreamx ann-ctrl ann-agent-208; do
    snap+="svc:$s=$(systemctl --user is-active $s.service 2>/dev/null);"
  done
  # ANN 节点(名=在线?)
  snap+="nodes:$(ann-ctrl node list --data-dir=$DD 2>/dev/null | awk 'NR>1 && $2!=""{printf "%s=%s,",$2,$5}');"
  # mesh 任务(最近 5 条的状态)
  snap+="tasks:$(curl -s -m 8 -b $JAR "$BASE/api/harness-mesh/tasks" 2>/dev/null | python3 -c "
import sys,json
try:
    ts=json.load(sys.stdin).get('tasks',[])[:5]
    print(','.join(f\"{t['task_id'][-6:]}:{t['state']}\" for t in ts))
except Exception: print('api-error')" 2>/dev/null);"
  # 协调频道(块数 + 最后说话人)
  if [ -f "$CHAT" ]; then
    snap+="chat:$(grep -c '^### ' "$CHAT" 2>/dev/null)blocks,last=$(grep '^### ' "$CHAT" 2>/dev/null | tail -1 | cut -c5-40);"
  fi
  # 共享新文件(最近 2 小时)
  snap+="share:$(find ${DSH_DATA:-/srv/dsh-data} -maxdepth 2 -mmin -120 -type f 2>/dev/null | wc -l)files;"
  echo "$snap"
}

while true; do
  snap=$(sample)
  ts=$(date "+%m-%d %H:%M")
  # 状态看板(人读)
  {
    echo "# 项目状态看板(自动,30s 采样)"
    echo
    echo "更新: $(date "+%Y-%m-%d %H:%M:%S")"
    echo
    echo '```'
    echo "$snap" | tr ';' '\n' | grep -v '^$'
    echo '```'
    echo
    echo "## 最近事件(变化才记)"
    echo
    tail -15 "$OPS/events.log" 2>/dev/null || echo "(暂无)"
  } > "$OPS/status.md.tmp" && mv "$OPS/status.md.tmp" "$OPS/status.md"
  # 事件 diff
  if [ -n "$prev_snap" ] && [ "$snap" != "$prev_snap" ]; then
    echo "### $ts 变化" >> "$OPS/events.log"
    echo "- 之前: $prev_snap" >> "$OPS/events.log"
    echo "- 现在: $snap" >> "$OPS/events.log"
  fi
  prev_snap="$snap"
  sleep 30
done
