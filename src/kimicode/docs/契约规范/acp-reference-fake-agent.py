#!/usr/bin/env python3
"""fake-acp-agent — 权限链集成测试用的假 ACP agent(stdio NDJSON)。

行为:initialize/session/new 正常应答;session/prompt 时先发一个
session/request_permission(标题与 rawInput 都含 rm -rf,命中 mesh 的 DEFAULT_DENY),
等主控回传决定后:
  - allow(selected) → 回 prompt 结果 end_turn
  - reject/cancelled  → 回 prompt 结果 cancelled
用于验证 harness-mesh 权限链在 plug 传输下的完整性(不依赖真实 harness 的权限策略)。
"""
import json
import sys

pending_prompt_id = None


def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    global pending_prompt_id
    session_id = None
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        method = msg.get("method")
        rid = msg.get("id")
        if method == "initialize":
            send({"jsonrpc": "2.0", "id": rid, "result": {
                "protocolVersion": 1, "agentCapabilities": {}, "authMethods": []}})
        elif method == "session/new":
            session_id = "fake-session-1"
            send({"jsonrpc": "2.0", "id": rid, "result": {"sessionId": session_id}})
        elif method == "session/prompt":
            pending_prompt_id = rid
            send({"jsonrpc": "2.0", "id": 9001, "method": "session/request_permission", "params": {
                "sessionId": session_id,
                "toolCall": {"toolCallId": "fake-tool-1", "title": "fake 危险操作:rm -rf /tmp/fake-danger",
                             "kind": "execute", "rawInput": {"command": "rm -rf /tmp/fake-danger"}},
                "options": [
                    {"optionId": "allow-once", "kind": "allow_once", "name": "允许一次"},
                    {"optionId": "reject-once", "kind": "reject_once", "name": "拒绝"},
                ],
            }})
        elif rid == 9001:
            outcome = (msg.get("result") or {}).get("outcome") or {}
            selected = outcome.get("outcome")
            send({"jsonrpc": "2.0", "method": "session/update", "params": {
                "sessionId": session_id,
                "update": {"sessionUpdate": "agent_message_chunk", "messageId": "m1",
                           "content": {"type": "text", "text": f"权限决定:{selected}"}},
            }})
            stop = "end_turn" if selected == "selected" else "cancelled"
            send({"jsonrpc": "2.0", "id": pending_prompt_id, "result": {"stopReason": stop}})


if __name__ == "__main__":
    main()
