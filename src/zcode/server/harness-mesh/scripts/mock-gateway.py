#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Mock WorkBuddy Gateway(ThreadingHTTPServer:SSE 长连接不能占死唯一线程;2026-10-20 按 v5 适配器真身的 REST runs API 形状重写):
    POST /api/v1/runs             → {"data": {"runId": ...}}(SLOW 在 text 里则 30s 慢任务)
    GET  /api/v1/runs/:id/stream  → SSE,终态发一帧 {"status":"completed","content":{"markdown":...}}
    POST /api/v1/runs/:id/cancel  → 置 cancelled,打 "CANCELLED via gateway"(e2e 断言锚点)
    GET  /api/v1/status           → {"data": {"busy": ...}}(Bearer 鉴权不校验,本地测试用)
旧骨架的 /api/models、/api/runs、/messages 已废弃——真 gateway 无这些端点。
"""
import json, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

RUNS = {}  # run_id -> {"state": running/completed/failed/cancelled, "text":..., "error":None}


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a): pass

    def _json(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path == "/api/v1/status":
            busy = any(r["state"] == "running" for r in RUNS.values())
            return self._json({"data": {"busy": busy, "state": "running" if busy else "idle"}})
        if self.path.startswith("/api/v1/runs/") and self.path.endswith("/stream"):
            rid = self.path.split("/")[4]
            r = RUNS.get(rid)
            if not r:
                return self._json({"error": "not found"}, 404)
            # SSE:轮询 run 状态,终态(或客户端断开)即回一帧收尾
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.flush()
            try:
                while True:
                    if r["state"] in ("completed", "failed", "cancelled"):
                        ev = {"status": r["state"], "replyTo": rid}
                        if r["state"] == "completed":
                            ev["content"] = {"markdown": f"mock-gateway 收到:{r['text'][:40]}"}
                        else:
                            ev["error"] = r["error"] or f"run {r['state']}"
                        self.wfile.write(f"data: {json.dumps(ev)}\n\n".encode())
                        self.wfile.flush()
                        return
                    time.sleep(0.1)
            except (BrokenPipeError, ConnectionResetError):
                return  # 客户端(cancel 兜底断流)先挂断,正常
        self._json({"error": "not found"}, 404)

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(n) or b"{}")
        if self.path == "/api/v1/runs":
            rid = body.get("id") or f"run-{len(RUNS)+1}"
            text = (body.get("payload") or {}).get("text", "")
            RUNS[rid] = {"state": "running", "text": text, "error": None}
            delay = 30 if "SLOW" in text else 1.5  # cancel 测试用:30s 慢任务
            def finish():
                time.sleep(delay)
                r = RUNS.get(rid)
                if r and r["state"] == "running":
                    r["state"] = "completed"
            threading.Thread(target=finish, daemon=True).start()
            return self._json({"data": {"runId": rid}})
        if self.path.startswith("/api/v1/runs/") and self.path.endswith("/cancel"):
            rid = self.path.split("/")[4]
            if rid in RUNS:
                RUNS[rid]["state"] = "cancelled"
            print(f"[mock] run {rid} CANCELLED via gateway", flush=True)
            return self._json({"data": {"ok": True}})
        self._json({"error": "not found"}, 404)


ThreadingHTTPServer(("127.0.0.1", 9999), H).serve_forever()
