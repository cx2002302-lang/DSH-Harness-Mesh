#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
wb-gateway-adapter.py — harness-mesh 适配器「A 壳 B 心」(v0.1 骨架)

  对上(harnessd 侧): ACP over stdio, NDJSON, JSON-RPC 2.0, 协议版本 1
     方法面(与 DSH 主控对齐的第一版最小集):
       initialize / session/new / session/prompt / session/update(通知) / session/cancel
  对下(本机): WorkBuddy GUI 的 CodeBuddy Gateway REST(GUI 活登录态)
     配置: env GATEWAY_URL / GATEWAY_AUTH,或同目录 gateway-config.json 兜底

  ⚠️ Gateway REST 的精确形状(路径/字段/进度通道)待实测回填——
     已定位 gateway 本体: resources/app.asar.unpacked/resources/extensions/remote-desktop/
     下方 GatewayClient 的每个方法都标了 [TODO:实测],先按最小假设搭架,协议层不阻塞。

  零依赖: 仅 python3 标准库。harnessd spawn 即用,无守护无状态。
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
import threading

VERSION = "0.1.0"
MAX_TURN_WAIT_S = int(os.environ.get("ADAPTER_MAX_TURN_WAIT", "1800"))  # 单 turn 最长等待 30min
POLL_INTERVAL_S = float(os.environ.get("ADAPTER_POLL_INTERVAL", "1.0"))


def log(msg):
    sys.stderr.write(f"[wb-gw-adapter {VERSION}] {msg}\n")
    sys.stderr.flush()


# ---------- 配置 ----------

def load_config():
    cfg = {
        "url": os.environ.get("GATEWAY_URL", "http://127.0.0.1:5845"),
        "auth": os.environ.get("GATEWAY_AUTH", ""),
    }
    cfg_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gateway-config.json")
    if os.path.exists(cfg_path):
        try:
            with open(cfg_path, "r", encoding="utf-8") as f:
                d = json.load(f)
            cfg["url"] = d.get("url", cfg["url"])
            if d.get("auth") and not cfg["auth"]:
                cfg["auth"] = d["auth"]
        except Exception as e:
            log(f"gateway-config.json 读取失败(忽略): {e}")
    # 模型清单来源(优先级):①env GATEWAY_MODELS(逗号分隔) ②workbuddy 本体注册表 ~/.workbuddy/models.json
    #                    ③gateway-config.json "models" ④gateway GET /api/models
    env_models = [m.strip() for m in os.environ.get("GATEWAY_MODELS", "").split(",") if m.strip()]
    # ② workbuddy 本体的模型注册表(权威源):USERPROFILE(或 HOME)下 .workbuddy/models.json,
    #    对象数组,每项 {"id","name","vendor",...},取 id(空则 name)字符串;文件不存在/解析失败静默跳过。
    wb_models = []
    wb_home = os.environ.get("USERPROFILE") or os.path.expanduser("~")
    wb_path = os.path.join(wb_home, ".workbuddy", "models.json")
    if os.path.exists(wb_path):
        try:
            with open(wb_path, "r", encoding="utf-8") as f:
                wb_items = json.load(f)
            for it in (wb_items if isinstance(wb_items, list) else []):
                if isinstance(it, dict):
                    v = it.get("id") or it.get("name")
                    if isinstance(v, str) and v.strip():
                        wb_models.append(v.strip())
        except Exception as e:
            log(f".workbuddy/models.json 读取失败(忽略): {e}")
    file_models = []
    if os.path.exists(cfg_path):
        try:
            with open(cfg_path, "r", encoding="utf-8") as f:
                d = json.load(f)
            file_models = [str(m).strip() for m in (d.get("models") or []) if str(m).strip()]
        except Exception as e:
            log(f"gateway-config.json models 读取失败(忽略): {e}")
    gw_models = probe_gateway_models(cfg["url"], cfg["auth"])
    # 四源合并去重,保序:env → .workbuddy/models.json → gateway-config.json → /api/models
    seen, models = set(), []
    for m in env_models + wb_models + file_models + gw_models:
        if m not in seen:
            seen.add(m)
            models.append(m)
    cfg["models"] = models
    cfg["model"] = os.environ.get("GATEWAY_MODEL", "") or (models[0] if models else "")
    return cfg


def probe_gateway_models(base, auth):
    """机会性查询 gateway GET /api/models(超时 2s),任何失败静默返回空表。
    兼容 {"models":[...]} 与 ["...",...] 两种形状,元素取字符串或对象的 id|name 字段。"""
    try:
        headers = {"Accept": "application/json"}
        if auth:
            headers["Authorization"] = f"Bearer {auth}"
        req = urllib.request.Request(base.rstrip("/") + "/api/models", headers=headers, method="GET")
        with urllib.request.urlopen(req, timeout=2) as r:
            d = json.loads(r.read().decode("utf-8", "replace") or "null")
    except Exception as e:
        log(f"/api/models 探测失败(忽略): {e}")
        return []
    items = d.get("models") if isinstance(d, dict) else d
    if not isinstance(items, list):
        return []
    out = []
    for it in items:
        if isinstance(it, str) and it.strip():
            out.append(it.strip())
        elif isinstance(it, dict):
            v = it.get("id") or it.get("name")
            if isinstance(v, str) and v.strip():
                out.append(v.strip())
    return out


# ---------- Gateway 客户端(形状待实测回填) ----------

class GatewayClient:
    def __init__(self, cfg):
        self.base = cfg["url"].rstrip("/")
        self.auth = cfg["auth"]
        self.models = cfg.get("models") or []
        self.model = cfg.get("model") or ""

    def _req(self, method, path, body=None, timeout=60):
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if self.auth:
            headers["Authorization"] = f"Bearer {self.auth}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
            return json.loads(raw) if raw.strip() else {}

    # [TODO:实测] 建 run:假设 POST /api/runs {cwd} → {run_id|id|runId, ...}
    def create_run(self, cwd):
        r = self._req("POST", "/api/runs", {"cwd": cwd})
        return r.get("run_id") or r.get("id") or r.get("runId") or r

    # [TODO:实测] 发 prompt:假设 POST /api/runs/{id}/messages {prompt}
    # session 上选了 model 就一并附上(gateway 不认也无害)
    def send_prompt(self, run_id, text, model=None):
        body = {"prompt": text}
        if model:
            body["model"] = model
        return self._req("POST", f"/api/runs/{run_id}/messages", body)

    # [TODO:实测] 查 run:假设 GET /api/runs/{id} → {state, messages|output, error}
    def poll_run(self, run_id):
        return self._req("GET", f"/api/runs/{run_id}")

    # [TODO:实测] 取消:假设 POST /api/runs/{id}/cancel
    def cancel_run(self, run_id):
        return self._req("POST", f"/api/runs/{run_id}/cancel", {})


# ---------- ACP server ----------

class AcpServer:
    def __init__(self):
        self.gw = GatewayClient(load_config())
        self.sessions = {}
        self.seq = 0
        self.lock = threading.Lock()

    # --- stdio 收发 ---
    # 2026-10-19 修复:session/prompt 改后台线程后,_send 会并发(泵线程发 update/result、
    # 主循环发 error/响应),stdout 交叉写会产生半行坏 NDJSON——必须加写锁。
    def _send(self, obj):
        with self.lock:
            sys.stdout.buffer.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
            sys.stdout.buffer.flush()

    def _result(self, rid, result):
        self._send({"jsonrpc": "2.0", "id": rid, "result": result})

    def _error(self, rid, code, msg):
        self._send({"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": msg}})

    def _notify(self, method, params):
        self._send({"jsonrpc": "2.0", "method": method, "params": params})

    def _update(self, session_id, text):
        """转一条 agent_message_chunk 通知给主控侧"""
        self._notify("session/update", {
            "sessionId": session_id,
            "update": {"sessionUpdate": "agent_message_chunk",
                       "content": {"type": "text", "text": text}},
        })

    # --- run 轮询泵:Gateway 事件 → session/update 通知流 ---
    def _pump(self, session_id):
        st = self.sessions.get(session_id)
        if not st:
            return
        seen = 0
        deadline = time.time() + MAX_TURN_WAIT_S
        while time.time() < deadline:
            if st.get("done"):
                # session/cancel 已置终态(2026-10-19:cancel 后泵立刻收,不再等 gateway 轮询到 cancelled)
                return
            try:
                run = self.gw.poll_run(st["run_id"])
            except Exception as e:
                self._update(session_id, f"[adapter] gateway 轮询失败(重试中): {e}")
                time.sleep(2)
                continue
            msgs = run.get("messages") or run.get("output") or run.get("events") or []
            for m in msgs[seen:]:
                text = m.get("content") or m.get("text") or json.dumps(m, ensure_ascii=False)
                self._update(session_id, text if isinstance(text, str) else str(text))
            seen = max(seen, len(msgs))
            state = str(run.get("state") or run.get("status") or "").lower()
            if state in ("succeeded", "completed", "success", "done"):
                st["done"], st["stop"] = True, "end_turn"
                return
            if state in ("failed", "error"):
                st["done"], st["stop"], st["error"] = True, "end_turn", run.get("error") or "run failed"
                return
            if state in ("cancelled", "canceled"):
                st["done"], st["stop"] = True, "cancelled"
                return
            time.sleep(POLL_INTERVAL_S)
        st["done"], st["stop"], st["error"] = True, "end_turn", f"turn 超时({MAX_TURN_WAIT_S}s)"

    # --- 方法分发 ---
    def handle(self, msg):
        mid = msg.get("id")
        method = msg.get("method")
        params = msg.get("params") or {}

        if method == "initialize":
            self._result(mid, {
                "protocolVersion": 1,
                "agentCapabilities": {
                    "promptCapabilities": {"image": False, "audio": False, "embeddedContext": True},
                    "mcpCapabilities": {"http": False, "sse": False},
                },
            })
        elif method == "session/new":
            with self.lock:
                self.seq += 1
                sid = f"s-{os.getpid()}-{self.seq}"
            cwd = params.get("cwd") or os.getcwd()
            try:
                run_id = self.gw.create_run(cwd)
                self.sessions[sid] = {"run_id": run_id, "cwd": cwd, "done": False}
                log(f"session/new -> {sid} (run={run_id}, cwd={cwd})")
                # 上报可用模型表(opencode 方言 configOptions),清单为空则保持原样
                result = {"sessionId": sid}
                if self.gw.models:
                    result["configOptions"] = [{
                        "id": "model", "name": "Model", "category": "model",
                        "type": "select", "currentValue": self.gw.model,
                        "options": [{"value": m, "name": m} for m in self.gw.models],
                    }]
                self._result(mid, result)
            except Exception as e:
                self._error(mid, -32000, f"gateway create_run failed: {e}")
        elif method == "session/set_model":
            sid = params.get("sessionId")
            st = self.sessions.get(sid)
            if not st:
                self._error(mid, -32001, f"unknown session: {sid}")
                return
            st["model"] = params.get("modelId") or params.get("model") or ""
            log(f"session/set_model {sid} -> {st['model']}")
            self._result(mid, {})
        elif method == "session/prompt":
            sid = params.get("sessionId")
            st = self.sessions.get(sid)
            if not st:
                self._error(mid, -32001, f"unknown session: {sid}")
                return
            text = "".join(b.get("text", "") for b in params.get("prompt", [])
                           if isinstance(b, dict) and b.get("type") == "text")
            try:
                self.gw.send_prompt(st["run_id"], text, st.get("model"))
            except Exception as e:
                self._error(mid, -32000, f"gateway send_prompt failed: {e}")
                return
            log(f"session/prompt {sid}: {text[:80]}")

            # 2026-10-19 修复:原来在这里同步 `while not done: sleep` 等终态,
            # serve() 读循环被堵死 → session/cancel 通知永远读不到 → 取消只能靠主控强杀。
            # 现在整个 turn(泵+回 result)放后台线程,读循环保持响应。
            def run_turn():
                self._pump(sid)
                if st.get("error"):
                    self._update(sid, f"[adapter] {st['error']}")
                self._result(mid, {"stopReason": st.get("stop", "end_turn")})

            threading.Thread(target=run_turn, daemon=True).start()
        elif method == "session/cancel":
            sid = params.get("sessionId")
            st = self.sessions.get(sid)
            if st:
                if st.get("run_id"):
                    try:
                        self.gw.cancel_run(st["run_id"])
                    except Exception as e:
                        log(f"cancel_run failed: {e}")
                st["done"], st["stop"] = True, "cancelled"
            # notification,无 id 不回
        elif mid is not None:
            self._error(mid, -32601, f"method not found: {method}")

    def serve(self):
        log(f"就绪,gateway={self.gw.base} auth={'有' if self.gw.auth else '无'}")
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except Exception:
                continue
            try:
                self.handle(msg)
            except Exception as e:
                if msg.get("id") is not None:
                    self._error(msg["id"], -32603, f"internal error: {e}")


def main():
    AcpServer().serve()


if __name__ == "__main__":
    main()
