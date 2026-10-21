#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""zcode-adapter — zcode(桌面版 3.15.3)接入 harness-mesh 的 ACP 适配器(v2,-p 引擎)。

向上(对 harnessd/主控 SDK):ACP stdio NDJSON,JSON-RPC 2.0,协议版本 1
  initialize / session/new / session/prompt / session/cancel + session/update 通知
向下(对 zcode 本体):spawn `zcode.cjs -p <prompt>`(--cwd 隔离,`-c` 续接同任务多轮)。

v2 引擎变更(2026-10-17 晚):app-server 会话路径的注册表 provider(bigmodel-api 等)
在 CLI 侧无可用密钥(V4 签名 invalid-config,密钥在桌面自身配置里 CLI 读不到),而
`-p` 路径走 login 刷新的账号凭据、实测全绿。故下行改用 -p:每任务一个会话上下文,
prompt 一次性执行,完整回复作为 agent_message_chunk 回传(stopReason=end_turn)。
代价:无流式增量、无跨任务会话复用;收益:鉴权必通、进程隔离天然无状态。

形态判定(《适配器编写指南》第 1 章):zcode 桌面版 = GUI-first;凭据策略 = 复用本体
登录态(login 刷新的共享凭据)。env 断供守卫保留(指南第 4 章):子进程显式注入
ZCODE_BUILTIN/PERSONAL_PROVIDER_CONFIG_FILE,否则 CLI 启动即死。

配置(env,plugs.json 的 env 段显式注入):
  ZCODE_MODELS 逗号分隔的可用型号登记(默认 GLM-5.3,GLM-5.3-Flash;仅上报展示,不支持按会话切换)
  NODE_EXE    node 可执行完整路径(默认 C:\\Program Files\\nodejs\\node.exe)
  ZCODE_CJS   zcode.cjs 完整路径(默认 ZCode 桌面版捆绑路径)
  ADAPTER_LOG 置 1 打 stderr 诊断
  ADAPTER_MAX_TURN_WAIT 单 prompt 最长等待秒数(默认 1800)
  ADAPTER_PIPE_DRAIN_WAIT 进程退出后等 stdout/stderr 读完的秒数(默认 10)

"""
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time

PROTOCOL_VERSION = 1
DEBUG = os.environ.get("ADAPTER_LOG") == "1"
MAX_TURN_WAIT = float(os.environ.get("ADAPTER_MAX_TURN_WAIT", "1800"))
# 进程退出后等管道消费线程读完剩余字节的上限(没有这个兜底,EOF 读不到就是第二次死等)
PIPE_DRAIN_WAIT = float(os.environ.get("ADAPTER_PIPE_DRAIN_WAIT", "10"))
CREATE_NO_WINDOW = 0x08000000
NODE_EXE = os.environ.get("NODE_EXE") or shutil.which("node") or r"C:\Program Files\nodejs\node.exe"
# ZCode 的入口按当前用户的安装位置找(原来兜底钉着某一台机器某个用户的绝对路径)
ZCODE_CJS = os.environ.get("ZCODE_CJS") or os.path.join(
    os.environ.get("LOCALAPPDATA") or os.path.expanduser("~\\AppData\\Local"),
    "Programs", "ZCode", "resources", "glm", "zcode.cjs")

# 会话模型表:zcode 桌面 3.15.3 builtin 注册表里的真实型号;env ZCODE_MODELS 可覆盖
MODELS = [m.strip() for m in os.environ.get("ZCODE_MODELS", "GLM-5.3,GLM-5.3-Flash").split(",") if m.strip()]
USER_HOME = os.environ.get("USERPROFILE") or os.path.expanduser("~")

# 待响应的 ACP 请求(rid -> method)。die() 退出前逐个回 error——harnessd_win 的
# task.exit 不回传 stderr,stdout 的 ACP error 是主控唯一能直接看到的死因通道
PENDING = {}
PENDING_LOCK = threading.Lock()


def log(msg):
    if DEBUG:
        sys.stderr.write(f"[zcode-adapter] {msg}\n")
        sys.stderr.flush()


def send_acp(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def respond(rid, obj):
    """带 rid 的 ACP 响应统一走这里:先弹 PENDING 再发。"""
    if rid is not None:
        with PENDING_LOCK:
            PENDING.pop(rid, None)
    send_acp(obj)


def notify_acp(method, params):
    send_acp({"jsonrpc": "2.0", "method": method, "params": params})


def die(msg, code=1):
    # 死因双通道:① 未响应的 ACP 请求逐个回 error(主控立即可见);② stderr 落尾(契约第 2 条)
    with PENDING_LOCK:
        pending = list(PENDING.items())
        PENDING.clear()
    for rid, method in pending:
        try:
            respond(rid, {"jsonrpc": "2.0", "id": rid,
                          "error": {"code": -32000,
                                    "message": f"[zcode-adapter 致命] {method} 失败: {str(msg)[:800]}"}})
        except Exception:
            pass
    sys.stderr.write(f"[zcode-adapter] FATAL: {msg}\n")
    sys.stderr.flush()
    sys.exit(code)


def acp_text_chunks(session_id, text, kind="agent_message_chunk", message_id="m1"):
    """把一段文本作为 session/update 通知推给主控。"""
    update = {"sessionUpdate": kind, "content": {"type": "text", "text": text}}
    if kind == "agent_message_chunk":
        update["messageId"] = message_id
    notify_acp("session/update", {"sessionId": session_id, "update": update})


def kill_tree(proc, why=""):
    """terminate()/kill() 在 Windows 上只干掉直接子进程,CLI 自己起的孙进程留成孤儿。
    taskkill /F /T 收整棵树,收不动再退化成 terminate/kill。"""
    if proc is None:
        return
    try:
        if proc.poll() is None:
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                           capture_output=True, timeout=20, creationflags=CREATE_NO_WINDOW)
    except Exception as e:
        log(f"taskkill pid={getattr(proc, 'pid', '?')} 失败({why}): {e}")
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


# ---------- 向下:zcode -p 引擎 ----------

def resolve_provider_env(env):
    """确保 CLI 找得到 zcode-builtin.json(找不到即启动即死,实测 2026-10-17)。

    桌面端把 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 注入自家子进程,但 harnessd 守护链
    (boot guardian→harnessd)没有这批变量——按指南第 4 章 env 显式化,这里主动解析
    最新版本路径注入,不依赖继承。
    """
    cur = env.get("ZCODE_BUILTIN_PROVIDER_CONFIG_FILE")
    if not (cur and os.path.isfile(cur)):
        cands = glob.glob(os.path.join(
            USER_HOME, ".zcode", "v2", "runtime", "provider",
            "windows-x86_64", "*", "endpoint-*", "zcode-builtin.json"))

        def ver_of(path):
            m = re.search(r"[\\/](\d+(?:\.\d+)*)[\\/]", path)
            return tuple(int(x) for x in m.group(1).split(".")) if m else (0,)

        if cands:
            env["ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"] = max(cands, key=ver_of)
            log(f"注入 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = {env['ZCODE_BUILTIN_PROVIDER_CONFIG_FILE']}")
    personal = os.path.join(USER_HOME, ".zcode", "v2", "provider_config.json")
    if not env.get("ZCODE_PERSONAL_PROVIDER_CONFIG_FILE") and os.path.isfile(personal):
        env["ZCODE_PERSONAL_PROVIDER_CONFIG_FILE"] = personal
    for k, v in (("USERPROFILE", USER_HOME),
                 ("APPDATA", os.path.join(USER_HOME, "AppData", "Roaming")),
                 ("LOCALAPPDATA", os.path.join(USER_HOME, "AppData", "Local")),
                 ("TEMP", os.path.join(USER_HOME, "AppData", "Local", "Temp")),
                 ("SYSTEMROOT", r"C:\Windows")):
        if not env.get(k) and os.path.isdir(v):
            env[k] = v
            log(f"补齐 env {k}")
    return env


def run_prompt(cwd, text, continue_latest, session=None):
    """跑一次 `zcode -p`,返回 (回复文本, 死因或None)。

    -c 续接同 cwd 最近会话(同一 ACP 会话的多轮);首轮不用。
    session 非空时把 Popen 写回 session["proc"],session/cancel 才杀得到这轮 CLI。
    """
    env = resolve_provider_env({**os.environ})
    args = [NODE_EXE, ZCODE_CJS, "-p", text, "--cwd", cwd]
    if continue_latest:
        args.append("-c")
    proc = subprocess.Popen(
        args, cwd=cwd, env=env,
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace", bufsize=1,
        creationflags=CREATE_NO_WINDOW)
    if session is not None:
        session["proc"] = proc
    out_parts = []
    stderr_tail = []

    def pump_err():
        try:
            for line in proc.stderr:
                stderr_tail.append(line)
                del stderr_tail[:-40]
        except Exception:
            pass

    def pump_out():
        # Windows 匿名管道只有 4-8KB:CLI 把 stdout 写满就阻塞在自己的 write 上。
        # 只在进程退出后才读 stdout 的话,进程永不退出 = 双方死等到单轮上限,回复全丢。
        try:
            for line in proc.stdout:
                out_parts.append(line)
        except Exception:
            pass

    t_err = threading.Thread(target=pump_err, daemon=True)
    t_out = threading.Thread(target=pump_out, daemon=True)
    t_err.start()
    t_out.start()
    deadline = time.time() + MAX_TURN_WAIT
    while time.time() < deadline:
        if proc.poll() is not None:
            break
        time.sleep(0.5)
    else:
        kill_tree(proc, "单轮超时")
        return None, f"zcode -p 超时(>{MAX_TURN_WAIT}s),已终止"
    # 进程退出后写端关闭,消费线程读到 EOF 自然结束;有界 join 取代 communicate(timeout=30) ——
    # communicate 不能与正在读同一句柄的线程混用,且它的 TimeoutExpired 会穿出这里
    t_out.join(PIPE_DRAIN_WAIT)
    t_err.join(PIPE_DRAIN_WAIT)
    if t_out.is_alive():
        log(f"stdout 消费线程 {PIPE_DRAIN_WAIT}s 未收尾,回复可能不完整")
    out = "".join(out_parts)
    tail = "".join(stderr_tail).strip()
    if proc.returncode != 0:
        # 死因优先取 stderr 里最能定因的行
        lines = [ln.strip() for ln in tail.splitlines() if ln.strip()]
        pick = next((ln for ln in lines
                     if any(k in ln for k in ("signing", "API Key", "Error", "invalid-config"))), None) \
            or (lines[-1] if lines else f"exit code={proc.returncode}")
        return None, f"zcode -p 失败(code={proc.returncode}): {pick[:600]}"
    reply = (out or "").strip()
    if not reply and tail:
        return None, f"zcode -p 无输出;stderr尾: {tail[-400:]}"
    return reply, None


# ---------- ACP 向上 ----------

class Adapter:
    def __init__(self):
        self.sessions = {}   # acp_session_id -> {"cwd", "turns", "prompt_rid", "busy", "cancel", "proc"}

    def handle(self, msg):
        method, rid = msg.get("method"), msg.get("id")
        params = msg.get("params") or {}
        if rid is not None:
            with PENDING_LOCK:
                PENDING[rid] = method or "?"
        if method == "initialize":
            respond(rid, {"jsonrpc": "2.0", "id": rid, "result": {
                "protocolVersion": PROTOCOL_VERSION,
                "agentCapabilities": {"loadSession": False,
                                      "promptCapabilities": {"image": False}},
                "authMethods": []}})
        elif method == "session/new":
            self._session_new(rid, params)
        elif method == "session/prompt":
            self._session_prompt(rid, params)
        elif method == "session/cancel":
            acp_sid = params.get("sessionId")
            session = self.sessions.get(acp_sid)
            if session:
                session["cancel"] = True
                kill_tree(session.get("proc"), "session/cancel")
        elif method == "session/set_model":
            # 诚实拒绝:zcode CLI(-p)无 --model,不支持按会话选模型;静默接受会跑错模型
            respond(rid, {"jsonrpc": "2.0", "id": rid,
                          "error": {"code": -32602, "message":
                                    "zcode -p 引擎不支持按会话选模型;请在 ZCode 桌面端 /model 切换,"
                                    "或在 plugs.json env ZCODE_MODELS 登记"}})
        elif rid is not None:
            respond(rid, {"jsonrpc": "2.0", "id": rid,
                          "error": {"code": -32601, "message": f"method not found: {method}"}})

    def _session_new(self, rid, params):
        cwd = params.get("cwd") or os.getcwd()
        if not os.path.isdir(cwd):
            respond(rid, {"jsonrpc": "2.0", "id": rid,
                          "error": {"code": -32602, "message": f"cwd 不存在: {cwd}"}})
            return
        acp_sid = f"zp-{int(time.time()*1000)}-{len(self.sessions)}"
        self.sessions[acp_sid] = {"cwd": cwd, "turns": 0, "prompt_rid": None,
                                  "done": True, "cancel": False, "proc": None}
        log(f"session/new -> {acp_sid} cwd={cwd} model={params.get('model')}")
        result = {"sessionId": acp_sid}
        if MODELS:  # 模型清单非空时上报模型表(configOptions select)
            result["configOptions"] = [{"id": "model", "name": "Model", "category": "model",
                                        "type": "select", "currentValue": MODELS[0],
                                        "options": [{"value": m, "name": m} for m in MODELS]}]
        respond(rid, {"jsonrpc": "2.0", "id": rid, "result": result})

    def _session_prompt(self, rid, params):
        acp_sid = params.get("sessionId")
        session = self.sessions.get(acp_sid)
        if not session:
            respond(rid, {"jsonrpc": "2.0", "id": rid,
                          "error": {"code": -32602, "message": "unknown session"}})
            return
        if session.get("busy"):
            respond(rid, {"jsonrpc": "2.0", "id": rid,
                          "error": {"code": -32000, "message": "session busy: 上一 prompt 仍在执行"}})
            return
        text = "\n".join(p.get("text", "") for p in (params.get("prompt") or [])
                         if p.get("type") == "text")
        session["prompt_rid"] = rid
        session["done"] = False
        session["cancel"] = False
        session["busy"] = True
        threading.Thread(target=self._run_turn, args=(acp_sid, session, text),
                         daemon=True).start()
        # prompt 的 result 在终态时回(见 _run_turn)

    def _run_turn(self, acp_sid, session, text):
        turns = session["turns"]
        session["turns"] = turns + 1
        rid = session["prompt_rid"]
        answered = False
        try:
            reply, err = run_prompt(session["cwd"], text, continue_latest=turns > 0,
                                    session=session)
            if session.get("cancel"):
                respond(rid, {"jsonrpc": "2.0", "id": rid,
                              "result": {"stopReason": "cancelled"}})
                answered = True
                log(f"session {acp_sid} prompt 被取消")
                return
            if err:
                acp_text_chunks(acp_sid, f"[zcode turn 失败] {err}", message_id=f"{acp_sid}-err")
                respond(rid, {"jsonrpc": "2.0", "id": rid,
                              "result": {"stopReason": "refusal"}})
                log(f"session {acp_sid} prompt 失败: {err[:200]}")
            else:
                if reply:
                    acp_text_chunks(acp_sid, reply, message_id=f"{acp_sid}-m{session['turns']}")
                respond(rid, {"jsonrpc": "2.0", "id": rid,
                              "result": {"stopReason": "end_turn"}})
                log(f"session {acp_sid} prompt 完成,回复 {len(reply)} 字符")
            answered = True
        except Exception as e:
            # 线程带异常死掉会让 busy 永远停在 True,此后每条 prompt 都被
            # "session busy" 挡回,这个会话再也救不回来 —— 所以异常必须回终态帧并解锁
            log(f"session {acp_sid} turn 线程异常: {type(e).__name__}: {e}")
            if not answered and rid is not None:
                try:
                    respond(rid, {"jsonrpc": "2.0", "id": rid,
                                  "error": {"code": -32603, "message":
                                            f"zcode turn 异常: {type(e).__name__}: {str(e)[:300]}"}})
                except Exception:
                    pass
        finally:
            session["busy"] = False
            session["proc"] = None


def main():
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass
    if not os.path.isfile(NODE_EXE):
        die(f"NODE_EXE 不存在: {NODE_EXE}(请在 plugs.json env 里显式给全)")
    if not os.path.isfile(ZCODE_CJS):
        die(f"ZCODE_CJS 不存在: {ZCODE_CJS}(请在 plugs.json env 里显式给全)")
    log(f"adapter v2(-p 引擎)启动 node={NODE_EXE} zcode.cjs={ZCODE_CJS}")
    adapter = Adapter()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            adapter.handle(json.loads(line))
        except Exception as e:
            sys.stderr.write(f"[zcode-adapter] handle error: {e}\n")
    log("stdin EOF,退出")


if __name__ == "__main__":
    main()
