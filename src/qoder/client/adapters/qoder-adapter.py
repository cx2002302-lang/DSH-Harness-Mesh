#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""qoder-adapter — qoderclicn(1.0.25)接入 harness-mesh 的 ACP 插头(纯标准库 Python 3)。

向上(harnessd → 主控):ACP stdio NDJSON,JSON-RPC 2.0,protocolVersion 1,contractVersion hm-1
  initialize / session/new / session/prompt / session/cancel / session/set_model
  + session/update 通知(agent_message_chunk)
向下(qoderclicn 本体):`qoderclicn.exe -p`,prompt 走 **stdin** 而非 argv。

三条实测硬约束(与《给qoder的开场提示词 v2》预判不同,以实测为准,已回报频道):
  1) env 毒化:继承桌面端的 QODER_AGENT_SDK_ENTRYPOINT → CLI 直接 `sdk_invalid_args` 崩;
     继承 QODER_CONFIG_DIR / QODERCN_CONFIG_DIR → CLI 去读桌面配置目录 → "Not logged in"。
     本机 CLI 登录态在 ~/.qoder-cn/.auth,只要不覆盖它的默认目录就能免登录直接用。
     → spawn 前剥掉全部 QODER* 变量(《适配器编写指南》第 4 章 env 显式化)。
  2) 默认模型指针是坏的:不带 -m 时 CLI 解析到 `qmodel_latest`,而 QoderCN 目录只有
     qfmodel/dfmodel → 每次都显式带 -m,取 --list-models 首项(env QODER_ADAPTER_MODEL 可钉)。
  3) --permission-mode dont_ask 会把写文件/跑命令**静默自动拒绝**(表现为"被拦截"而非报错),
     编程节点不能用。实测三种口子:accept_edits 放行写文件+只读命令、其余自动拒;
     auto 全放行但 CLI 内置安全分类器会拦"与开发无关"的命令;bypass_permissions 全放行。
     → 2026-10-21 由使用方定 **bypass_permissions**(跨机派活要能跑测试/装依赖)。
     代价:适配器看不见 CLI 内部工具调用(`-p` 一次性执行),mesh 的 DEFAULT_DENY 权限链
     在这一层不生效,爆炸半径=本机任意命令执行权,靠主控侧 prompt 纪律约束。

配置(plugs.json 的 env 段显式给全,均有默认值;harnessd 64f08e4 起 env 段才真正注入):
  QODER_ADAPTER_CLI         qoderclicn.exe 全路径
  QODER_ADAPTER_MODEL       会话默认模型;缺省用 --list-models 首项
  QODER_ADAPTER_PERM_MODE   default|accept_edits|bypass_permissions|dont_ask|auto(默认 bypass_permissions)
  QODER_ADAPTER_STREAM      1 = 下行改 stream-json(默认 0)。实测粒度是"按 assistant 块"而非
                            逐 token,正文与思考块同时落地,进度不会动;主控 2026-10-21 定保持关
  QODER_ADAPTER_CONTINUITY  0 = 关闭"同 ACP 会话续接 CLI 会话(-r)"(默认开)
  ADAPTER_MAX_TURN_WAIT     单 prompt 最长等待秒(默认 1800)
  ADAPTER_LOG               1 = 诊断同时打 stderr

配置变量一律带 QODER_ADAPTER_ 前缀:桌面端往自家会话里注入了 QODER_CLI=1 这类标记变量,
短名会被顶掉(第一版用 QODER_CLI 当配置名,实测被注入值 "1" 覆盖 → 启动即判定 CLI 不存在)。

诊断只写 <HM_BASE_DIR>/logs/qoder-adapter.log 与 stderr(HM_BASE_DIR/QODER_ADAPTER_LOG_DIR 可覆盖);**stdout 只准有 NDJSON**。
"""
import json
import os
import subprocess
import sys
import threading
import time

CONTRACT_VERSION = "hm-1"
PROTOCOL_VERSION = 1
CREATE_NO_WINDOW = 0x08000000

# CLI 位置：plug.env 的 QODER_ADAPTER_CLI 说了算；没给就按当前用户的安装位置找
# (原来兜底是写死的"当前用户绝对路径"，换台机器或换个用户直接 ENOENT)
QCLI = os.environ.get("QODER_ADAPTER_CLI") or os.path.join(
    os.environ.get("USERPROFILE") or os.path.expanduser("~"),
    ".qoder-cn", "bin", "qoderclicn", "qoderclicn.exe")
DEFAULT_MODEL = os.environ.get("QODER_ADAPTER_MODEL") or None
# 下面这些默认值只在 plug.env 缺失时兜底：harnessd_win 自 2026-10-21(64f08e4)起会把
# plugs.json 的 env 段注入子进程，两边不一致时以 plugs.json 为准
PERMISSION_MODE = os.environ.get("QODER_ADAPTER_PERM_MODE", "bypass_permissions")
STREAM = os.environ.get("QODER_ADAPTER_STREAM") == "1"
CONTINUITY = os.environ.get("QODER_ADAPTER_CONTINUITY", "1") != "0"
MAX_TURN_WAIT = float(os.environ.get("ADAPTER_MAX_TURN_WAIT", "1800"))
MODEL_CACHE_TTL = 60.0
DEBUG = os.environ.get("ADAPTER_LOG") == "1"

LOG_DIR = os.environ.get("QODER_ADAPTER_LOG_DIR") or os.path.join(
    os.environ.get("HM_BASE_DIR", os.getcwd()), "logs")  # 缺省=当前运行目录;部署时用 HM_BASE_DIR 指定
LOG_FILE = os.path.join(LOG_DIR, "qoder-adapter.log")

OUT_LOCK = threading.Lock()
MODEL_LOCK = threading.Lock()
MODEL_CACHE = {"ts": 0.0, "models": []}
PENDING = {}          # rid -> method;die() 前逐个回 error,让主控看见死因
PENDING_LOCK = threading.Lock()
LIVE_PROCS = {}       # cli pid -> Popen;退出路径逐个 kill_tree
LIVE_LOCK = threading.Lock()
JOB = None            # (kernel32, 作业句柄),见 create_kill_on_close_job()


# ---------- 退出不留孤儿 ----------
# harnessd 的 task.close 用 proc.terminate(),Windows 上等价 TerminateProcess:适配器
# 一行 Python 都跑不到,atexit 和信号处理器都救不了这条路径(实测 2026-10-21 01:44,
# 适配器 pid 没了但 qoderclicn 带 5 个 bash.exe 孙进程继续跑)。所以兜底必须放在 OS 层:
# CLI 子进程挂进"句柄关闭即杀整个作业"的作业对象,适配器无论怎么死,系统替它收尸。
# 与主控在 start-all.py 里给守护进程用的同一套做法。

def create_kill_on_close_job():
    try:
        import ctypes
        from ctypes import wintypes
    except Exception:
        return None

    class IO_COUNTERS(ctypes.Structure):
        _fields_ = [(n, ctypes.c_ulonglong) for n in (
            "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
            "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class BASIC_LIMIT(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong),
                    ("PerJobUserTimeLimit", ctypes.c_longlong),
                    ("LimitFlags", wintypes.DWORD),
                    ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t),
                    ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t),
                    ("PriorityClass", wintypes.DWORD),
                    ("SchedulingClass", wintypes.DWORD)]

    class EXTENDED_LIMIT(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", BASIC_LIMIT),
                    ("IoInfo", IO_COUNTERS),
                    ("ProcessMemoryLimit", ctypes.c_size_t),
                    ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t),
                    ("PeakJobMemoryUsed", ctypes.c_size_t)]

    try:
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        job = k32.CreateJobObjectW(None, None)
        if not job:
            return None
        info = EXTENDED_LIMIT()
        info.BasicLimitInformation.LimitFlags = 0x2000   # JOB_OBJECT_LIMIT_KILL_ON_CLOSE
        if not k32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)):
            k32.CloseHandle(job)
            return None
        return (k32, job)
    except Exception:
        return None


def assign_to_job(proc):
    """挂不进作业只是少一层兜底(kill_tree 还在),不值得为它失败退出。"""
    if not JOB:
        return False
    try:
        return bool(JOB[0].AssignProcessToJobObject(JOB[1], int(proc._handle)))
    except Exception:
        return False


def reap_live(reason):
    """能跑到 Python 的退出路径(stdin EOF / die())主动收一遍,不等作业对象兜底。"""
    with LIVE_LOCK:
        procs = list(LIVE_PROCS.items())
        LIVE_PROCS.clear()
    for pid, proc in procs:
        log(f"退出收尸({reason}) cli pid={pid}")
        kill_tree(proc)


# ---------- 日志 / 上行输出 ----------

def log(msg):
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] [qoder-adapter] {msg}"
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        with open(LOG_FILE, "a", encoding="utf-8", errors="replace") as f:
            f.write(line + "\n")
    except Exception:
        pass
    if DEBUG:
        try:
            sys.stderr.write(line + "\n")
            sys.stderr.flush()
        except Exception:
            pass


def send_acp(obj):
    with OUT_LOCK:
        try:
            sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
            sys.stdout.flush()
        except Exception as e:
            log(f"写 stdout 失败(管道已关?): {type(e).__name__}: {e}")


def respond(rid, obj):
    if rid is not None:
        with PENDING_LOCK:
            PENDING.pop(rid, None)
    send_acp(obj)


def send_message_chunk(acp_sid, text, message_id, kind="agent_message_chunk"):
    send_acp({"jsonrpc": "2.0", "method": "session/update",
              "params": {"sessionId": acp_sid,
                         "update": {"sessionUpdate": kind, "messageId": message_id,
                                    "content": {"type": "text", "text": text}}}})


def die(msg, code=1):
    """死因双通道:① 未响应的请求逐个回 JSON-RPC error;② stderr 落尾(harnessd 回传主控)。"""
    with PENDING_LOCK:
        pending = list(PENDING.items())
        PENDING.clear()
    for rid, method in pending:
        try:
            respond(rid, {"jsonrpc": "2.0", "id": rid,
                          "error": {"code": -32000,
                                    "message": f"[qoder-adapter 致命] {method} 失败: {str(msg)[:800]}"}})
        except Exception:
            pass
    try:
        sys.stderr.write(f"[qoder-adapter] FATAL: {msg}\n")
        sys.stderr.flush()
    except Exception:
        pass
    log(f"FATAL: {msg}")
    reap_live(f"die: {str(msg)[:80]}")
    sys.exit(code)


# ---------- 向下:qoderclicn ----------

def clean_env():
    """剥掉桌面端注入的全部 QODER* 变量(实测会毒化 CLI),补齐 Windows 必需项。"""
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith("QODER")}
    home = env.get("USERPROFILE") or os.path.expanduser("~")
    for key, val in (("USERPROFILE", home),
                     ("HOME", home),
                     ("APPDATA", os.path.join(home, "AppData", "Roaming")),
                     ("LOCALAPPDATA", os.path.join(home, "AppData", "Local")),
                     ("TEMP", os.path.join(home, "AppData", "Local", "Temp")),
                     ("TMP", os.path.join(home, "AppData", "Local", "Temp")),
                     ("SYSTEMROOT", r"C:\Windows"),
                     ("PYTHONIOENCODING", "utf-8")):
        if not env.get(key):
            env[key] = val
    return env


def parse_model_lines(stdout_text):
    """`--list-models` 实测:首行表头 MODEL,其后每行一个模型显示名(-m 接受显示名也接受目录 id)。"""
    models = []
    for raw in (stdout_text or "").splitlines():
        name = raw.strip()
        if not name or name.upper() == "MODEL":
            continue
        if name not in models:
            models.append(name)
    return models


def list_models(force=False):
    """失败/解析为空 → 空表(静默),不能让适配器崩;结果缓存 60 秒。"""
    now = time.time()
    if not force:
        with MODEL_LOCK:
            if MODEL_CACHE["models"] and now - MODEL_CACHE["ts"] < MODEL_CACHE_TTL:
                return list(MODEL_CACHE["models"])
    models = []
    try:
        proc = subprocess.run([QCLI, "--list-models"], stdin=subprocess.DEVNULL,
                              capture_output=True, text=True, encoding="utf-8",
                              errors="replace", env=clean_env(), timeout=60,
                              creationflags=CREATE_NO_WINDOW)
        models = parse_model_lines(proc.stdout)
        if proc.returncode != 0 or not models:
            log(f"--list-models rc={proc.returncode} 解析 {len(models)} 项; "
                f"stderr尾={(proc.stderr or '').strip()[-200:]}")
    except Exception as e:
        log(f"--list-models 失败(静默空表): {type(e).__name__}: {e}")
        models = []
    with MODEL_LOCK:
        MODEL_CACHE["ts"] = time.time()
        MODEL_CACHE["models"] = list(models)
    return models


def kill_tree(proc):
    """Windows:terminate() 杀不净孙进程,taskkill /T 收整棵树并收尸。"""
    if proc is None:
        return
    try:
        if proc.poll() is None:
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                           capture_output=True, timeout=20, creationflags=CREATE_NO_WINDOW)
    except Exception as e:
        log(f"taskkill pid={getattr(proc, 'pid', '?')} 失败: {e}")
    try:
        proc.terminate()
    except Exception:
        pass
    try:
        proc.wait(timeout=15)
    except Exception:
        try:
            proc.kill()
            proc.wait(timeout=5)
        except Exception:
            pass


def feed_stdin(proc, text):
    """prompt 走 stdin:>16k 字符塞 argv 时 commander 直接吐 help(rc=1,实测),stdin 无此限。"""
    try:
        proc.stdin.write(text)
        proc.stdin.flush()
    except Exception as e:
        log(f"写 CLI stdin 失败: {type(e).__name__}: {e}")
    finally:
        try:
            proc.stdin.close()
        except Exception:
            pass


def run_turn(acp_sid, session, text):
    """跑一次 `qoderclicn -p`,返回 (回复文本, CLI会话id, 已推增量段数, 死因或None)。

    死因 "cancelled" / "timeout" 由 session 标志位定,取消与超时都靠外部 kill_tree。
    """
    args = [QCLI, "-p", "-w", session["cwd"], "--permission-mode", PERMISSION_MODE,
            "--output-format", "stream-json" if STREAM else "json"]
    if session.get("model"):
        args += ["-m", session["model"]]
    if session.get("resume"):
        args += ["-r", session["resume"]]
    try:
        proc = subprocess.Popen(
            args, cwd=session["cwd"], env=clean_env(), stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace", bufsize=1,
            creationflags=CREATE_NO_WINDOW)
    except Exception as e:
        return None, None, 0, f"qoderclicn 启动失败: {type(e).__name__}: {e}"
    session["proc"] = proc
    with LIVE_LOCK:
        LIVE_PROCS[proc.pid] = proc
    in_job = assign_to_job(proc)
    log(f"spawn pid={proc.pid} model={session.get('model')} resume={session.get('resume')} "
        f"cwd={session['cwd']} prompt={len(text)}字符 stream={STREAM} 作业对象={in_job} "
        f"线程数={threading.active_count()}")

    stderr_tail = []

    def pump_err():
        try:
            for chunk in iter(proc.stderr.readline, ""):
                if chunk:
                    stderr_tail.append(chunk)
                    del stderr_tail[:-40]
        except Exception:
            pass

    # readline 在 CLI 沉默时会一直阻塞,超时/取消只能靠旁路线程下手
    def watchdog():
        deadline = time.time() + MAX_TURN_WAIT
        while proc.poll() is None:
            if session.get("cancel"):
                kill_tree(proc)
                return
            if time.time() > deadline:
                session["timeout"] = True
                kill_tree(proc)
                return
            time.sleep(1)

    threading.Thread(target=pump_err, daemon=True).start()
    threading.Thread(target=watchdog, daemon=True).start()
    threading.Thread(target=feed_stdin, args=(proc, text), daemon=True).start()

    final_frame, chunks_sent, noise = None, 0, []
    for raw in iter(proc.stdout.readline, ""):
        if not raw:
            break
        try:
            frame = json.loads(raw)
        except Exception:
            noise.append(raw)
            continue
        if not isinstance(frame, dict):
            noise.append(raw)
            continue
        if frame.get("session_id"):
            session["cli_sid_seen"] = frame["session_id"]
        if frame.get("type") == "result":
            final_frame = frame
            continue
        if STREAM and frame.get("type") == "assistant":
            for block in ((frame.get("message") or {}).get("content") or []):
                btype = block.get("type")
                body = block.get("text") if btype == "text" else block.get("thinking")
                if not body:
                    continue
                send_message_chunk(acp_sid, body, f"{acp_sid}-s{chunks_sent}",
                                   "agent_message_chunk" if btype == "text"
                                   else "agent_thought_chunk")
                if btype == "text":
                    chunks_sent += 1

    kill_tree(proc)              # 正常收尾也走一遍:确保孙进程无残留
    with LIVE_LOCK:
        LIVE_PROCS.pop(proc.pid, None)
    code, tail = proc.poll(), "".join(stderr_tail).strip()
    cli_sid = session.get("cli_sid_seen")
    if session.get("cancel"):
        return None, cli_sid, chunks_sent, "cancelled"
    if session.get("timeout"):
        return None, cli_sid, chunks_sent, f"qoderclicn 超时(>{MAX_TURN_WAIT:.0f}s),已终止"
    if final_frame is None:
        extra = "".join(noise).strip()
        if code != 0:
            pick = next((ln.strip() for ln in reversed(tail.splitlines()) if ln.strip()),
                        f"exit code={code}")
            return None, cli_sid, chunks_sent, (
                f"qoderclicn 失败(code={code}): {pick[:600]}"
                + (f"; stdout尾: {extra[-400:]}" if extra else ""))
        if extra:
            return extra, cli_sid, chunks_sent, None      # 纯文本输出兜底
        return None, cli_sid, chunks_sent, (
            f"qoderclicn 无结果帧(code={code}); stderr尾: {tail[-400:] or '(空)'}")

    cli_sid = final_frame.get("session_id") or cli_sid
    if final_frame.get("is_error"):
        errs = final_frame.get("errors") or [final_frame.get("subtype") or "unknown"]
        return None, cli_sid, chunks_sent, "qoderclicn 报错: " + "; ".join(
            str(e)[:400] for e in errs)
    reply = final_frame.get("result") or ""
    if not reply and chunks_sent == 0:
        return None, cli_sid, chunks_sent, (
            f"qoderclicn 返回空回复(subtype={final_frame.get('subtype')})")
    return reply, cli_sid, chunks_sent, None


# ---------- ACP 向上 ----------

class Adapter:
    def __init__(self):
        self.sessions = {}
        self.seq = 0

    def handle(self, msg):
        method, rid = msg.get("method"), msg.get("id")
        params = msg.get("params") or {}
        if rid is not None:
            with PENDING_LOCK:
                PENDING[rid] = method or "?"
        if method == "initialize":
            respond(rid, {"jsonrpc": "2.0", "id": rid, "result": {
                "protocolVersion": PROTOCOL_VERSION,
                "contractVersion": CONTRACT_VERSION,
                "agentCapabilities": {"promptCapabilities": {"image": False}},
                "authMethods": []}})
        elif method == "session/new":
            self.session_new(rid, params)
        elif method == "session/prompt":
            self.session_prompt(rid, params)
        elif method == "session/cancel":
            self.session_cancel(params)
        elif method == "session/set_model":
            self.session_set_model(rid, params)
        elif rid is not None:
            respond(rid, {"jsonrpc": "2.0", "id": rid,
                          "error": {"code": -32601, "message": f"method not found: {method}"}})

    def session_new(self, rid, params):
        cwd = params.get("cwd") or os.getcwd()
        if not os.path.isdir(cwd):
            respond(rid, {"jsonrpc": "2.0", "id": rid,
                          "error": {"code": -32602, "message": f"cwd 不存在: {cwd}"}})
            return
        models = list_models()
        wanted = params.get("model")
        model = wanted if wanted in models else (DEFAULT_MODEL or (models[0] if models else None))
        if wanted and wanted not in models:
            log(f"session/new 请求模型 {wanted!r} 不在目录,回落 {model!r}")
        self.seq += 1
        acp_sid = f"qo-{int(time.time() * 1000)}-{self.seq}"
        self.sessions[acp_sid] = {"cwd": cwd, "model": model, "turns": 0, "resume": None,
                                  "cli_sid_seen": None, "busy": False, "cancel": False,
                                  "timeout": False, "proc": None, "prompt_rid": None}
        log(f"session/new -> {acp_sid} cwd={cwd} model={model} 模型表={len(models)}项")
        result = {"sessionId": acp_sid}
        if models:
            result["configOptions"] = [{
                "id": "model", "name": "Model", "category": "model", "type": "select",
                "currentValue": model,
                "options": [{"value": m, "name": m} for m in models]}]
        if wanted and wanted not in models:
            # 回落只写日志主控看不见,会以为这批活是它请求的那个模型跑的(审计中⑤)
            result["modelFallback"] = {"requested": wanted, "used": model,
                                       "available": models}
        respond(rid, {"jsonrpc": "2.0", "id": rid, "result": result})

    def session_set_model(self, rid, params):
        """qoderclicn 有 -m:真支持按会话切换(不像 zcode 只能诚实拒绝)。"""
        session = self.sessions.get(params.get("sessionId"))
        model_id = params.get("modelId")
        if session is None:
            respond(rid, {"jsonrpc": "2.0", "id": rid,
                          "error": {"code": -32602, "message": "unknown session"}})
            return
        models = list_models()
        if not model_id or model_id not in models:
            respond(rid, {"jsonrpc": "2.0", "id": rid,
                          "error": {"code": -32602,
                                    "message": f"model 不在 --list-models 目录: {model_id!r}; "
                                               f"可用={','.join(models) if models else '(空表)'}"}})
            return
        if session.get("busy"):
            respond(rid, {"jsonrpc": "2.0", "id": rid,
                          "error": {"code": -32000, "message": "session busy: 请先取消或等当前 turn 结束"}})
            return
        session["model"] = model_id
        log(f"set_model {params.get('sessionId')} -> {model_id}")
        respond(rid, {"jsonrpc": "2.0", "id": rid, "result": {}})

    def session_cancel(self, params):
        acp_sid = params.get("sessionId")
        session = self.sessions.get(acp_sid)
        if not session:
            log(f"session/cancel 忽略:未知会话 {acp_sid}")
            return
        session["cancel"] = True
        log(f"session/cancel {acp_sid} busy={session.get('busy')}")
        if session.get("busy") and session.get("proc"):
            kill_tree(session["proc"])     # watchdog 兜底,这里立即下手

    def session_prompt(self, rid, params):
        acp_sid = params.get("sessionId")
        session = self.sessions.get(acp_sid)
        if session is None:
            respond(rid, {"jsonrpc": "2.0", "id": rid,
                          "error": {"code": -32602, "message": "unknown session"}})
            return
        if session.get("busy"):
            respond(rid, {"jsonrpc": "2.0", "id": rid,
                          "error": {"code": -32000, "message": "session busy: 上一 prompt 仍在执行"}})
            return
        text = "\n".join((p.get("text") or "") for p in (params.get("prompt") or [])
                         if p.get("type") == "text").strip()
        if not text:
            respond(rid, {"jsonrpc": "2.0", "id": rid,
                          "error": {"code": -32602, "message": "prompt 为空(无 text 块)"}})
            return
        session.update({"prompt_rid": rid, "cancel": False, "timeout": False, "busy": True,
                        "resume": session["cli_sid_seen"] if (CONTINUITY and session["turns"] > 0)
                        else None})
        threading.Thread(target=self.run_turn_bg, args=(acp_sid, session, text),
                         daemon=True).start()
        # prompt 的 result 在终态时回(见 run_turn_bg)

    def run_turn_bg(self, acp_sid, session, text):
        turns = session["turns"]
        session["turns"] = turns + 1
        reply, cli_sid, chunks_sent, err = run_turn(acp_sid, session, text)
        rid = session["prompt_rid"]
        if cli_sid:
            session["cli_sid_seen"] = cli_sid
        # 先解锁会话再发终态帧:反过来的话,终态落地到主控发下一条 prompt 之间
        # busy 仍是 True,主控会撞见一个假的 "session busy"(2026-10-21 主控审计中④)
        session["busy"] = False
        session["proc"] = None
        if err == "cancelled":
            respond(rid, {"jsonrpc": "2.0", "id": rid, "result": {"stopReason": "cancelled"}})
            log(f"session {acp_sid} prompt 已取消")
        elif err:
            send_message_chunk(acp_sid, f"[qoder turn 失败] {err}", f"{acp_sid}-err{turns}")
            respond(rid, {"jsonrpc": "2.0", "id": rid, "result": {"stopReason": "refusal"}})
            log(f"session {acp_sid} 失败: {err[:200]}")
        else:
            if reply and chunks_sent == 0:
                send_message_chunk(acp_sid, reply, f"{acp_sid}-m{turns}")
            respond(rid, {"jsonrpc": "2.0", "id": rid, "result": {"stopReason": "end_turn"}})
            log(f"session {acp_sid} 完成 回复{len(reply or '')}字符 增量{chunks_sent}段 cli_sid={cli_sid}")


def main():
    global JOB
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass
    if os.name != "nt":
        die(f"qoder-adapter 只支持 Windows(当前 os.name={os.name!r}):"
            f"taskkill /T、作业对象、{os.path.basename(QCLI)} 都是 NT 专用")
    JOB = create_kill_on_close_job()
    log(f"adapter 启动 pid={os.getpid()} cli={QCLI} cli存在={os.path.isfile(QCLI)} "
        f"perm={PERMISSION_MODE} stream={STREAM} continuity={CONTINUITY} "
        f"作业对象={'已建' if JOB else '不可用,只靠 kill_tree 兜底'}")
    if not os.path.isfile(QCLI):
        die(f"QODER_ADAPTER_CLI 不存在: {QCLI}(请在 plugs.json env 里给全路径)")
    adapter = Adapter()
    # 必须 readline 迭代器:`for line in sys.stdin` 会 read-ahead 吞行,阻塞 turn 期间收不到 cancel
    for line in iter(sys.stdin.readline, ""):
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
            if not isinstance(msg, dict):
                continue
            adapter.handle(msg)
        except Exception as e:
            log(f"handle 异常: {type(e).__name__}: {e}")
            try:
                rid = json.loads(line).get("id")
            except Exception:
                rid = None
            if rid is not None:
                respond(rid, {"jsonrpc": "2.0", "id": rid,
                              "error": {"code": -32603,
                                        "message": f"adapter 内部错误: {type(e).__name__}: {str(e)[:300]}"}})
    log("stdin EOF,适配器退出")
    reap_live("stdin EOF")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except BaseException as exc:
        die(f"未捕获异常: {type(exc).__name__}: {exc}")
