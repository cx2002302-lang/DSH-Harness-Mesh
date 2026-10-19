#!/usr/bin/env python3
"""fake-slow-agent:挂起 300s 不应的假 ACP agent(开团/cancel 测试用)。"""
import json, sys, time
def send(o): sys.stdout.write(json.dumps(o)+"\n"); sys.stdout.flush()
for line in sys.stdin:
    try: msg = json.loads(line)
    except: continue
    m, rid = msg.get("method"), msg.get("id")
    if m == "initialize": send({"jsonrpc":"2.0","id":rid,"result":{"protocolVersion":1,"agentCapabilities":{},"authMethods":[]}})
    elif m == "session/new": send({"jsonrpc":"2.0","id":rid,"result":{"sessionId":"slow-1"}})
    elif m == "session/prompt": time.sleep(300)
