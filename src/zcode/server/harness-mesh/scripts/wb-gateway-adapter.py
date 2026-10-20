#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
wb-gateway-adapter.py — harness-mesh 适配器「A 壳 B 心」(v5.0 REST runs 隔离版)

  对上(harnessd 侧): ACP over stdio, NDJSON, JSON-RPC 2.0, 协议版本 1
  对下(本机): WorkBuddy Gateway 的 REST runs API(隔离任务形态):
      POST /api/v1/runs          建独立 run(generic webhook 消息格式)
      GET  /api/v1/runs/:id/stream  run 专属 SSE 结果流
      POST /api/v1/runs/:id/cancel  取消
      GET  /api/v1/status /health   状态(Bearer 密码鉴权)

  v5 架构(DSH 01:25 拍板):
      session/new    → 本地生成 sessionId(记 cwd)
      session/prompt → POST /api/v1/runs 建 run → 接 run SSE 流 →
                       run 事件转 session/update(agent_message_chunk 带 messageId)→
                       终态回单次 response {stopReason}
      session/cancel → POST /api/v1/runs/:id/cancel
      密码: PEB 读 serve 实例 env 的 CODEBUDDY_GATEWAY_PASSWORD(不硬编码不落盘)
      端口: 自动发现(GATEWAY_URL > gateway-config.json > web-ui-port.json > 扫进程验标题)

  零依赖: 仅 python3 标准库。harnessd spawn 即用,无守护无状态。

  2026-10-20 v5 真身从生产回收(此前仓库里是 v0.1 骨架,Gateway API 形状以本文件为准)。
"""
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

VERSION = "5.2.1"
CREATE_NO_WINDOW = 0x08000000  # pythonw 下 subprocess 默认会弹控制台窗口

# 共享文件日志(DSH 侧也能读):生命周期全记录,定位"进程为什么死"
FILE_LOG = os.environ.get("ADAPTER_LOG", r"D:\AgentHome\DshData\wb-green\v5-adapter.log")


def flog(msg):
    """生命周期日志:写共享文件(pythonw 下 stderr 不可见,这是唯一的可观测通道)"""
    try:
        line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] pid={os.getpid()} {msg}\n"
        with open(FILE_LOG, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception:
        pass
    log(msg)


def log(msg):
    sys.stderr.write(f"[wb-gw-adapter {VERSION}] {msg}\n")
    sys.stderr.flush()


# ---------- Gateway 端口发现 ----------

def _curl_is_gateway(url, timeout=3):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method="GET"), timeout=timeout) as r:
            body = r.read(2048).decode("utf-8", "replace")
            return "CodeBuddy Gateway" in body or "Remote Control" in body
    except Exception:
        return False


def discover_gateway(cfg_url=None):
    """发现 gateway。多池场景:优先选空闲池(busy=false)——避免附到正在执行任务的会话(死锁)。
    返回 (base, password) 元组或 (None, None)"""
    env_url = os.environ.get("GATEWAY_URL")
    if cfg_url or env_url:
        base = (cfg_url or env_url).rstrip("/")
        return base, None  # 显式指定时不探 busy,密码由调用方读
    candidates = []
    home = os.path.expanduser("~")
    for p in [os.path.join(home, ".codebuddy", "web-ui-port.json"),
              os.path.join(home, ".workbuddy", "web-ui-port.json")]:
        try:
            with open(p, "r", encoding="utf-8") as f:
                port = json.load(f).get("port")
            if port and _curl_is_gateway(f"http://127.0.0.1:{port}"):
                candidates.append(f"http://127.0.0.1:{port}")
        except Exception:
            pass
    try:
        out = subprocess.run(["netstat", "-ano"], capture_output=True, text=True,
                             encoding="utf-8", errors="replace", timeout=10,
                             creationflags=CREATE_NO_WINDOW).stdout
        ps = subprocess.run(["powershell", "-NoProfile", "-Command",
                             "(Get-Process -Name WorkBuddy -ErrorAction SilentlyContinue).Id -join ','"],
                            capture_output=True, text=True, encoding="utf-8",
                            errors="replace", timeout=10,
                            creationflags=CREATE_NO_WINDOW).stdout.strip()
        wb_pids = {x.strip() for x in ps.split(",") if x.strip().isdigit()}
        ports = set()
        for line in out.splitlines():
            parts = line.split()
            if len(parts) >= 4 and parts[0] == "TCP" and "LISTENING" in line and parts[-1] in wb_pids:
                try:
                    ports.add(int(parts[1].rsplit(":", 1)[1]))
                except Exception:
                    pass
        for port in sorted(ports):
            base = f"http://127.0.0.1:{port}"
            if base not in candidates and _curl_is_gateway(base):
                candidates.append(base)
    except Exception as e:
        log(f"端口扫描异常: {e}")

    # 对每个候选池:读密码 + 查 status(busy),优先空闲
    scored = []
    for base in candidates:
        pw = discover_password(base)
        busy = None
        if pw:
            try:
                req = urllib.request.Request(base + "/api/v1/status",
                                             headers={"Authorization": f"Bearer {pw}"})
                with urllib.request.urlopen(req, timeout=5) as r:
                    d = json.loads(r.read().decode("utf-8", "replace"))
                    busy = bool((d.get("data") or d).get("busy"))
            except Exception:
                pass
        scored.append({"base": base, "password": pw, "busy": busy})
        log(f"候选池 {base}: 密码={'有' if pw else '无'} busy={busy}")
    if not scored:
        return None, None
    # 排序:密码有 > 空闲 > 未知  (busy=False 最优先)
    scored.sort(key=lambda s: (0 if (s["password"] and s["busy"] is False) else
                               1 if (s["password"] and s["busy"] is None) else 2))
    best = scored[0]
    log(f"选中池 {best['base']} (busy={best['busy']})")
    return best["base"], best["password"]


# ---------- serve 实例 env 读取(取 gateway 密码,涉密不落盘) ----------

def _read_proc_env(pid):
    """读 Windows 进程环境变量(同用户会话,PEB → ProcessParameters → Environment)"""
    import ctypes
    import ctypes.wintypes as wt
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    ntdll = ctypes.WinDLL("ntdll")
    k32.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
    k32.OpenProcess.restype = wt.HANDLE
    k32.ReadProcessMemory.argtypes = [wt.HANDLE, wt.LPCVOID, wt.LPVOID, ctypes.c_size_t,
                                      ctypes.POINTER(ctypes.c_size_t)]
    k32.ReadProcessMemory.restype = wt.BOOL
    ntdll.NtQueryInformationProcess.argtypes = [wt.HANDLE, ctypes.c_ulong, wt.LPVOID,
                                                ctypes.c_ulong, wt.LPVOID]
    ntdll.NtQueryInformationProcess.restype = ctypes.c_ulong

    class PBI(ctypes.Structure):
        _fields_ = [("R1", ctypes.c_void_p), ("Peb", ctypes.c_void_p), ("R2", ctypes.c_void_p),
                    ("R3", ctypes.c_void_p), ("Pid", ctypes.c_void_p), ("R4", ctypes.c_void_p)]

    class PEB(ctypes.Structure):
        _fields_ = [("Reserved", ctypes.c_byte * 32), ("ProcessParameters", ctypes.c_void_p)]

    class RUPP(ctypes.Structure):
        _fields_ = [("Reserved", ctypes.c_byte * 128), ("Environment", ctypes.c_void_p)]

    h = k32.OpenProcess(0x0410, False, pid)
    if not h:
        return None
    try:
        pbi = PBI()
        if ntdll.NtQueryInformationProcess(h, 0, ctypes.byref(pbi), ctypes.sizeof(pbi), None) != 0:
            return None
        peb = PEB()
        if not k32.ReadProcessMemory(h, pbi.Peb, ctypes.byref(peb), ctypes.sizeof(peb), None):
            return None
        params = RUPP()
        if not k32.ReadProcessMemory(h, peb.ProcessParameters, ctypes.byref(params),
                                     ctypes.sizeof(params), None):
            return None
        # 环境块大小不定(干净进程可能很小):自适应尝试,避免越界导致整体失败
        for size in (65536, 32768, 16384, 8192, 4096):
            buf = ctypes.create_string_buffer(size)
            read = ctypes.c_size_t()
            if k32.ReadProcessMemory(h, params.Environment, buf, size, ctypes.byref(read)):
                raw = buf.raw[:read.value]
                if b"\x00\x00" in raw:
                    return raw.decode("utf-16-le", errors="replace")
        return None
    except Exception:
        return None
    finally:
        k32.CloseHandle(h)


def discover_password(base=None):
    """env 指定 > netstat 找 gateway 端口 owner PID > PEB 读其 env
    (不依赖 CIM——CIM 对部分进程的 CommandLine 返回空,实测踩坑)"""
    env_pw = os.environ.get("GATEWAY_AUTH")
    if env_pw:
        return env_pw
    try:
        # 1) 从 base URL 拿端口
        port = None
        if base:
            port = base.rstrip("/").rsplit(":", 1)[-1]
        # 2) netstat 找该端口 owner
        pid = None
        if port:
            out = subprocess.run(["netstat", "-ano"], capture_output=True, text=True,
                                 encoding="utf-8", errors="replace", timeout=10,
                                 creationflags=CREATE_NO_WINDOW).stdout
            for line in out.splitlines():
                parts = line.split()
                if len(parts) >= 4 and parts[0] == "TCP" and "LISTENING" in line \
                        and parts[1].endswith(f":{port}"):
                    pid = parts[-1]
                    break
        # 3) 没有就从 powershell 兜底找 --serve 实例(可能空,所以只在 2 失败时试)
        if not pid:
            ps = subprocess.run(["powershell", "-NoProfile", "-Command",
                                 "Get-CimInstance Win32_Process -Filter \"Name='WorkBuddy.exe'\" | "
                                 "Where-Object { $_.CommandLine -like '*--serve*' } | "
                                 "Select-Object -ExpandProperty ProcessId"],
                                capture_output=True, text=True, encoding="utf-8",
                                errors="replace", timeout=10,
                                creationflags=CREATE_NO_WINDOW).stdout
            m = re.findall(r"\d+", ps)
            if m:
                pid = m[0]
        if pid:
            text = _read_proc_env(int(pid))
            if text:
                mm = re.search(r"CODEBUDDY_GATEWAY_PASSWORD=([^\x00]+)", text)
                if mm:
                    log(f"gateway 密码已获取(pid={pid},不落盘)")
                    return mm.group(1)
                log(f"pid={pid} env 里无 CODEBUDDY_GATEWAY_PASSWORD")
            else:
                log(f"pid={pid} env 读取失败")
    except Exception as e:
        log(f"密码获取异常: {e}")
    return None


# ---------- REST runs 客户端 ----------

class RunsClient:
    def __init__(self, base, password):
        self.base = (base or "").rstrip("/")
        self.password = password

    def _req(self, method, path, body=None, timeout=120):
        headers = {"Content-Type": "application/json"}
        if self.password:
            headers["Authorization"] = f"Bearer {self.password}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
            return json.loads(raw) if raw.strip() else {}

    def create_run(self, text, cwd=None, timeout_ms=1800000):
        rid = f"run-{os.getpid()}-{int(time.time()*1000)}"
        body = {
            "id": rid, "type": "text", "version": "1.0",
            "source": {"platform": "generic", "sender": {"id": "harness-mesh"},
                       "conversation": {"id": rid, "type": "direct"}},
            "payload": {"text": text},
            "timeoutMs": timeout_ms,
        }
        if cwd:
            body["payload"]["cwd"] = cwd  # 先试收,不收就文本前缀(v5.1)
        r = self._req("POST", "/api/v1/runs", body)
        return (r.get("data") or r).get("runId")

    def stream_run(self, run_id, on_event, stop_flag):
        """接 run SSE 流,事件回调 on_event(dict);stop_flag 置位时返回"""
        req = urllib.request.Request(f"{self.base}/api/v1/runs/{run_id}/stream", method="GET",
                                     headers={"Accept": "text/event-stream",
                                              "Authorization": f"Bearer {self.password}"})
        n_events = 0
        try:
            flog(f"SSE 连接 run={run_id}")
            with urllib.request.urlopen(req, timeout=300) as r:
                buf = b""
                while not stop_flag.is_set():
                    chunk = r.read1(4096) if hasattr(r, "read1") else r.read(4096)
                    if not chunk:
                        break
                    buf += chunk
                    while b"\n" in buf:
                        line, _, buf = buf.partition(b"\n")
                        line = line.strip()
                        if line.startswith(b"data:"):
                            n_events += 1
                            try:
                                on_event(json.loads(line[5:].strip()))
                            except Exception:
                                pass
            flog(f"SSE EOF run={run_id} events={n_events}")
        except urllib.error.HTTPError as e:
            flog(f"SSE HTTPError {e.code} run={run_id}(404=run已完成流销毁)")
            if e.code == 404:
                return  # run 已完成,流销毁(正常)
        except Exception as e:
            flog(f"SSE 异常 run={run_id}: {type(e).__name__}: {e}")

    def cancel_run(self, run_id):
        try:
            self._req("POST", f"/api/v1/runs/{run_id}/cancel", {}, timeout=30)
        except Exception as e:
            log(f"cancel 失败: {e}")

    def status(self):
        try:
            return self._req("GET", "/api/v1/status", timeout=15)
        except Exception:
            return None


# ---------- 模型清单上报(mesh 的 listModels 走 session/new 响应的 configOptions,opencode 方言) ----------

def load_models():
    """模型清单合并:.workbuddy/models.json(对象数组,每项取 id,空则 name;文件不在/解析失败静默)
    为主,env GATEWAY_MODELS(逗号分隔)若给了则排在前面覆盖补充;
    第三源 .workbuddy/cache/acc-product-config-v3.json 的 .models(官方目录,取显示名 name),
    过滤 disabled / 非聊天 tags(image/video)/ custom-local: / 编辑器补全模型。按名字去重保序。
    来源标记:env/models.json = custom(自定义);acc-product-config 目录缓存 = builtin(自带);
    同名去重时 custom 优先(本来就排前面)。返回 [(干净名字, "custom"|"builtin"), ...]"""
    file_models = []
    base = os.environ.get("USERPROFILE") or os.path.expanduser("~")
    try:
        with open(os.path.join(base, ".workbuddy", "models.json"), "r", encoding="utf-8") as f:
            arr = json.load(f)
        if isinstance(arr, list):
            for item in arr:
                mid = str(item.get("id") or item.get("name") or "").strip() if isinstance(item, dict) else ""
                if mid and mid not in file_models:
                    file_models.append(mid)
    except Exception:
        pass
    # 第三源:官方目录缓存 acc-product-config-v3.json .models,只留聊天模型,取显示名 name
    dir_models = []
    try:
        with open(os.path.join(base, ".workbuddy", "cache", "acc-product-config-v3.json"), "r", encoding="utf-8") as f:
            models = (json.load(f) or {}).get("models")
        if isinstance(models, list):
            bad_tags = {"text-to-image", "image-to-image", "text-to-video"}
            for item in models:
                if not isinstance(item, dict):
                    continue
                if item.get("disabled"):
                    continue
                mid = str(item.get("id") or "")
                if mid.startswith("custom-local:"):  # 自定义型号,models.json 已覆盖
                    continue
                if "completion" in mid or mid.startswith("codewise"):  # 编辑器内部补全模型
                    continue
                tags = item.get("tags") or []
                if any(t in bad_tags for t in tags):
                    continue
                name = str(item.get("name") or "").strip()
                if name and name not in dir_models:
                    dir_models.append(name)
    except Exception:
        pass
    env_models = [m.strip() for m in os.environ.get("GATEWAY_MODELS", "").split(",") if m.strip()]
    seen, out = set(), []
    # env 优先,其次文件清单,最后官方目录补充去重;同名时 custom(前两源)天然优先
    for m, src in [(m, "custom") for m in env_models + file_models] + \
                  [(m, "builtin") for m in dir_models]:
        if m not in seen:
            seen.add(m)
            out.append((m, src))
    return out


# ---------- ACP stdio server ----------

class AcpServer:
    IDLE_EXIT_S = int(os.environ.get("ADAPTER_IDLE_EXIT", "600"))  # 空闲自退(秒),防进程堆积

    def __init__(self, client, state=None):
        self.gw = client
        self.state = state          # 后台发现状态(ready Event + base/password)
        self.sessions = {}      # sessionId -> {run_id, cwd, stop_flag, done, stop, error}
        self.seq = 0
        self._io_lock = threading.Lock()
        self.last_active = time.time()

    def _ensure_gateway(self, timeout=60):
        """prompt 前确保 gateway 发现完成(initialize/session-new 不调用,保持秒回)"""
        if self.state is None:
            return
        if not self.state["ready"].wait(timeout):
            raise RuntimeError(f"gateway 发现超时({timeout}s)")
        if self.state.get("error"):
            raise RuntimeError(f"gateway 发现失败: {self.state['error']}")
        if not self.state.get("base"):
            raise RuntimeError("未发现 gateway(WorkBuddy serve 实例不在?)")
        self.gw.base = self.state["base"]
        self.gw.password = self.state.get("password")

    def _idle_watchdog(self):
        """空闲超时自退:harnessd 不关 stdin 时,适配器自己退出,避免进程堆积"""
        while True:
            time.sleep(60)
            busy = any(not st.get("done") for st in self.sessions.values())
            if busy:
                self.last_active = time.time()
                continue
            idle = time.time() - self.last_active
            if idle > self.IDLE_EXIT_S:
                log(f"空闲 {idle:.0f}s 超过 {self.IDLE_EXIT_S}s,自退(防堆积)")
                sys.stderr.flush()
                os._exit(0)

    def _send(self, obj):
        with self._io_lock:
            sys.stdout.buffer.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
            sys.stdout.buffer.flush()

    def _result(self, mid, result):
        self._send({"jsonrpc": "2.0", "id": mid, "result": result})

    def _error(self, mid, code, msg):
        self._send({"jsonrpc": "2.0", "id": mid, "error": {"code": code, "message": msg}})

    def _update(self, session_id, text, thought=False):
        self._send({"jsonrpc": "2.0", "method": "session/update", "params": {
            "sessionId": session_id,
            "update": {"sessionUpdate": "agent_thought_chunk" if thought else "agent_message_chunk",
                       "messageId": f"m-{session_id}",
                       "content": {"type": "text", "text": text}}}})

    def _on_run_event(self, session_id, ev):
        """run SSE 事件 → session/update(实测格式: {status, content:{markdown}, replyTo, agent})"""
        if not isinstance(ev, dict):
            return
        status = ev.get("status") or ev.get("type") or ev.get("event") or ""
        # 终态检测(实测 status: completed/failed)
        if status in ("completed", "done", "finished", "succeeded", "run_completed"):
            st = self.sessions.get(session_id)
            if st:
                st["done"], st["stop"] = True, "end_turn"
                # 结果文本(content.markdown 实测)
                content = ev.get("content")
                if isinstance(content, dict):
                    text = content.get("markdown") or content.get("text") or content.get("content")
                    if isinstance(text, str) and text.strip():
                        st["result_text"] = text
                elif isinstance(content, str) and content.strip():
                    st["result_text"] = content
            return
        if status in ("failed", "error", "cancelled"):
            st = self.sessions.get(session_id)
            if st:
                st["done"] = True
                st["stop"] = "cancelled" if status == "cancelled" else "refusal"
                st["error"] = ev.get("error") or ev.get("message") or f"run {status}"
            return
        # 过程文本(多种字段名兼容)
        text = ev.get("text") or ev.get("message") or ev.get("delta")
        if isinstance(text, dict):
            text = text.get("text") or text.get("markdown") or json.dumps(text, ensure_ascii=False)
        content = ev.get("content")
        if not text and isinstance(content, dict):
            text = content.get("markdown") or content.get("text")
        if isinstance(text, str) and text.strip():
            self._update(session_id, text)

    def handle(self, msg):
        mid = msg.get("id")
        method = msg.get("method") or ""
        params = msg.get("params") or {}
        self.last_active = time.time()

        if method == "initialize":
            self._result(mid, {
                "protocolVersion": 1,
                # 契约版本(hm-1):与主控侧对齐,便于版本协商
                "contractVersion": "hm-1",
                "agentCapabilities": {
                    "promptCapabilities": {"image": False, "audio": False, "embeddedContext": True},
                    "mcpCapabilities": {"http": False, "sse": False},
                },
                "authMethods": [],
            })
        elif method == "session/new":
            with self._io_lock:
                self.seq += 1
                sid = f"s-{os.getpid()}-{self.seq}"
            cwd = params.get("cwd") or os.getcwd()
            self.sessions[sid] = {"run_id": None, "cwd": cwd, "stop_flag": threading.Event(),
                                  "done": False, "stop": "end_turn"}
            flog(f"session/new {sid} cwd={cwd}")
            result = {"sessionId": sid}
            models = load_models()  # 模型清单非空才上报 configOptions(opencode 方言 select)
            if models:
                result["configOptions"] = [{
                    "id": "model", "name": "Model", "category": "model", "type": "select",
                    "currentValue": os.environ.get("GATEWAY_MODEL") or models[0][0],
                    # value=干净名字(下游当 modelId);自定义项显示名加 " · 自定义" 后缀,自带不加
                    "options": [{"value": m, "name": f"{m} · 自定义" if src == "custom" else m}
                                for m, src in models],
                }]
                flog(f"session/new {sid} 上报模型清单 {models} current={result['configOptions'][0]['currentValue']}")
            self._result(mid, result)
        elif method == "session/prompt":
            sid = params.get("sessionId")
            st = self.sessions.get(sid)
            if not st:
                self._error(mid, -32001, f"unknown session: {sid}")
                return
            text = "".join(b.get("text", "") for b in params.get("prompt", [])
                           if isinstance(b, dict) and b.get("type") == "text")
            try:
                self._ensure_gateway()   # 只有 prompt 才等 gateway(initialize/new 零依赖)
                run_id = self.gw.create_run(text, cwd=st.get("cwd"))
            except Exception as e:
                flog(f"prompt 前置失败: {type(e).__name__}: {e}")
                self._error(mid, -32000, f"create_run failed: {e}")
                return
            st["run_id"] = run_id
            flog(f"session/prompt {sid} create_run OK run={run_id} text={text[:50]!r}")
            # 同步接流(零竞态):边收边发 update,终态即返回。
            # cancel 走 DSH 侧强制断流兜底(harnessd 模型:一任务一管道)
            self.gw.stream_run(run_id, lambda ev: self._on_run_event(sid, ev), st["stop_flag"])
            if not st.get("done"):
                # 流关闭但没见终态事件(极短任务竞态):兜底按完成处理
                st["done"], st["stop"] = True, "end_turn"
                flog("stream 关闭未见终态,兜底 end_turn")
            if st.get("result_text") and not st.get("result_sent"):
                st["result_sent"] = True
                self._update(sid, st["result_text"])
            if st.get("error"):
                self._update(sid, f"[adapter] {st['error']}")
            flog(f"prompt 返回 stopReason={st.get('stop')} error={st.get('error')}")
            self._result(mid, {"stopReason": st.get("stop", "end_turn")})
        elif method == "session/cancel":
            sid = params.get("sessionId")
            st = self.sessions.get(sid)
            if st:
                if st.get("run_id"):
                    self.gw.cancel_run(st["run_id"])
                st["stop_flag"].set()
                st["done"], st["stop"] = True, "cancelled"
            # notification 无 id 不回
        elif method == "session/set_model":
            sid = params.get("sessionId")
            st = self.sessions.get(sid)
            if not st:
                self._error(mid, -32001, f"unknown session: {sid}")
                return
            # v5 的 prompt 链路:create_run 请求体(payload)只有 text/cwd,gateway runs API
            # 没有按会话选模型的入参,模型无处可放。诚实拒绝(-32602),modelId 仅记在
            # session 状态供观测——不静默吞,让主控侧明确知道切换未生效。
            st["model"] = params.get("modelId")
            flog(f"session/set_model {sid} model={st['model']!r} → gateway runs API 不支持,诚实 -32602")
            self._error(mid, -32602,
                        "gateway runs API 不支持按会话选模型(create_run 无 model 字段);"
                        f"modelId={st['model']!r} 已记录但未生效")
        elif mid is not None:
            self._error(mid, -32601, f"method not found: {method}")

    def serve(self):
        flog("stdio ACP 就绪(REST runs 隔离模式),开始服务")
        threading.Thread(target=self._idle_watchdog, daemon=True).start()
        # 注意:不能用 `for line in sys.stdin`——其 read-ahead 缓冲会吞后续行直到 EOF,
        # 阻塞式 prompt 期间 cancel/新请求永远读不到(Linux 实测踩坑)。readline 迭代无此问题。
        for line in iter(sys.stdin.readline, ""):
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except Exception:
                flog(f"stdin 非法 JSON: {line[:80]!r}")
                continue
            flog(f"stdin -> {msg.get('method')} id={msg.get('id')}")
            try:
                if msg.get("method") in ("session/prompt", "session/cancel"):
                    # prompt 是阻塞式(同步接 SSE 流),内联处理会让主循环停读 stdin——
                    # cancel 永远轮不到,gateway run 泄漏。prompt/cancel 走旁路线程,
                    # 主循环保持可读;输出有 _io_lock 串行化,JSON-RPC 靠 id 配对。
                    threading.Thread(target=self._handle_safe, args=(msg,), daemon=True).start()
                else:
                    self._handle_safe(msg)
            except Exception as e:
                import traceback
                flog(f"serve 异常: {type(e).__name__}: {e}\n{traceback.format_exc()[:800]}")
        flog("!!! stdin EOF: 上游(harnessd)关闭了管道 -> 适配器退出。这是'远程进程消失'的直接原因")

    def _handle_safe(self, msg):
        try:
            self.handle(msg)
        except Exception as e:
            import traceback
            flog(f"handle 异常: {type(e).__name__}: {e}\n{traceback.format_exc()[:800]}")
            if msg.get("id") is not None:
                self._error(msg["id"], -32603, f"internal: {e}")


def main():
    flog(f"=== 适配器启动 v{VERSION} argv={sys.argv[1:]} ===")
    cfg_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gateway-config.json")
    cfg_url = None
    if os.path.exists(cfg_path):
        try:
            with open(cfg_path, "r", encoding="utf-8") as f:
                cfg_url = json.load(f).get("url")
        except Exception:
            pass

    # v5.2 解耦:端口发现/密码获取放后台,不阻塞协议层。
    # initialize 必须零 gateway 依赖秒回(gateway 噎住时协议层仍可用,失败干净落在 prompt 层)
    state = {"base": None, "password": None, "ready": threading.Event(), "error": None}

    def _bg_discover():
        try:
            t0 = time.time()
            base, pw = discover_gateway(cfg_url)
            state["base"] = base
            state["password"] = pw if pw else (discover_password(base) if base else None)
            flog(f"后台发现完成({time.time()-t0:.1f}s): base={base} password={'有' if state['password'] else '无'}")
        except Exception as e:
            state["error"] = str(e)
            flog(f"后台发现异常: {type(e).__name__}: {e}")
        finally:
            state["ready"].set()

    threading.Thread(target=_bg_discover, daemon=True).start()
    AcpServer(RunsClient(None, None), state).serve()


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        import traceback
        flog(f"顶层异常退出: {traceback.format_exc()[:1200]}")
        raise
