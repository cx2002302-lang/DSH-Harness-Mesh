#!/usr/bin/env python3
"""Mock WorkBuddy Gateway:按 wb-gateway-adapter 的 TODO 假设实现,
用于在真 Gateway 逆向完成前,先验证适配器协议层与主控侧生产管道的互通。"""
import json, threading, time
from http.server import BaseHTTPRequestHandler, HTTPServer

RUNS = {}  # run_id -> {"state":..., "messages":[...], "error":None}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _json(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if self.path == "/api/models":   # 供 wb-gateway-adapter 机会性探测模型清单
            return self._json({"models": [
                {"id": "wb-coder-pro", "name": "wb-coder-pro"},
                {"id": "wb-chat-lite", "name": "wb-chat-lite"},
            ]})
        if self.path.startswith("/api/runs/"):
            rid = self.path.rsplit("/", 1)[1]
            r = RUNS.get(rid)
            if not r: return self._json({"error": "not found"}, 404)
            return self._json(r)
        self._json({"error": "not found"}, 404)
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(n) or b"{}")
        if self.path == "/api/runs":
            rid = f"run-{len(RUNS)+1}"
            RUNS[rid] = {"state": "running", "messages": [], "error": None}
            return self._json({"run_id": rid, "id": rid})
        if self.path.endswith("/messages"):
            rid = self.path.split("/")[3]
            prompt = body.get("prompt", "")
            delay = 1.5
            if "SLOW" in prompt:   # cancel 测试用:30s 慢任务
                delay = 30
            def finish():
                time.sleep(delay)
                r = RUNS.get(rid)
                if r and r["state"] == "running":
                    r["messages"].append({"kind": "agent_message", "text": f"mock-gateway 收到:{prompt[:40]}"})
                    r["state"] = "succeeded"
            threading.Thread(target=finish, daemon=True).start()
            return self._json({"ok": True})
        if self.path.endswith("/cancel"):
            rid = self.path.split("/")[3]
            if rid in RUNS: RUNS[rid]["state"] = "cancelled"
            print(f"[mock] run {rid} CANCELLED via gateway", flush=True)
            return self._json({"ok": True})
        self._json({"error": "not found"}, 404)

HTTPServer(("127.0.0.1", 9999), H).serve_forever()
