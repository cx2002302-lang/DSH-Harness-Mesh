#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
mesh-guardian.py — WinPC 侧 harness-mesh 自动值守进程（WorkBuddy 哨兵）

单进程三线程，纯标准库：
  T1 频道哨兵   盯 chat.log 新块；被 @ 或关键事件 → 简短自动应答 + 本地日志
  T2 登录探测器 盯 CLI 凭证落盘（文件检测）+ 低频 -p PONG 兜底；就绪即播报，一次性
  T3 mesh 哨兵  经 harness-mcp-stdio 网桥调 harness_list / harness_status；
               节点健康、任务状态推进、completed 汇报、异常告警

纪律（遵循《频道规约》）：
  - 只 append 自己的 [自动] 块，写前必读、原文不动
  - 不涉密：token/密码不进频道、不进日志
  - 自动应答只限"确认收悉/已证实事件"，复杂决策留给 WorkBuddy 主会话

状态持久化：guardian-state.json（已见块数 / 登录就绪标记 / 上次快照）
日志：guardian-workbuddy.log
"""
import json
import os
import platform
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

if os.name == "nt":
    import msvcrt

# ---------- 路径常量 ----------
# 全部 env 可覆盖(MG_SHARE / MG_PYTHON / MG_STDIO_BRIDGE / MG_NODE / MG_CLI / MG_NODE_NAME)，
# 不给就按当前机器发现：用户目录、.workbuddy 里最新的解释器、WorkBuddy 的安装位置。
# 原来这几条把当前机器的用户目录、精确版本号(3.13.12 / 22.22.2-6)和一台机器的名字
# 写死在源码里：换台机器/换个用户/升个版本就是 ENOENT，而现场改不动字面量，只会看到"没起来"。
HERE = Path(__file__).resolve().parent


def _home() -> Path:
    return Path(os.environ.get("USERPROFILE") or os.environ.get("HOME") or str(Path.home()))


def _newest(root: Path, exe: str, fallback):
    """root 下按版本号挑最新的那份。版本号必须按数字比——字典序会把 3.13.12
    排在 3.9.1 前面，取 [-1] 就静默退到更旧的解释器。"""
    try:
        vs = [p for p in root.iterdir() if p.is_dir() and (p / exe).exists()]
    except OSError:
        return fallback
    if not vs:
        return fallback
    return str(sorted(vs, key=lambda p: [int(x) for x in re.split(r"[^0-9]+", p.name) if x])[-1] / exe)


SHARE = Path(os.environ.get("MG_SHARE") or HERE.parent)   # 共享本机视图;局域网共享盘部署时用 MG_SHARE 指到 <LAN-SHARE> 路径
WB_GREEN = HERE                                           # 状态/日志跟着脚本自己走，不跟共享盘走
CHANNEL = SHARE / "AI协调频道"
CHAT_LOG = CHANNEL / "chat.log"
STATE_FILE = WB_GREEN / "guardian-state.json"
LOG_FILE = WB_GREEN / "guardian-workbuddy.log"

WB_BIN = _home() / ".workbuddy" / "binaries"
PYTHON = os.environ.get("MG_PYTHON") or _newest(WB_BIN / "python", "python.exe", sys.executable)
STDIO_BRIDGE = os.environ.get("MG_STDIO_BRIDGE") or str(_home() / ".workbuddy" / "mcp-bin" / "harness-mcp-stdio.py")
NODE = os.environ.get("MG_NODE") or _newest(WB_BIN / "node", "node.exe", shutil.which("node") or "node")
CLI = os.environ.get("MG_CLI") or str(
    Path(os.environ.get("LOCALAPPDATA") or str(_home() / "AppData" / "Local"))
    / "Programs" / "WorkBuddy" / "resources" / "app.asar.unpacked" / "cli" / "bin" / "codebuddy")

NODE_NAME = os.environ.get("MG_NODE_NAME") or \
    f"{os.environ.get('COMPUTERNAME') or platform.node()}-workbuddy"
CREATE_NO_WINDOW = 0x08000000  # 无控制台窗口(pythonw 下 subprocess 默认会弹窗)
POLL_CHANNEL = 15      # 频道哨兵间隔 s
POLL_LOGIN_FS = 60     # 登录文件检测间隔 s
LOGIN_P_EVERY = 900    # -p 兜底验证间隔 s（15min）
POLL_MESH = 30         # mesh 哨兵间隔 s
BRIDGE_WAIT = float(os.environ.get("MG_BRIDGE_WAIT", "60"))   # 网桥一次响应的上限 s(原版的 60 只算不用:readline 不返回就判不到)

_lock = threading.Lock()          # 保护频道写入(只护本进程三线程;跨进程靠 O_APPEND)
_mesh_lock = threading.Lock()     # 保护 mesh stdio 客户端
_stop = threading.Event()


def log(msg: str):
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass
    print(line, flush=True)


def load_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {"seen_blocks": 2, "login_ready": False, "login_announced": False,
                "known_task_ids": [], "mesh_alerts": {}}


def save_state(updates: dict):
    """只合并本次改动的键:整写会把别的线程刚更新的键盖回旧值,
    重启后按旧 seen_blocks 重放历史块 → 对同一批消息重复自动应答。"""
    try:
        st = load_state()
        st.update(updates)
        tmp = STATE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(st, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(STATE_FILE)
    except Exception as e:
        log(f"状态落盘失败: {e}")


# ---------- 频道读写 ----------

def split_blocks(text: str):
    """按 '### [ts] name' 切块，返回 [(header, body)]"""
    blocks, cur = [], []
    for line in text.splitlines():
        if line.startswith("### [") and cur:
            blocks.append(cur)
            cur = [line]
        else:
            cur.append(line)
    if cur:
        blocks.append(cur)
    return ["\n".join(b).strip() for b in blocks if any(s.strip() for s in b)]


LOCK_OFF = 1 << 30   # 远超文件尾的哨兵偏移:锁它只当排队牌,读全文的人碰不到这个范围


def _append_locked(path, make_block):
    """跨进程串行追加:拿到锁之后才构造内容并落盘。

    为什么要锁:Windows 的 O_APPEND 不保证跨进程原子 —— 实测两进程各追加 120 块,
    有一对算出同一个 EOF 偏移,后写的整块盖掉先写的(块数 240/241,文件正好短一块)。
    POSIX 上 O_APPEND 是真原子的,所以锁只在 nt 加。
    """
    flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_BINARY", 0)
    fd = os.open(str(path), flags)
    locked = False
    try:
        if os.name == "nt":
            os.lseek(fd, LOCK_OFF, os.SEEK_SET)
            for _ in range(100):          # 最多等 5s;抢不到就报错,不许盲写
                try:
                    msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                    locked = True
                    break
                except OSError:
                    time.sleep(0.05)
            if not locked:
                raise RuntimeError("频道锁 5s 没抢到(有写者卡住)")
        data = make_block().encode("utf-8")
        off = 0
        while off < len(data):            # os.write 可能只写一半,漏掉的那半就是丢的块
            off += os.write(fd, data[off:])
    finally:
        try:
            if locked:
                os.lseek(fd, LOCK_OFF, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        except Exception:
            pass
        os.close(fd)


def channel_append(block_body: str, speaker: str = "WorkBuddy"):
    """追加一个块:锁内构造 + O_APPEND 落盘,绝不整写回文件。

    原来的 read_text → 拼 → write_text 只护得住本进程三个线程;别的节点在同一时刻
    落盘的新块,会被这份旧内容原样盖掉 —— 频道是 append-only,盖掉就是丢消息
    (实测并发 120+120 块对方丢 23 块,还能写出半个块让 UTF-8 直接解码失败)。
    """
    with _lock:
        try:
            def make_block():
                ts = time.strftime("%Y-%m-%d %H:%M")
                tail = b""
                try:
                    if CHAT_LOG.exists():
                        with open(CHAT_LOG, "rb") as f:
                            f.seek(max(0, CHAT_LOG.stat().st_size - 8))
                            tail = f.read()
                except Exception:
                    tail = b""
                n = len(tail) - len(tail.rstrip(b"\n"))   # 块间留且只留一个空行
                text = "\n" * max(0, 2 - n) + f"### [{ts}] {speaker}\n{block_body.strip()}\n"
                # 现网 chat.log 是纯 CRLF(2708 行,零裸 LF),按房规写;混行尾渲染器不挑但 diff 难看。
                # os.open 在 Windows 默认文本模式会再翻一次 \n,所以下面必须带 O_BINARY,否则变成 \r\r\n
                return text.replace("\n", "\r\n")
            _append_locked(CHAT_LOG, make_block)
            return True
        except Exception as e:
            log(f"频道写入失败: {e}")
            return False


# ---------- mesh stdio 客户端（走 harness-mcp-stdio 网桥） ----------

class MeshClient:
    """常驻子进程：NDJSON JSON-RPC over stdio（initialize → initialized → tools/call）"""

    def __init__(self):
        self.proc = None
        self.rid = 0
        self.q = None
        self._ensure()

    def _ensure(self):
        if self.proc and self.proc.poll() is None:
            return
        env = dict(os.environ)
        self.proc = subprocess.Popen(
            [PYTHON, STDIO_BRIDGE],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding="utf-8", bufsize=1, env=env,
            creationflags=CREATE_NO_WINDOW)
        self.q = queue.Queue()
        threading.Thread(target=self._pump, args=(self.proc, self.q), daemon=True).start()
        self._send({"jsonrpc": "2.0", "id": self._next(),
                    "method": "initialize",
                    "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                               "clientInfo": {"name": "mesh-guardian", "version": "1.0"}}})
        self._read_until_response()
        self._send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        log("mesh stdio 客户端已握手")

    @staticmethod
    def _pump(proc, q):
        """把 stdout 一行行搬进队列。readline 会卡,但只卡在这个 daemon 线程里,不卡调用方。"""
        try:
            for line in iter(proc.stdout.readline, ""):
                q.put(line)
        except Exception:
            pass
        q.put(None)   # EOF/读挂了:放个哨兵,让 _read_until_response 能立刻放手

    def _drop(self, why):
        """判定这次网桥不可信:收进程、丢句柄,让下一轮 _ensure 重建(锁也还得开)。"""
        proc, self.proc, self.q = self.proc, None, None
        if proc and proc.poll() is None:
            try:
                if os.name == "nt":
                    subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                                   capture_output=True, creationflags=CREATE_NO_WINDOW, timeout=15)
                else:
                    proc.terminate()
            except Exception:
                pass
            try:
                proc.wait(timeout=5)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
        raise RuntimeError(f"{why}(mesh bridge pid={getattr(proc, 'pid', '?')})")

    def _next(self):
        self.rid += 1
        return self.rid

    def _send(self, obj):
        self.proc.stdin.write(json.dumps(obj, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()

    def _read_until_response(self, timeout=BRIDGE_WAIT):
        deadline = time.time() + timeout
        q = self.q
        while True:
            left = deadline - time.time()
            if left <= 0:
                self._drop(f"响应超时 {timeout}s(对端一个字都没回)")
            try:
                line = q.get(timeout=min(left, 1.0))
            except queue.Empty:
                continue
            if line is None:
                self._drop("stdout EOF")
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            if obj.get("id") is not None or "error" in obj:
                return obj

    def call(self, name: str, args: dict):
        with _mesh_lock:
            self._ensure()
            rid = self._next()
            self._send({"jsonrpc": "2.0", "id": rid, "method": "tools/call",
                        "params": {"name": name, "arguments": args}})
            resp = self._read_until_response()
            if "error" in resp:
                raise RuntimeError(resp["error"].get("message", str(resp["error"])))
            # MCP tools/call 结果在 result.content[0].text（JSON 字符串）
            content = (resp.get("result") or {}).get("content") or []
            for c in content:
                if c.get("type") == "text":
                    try:
                        return json.loads(c["text"])
                    except Exception:
                        return c["text"]
            return resp.get("result")


# ---------- T1 频道哨兵 ----------

KEYWORDS = ("@WorkBuddy", "改名", "登录", "plug.reload", "探针", "reload", "hello")
WATCH_LOG = WB_GREEN / "channel-watch.log"


def t1_channel_watch():
    st = load_state()
    seen = st.get("seen_blocks", 0)
    log(f"T1 频道哨兵上岗（已见 {seen} 块）")
    while not _stop.is_set():
        try:
            text = CHAT_LOG.read_text(encoding="utf-8") if CHAT_LOG.exists() else ""
            blocks = split_blocks(text)
            if len(blocks) > seen:
                for b in blocks[seen:]:
                    header = b.splitlines()[0] if b else ""
                    if "WorkBuddy" in header:      # 自己发的块跳过
                        continue
                    log(f"T1 收到新块: {header[:60]}")
                    # 机械落盘:所有他人块全文进 watch log(不依赖 LLM,额度受限期也能追溯)
                    try:
                        with open(WATCH_LOG, "a", encoding="utf-8") as f:
                            f.write(f"\n===== [{time.strftime('%Y-%m-%d %H:%M:%S')}] 频道新块 =====\n{b}\n")
                    except Exception as e:
                        log(f"T1 watch log 写入失败: {e}")
                    if any(k in b for k in KEYWORDS):
                        # 保守自动应答：确认收悉 + 指引，不替主会话做决策
                        topic = "点名/关键事项"
                        for k in ("改名", "登录", "plug.reload", "探针"):
                            if k in b:
                                topic = k
                                break
                        ok = channel_append(
                            f"[自动·值守哨兵] 收到，已记录并转达 WorkBuddy 主会话（事项：{topic}）。"
                            f"人工研判后下一条回复；若是登录后联调指令，主会话会立即执行。")
                        log(f"T1 已自动应答（{topic}）: {'成功' if ok else '失败'}")
                seen = len(blocks)
                save_state({"seen_blocks": seen})
        except Exception as e:
            log(f"T1 异常: {e}")
        _stop.wait(POLL_CHANNEL)


# ---------- T2 登录探测器 ----------

def _cred_paths_snapshot():
    """CLI 凭证可能落盘的位置快照（只看有无变化，不读内容）"""
    snap = {}
    for d in [Path.home() / ".codebuddy", Path.home() / ".workbuddy" / "credentials"]:
        if not d.exists():
            snap[str(d)] = None
            continue
        items = []
        try:
            for p in sorted(d.rglob("*")):
                if p.is_file():
                    items.append((str(p.relative_to(d)), p.stat().st_mtime, p.stat().st_size))
        except Exception:
            pass
        snap[str(d)] = items
    return snap


def _probe_p():
    """跑一次 -p PONG 验证；返回 True/False"""
    env = {**os.environ, "CODEBUDDY_FORCE_LITE_WB_BUNDLE": "1"}
    try:
        r = subprocess.run(
            [NODE, CLI, "-p", "reply with exactly: PONG", "--model", "fast-model", "--port", "0"],
            capture_output=True, text=True, timeout=150,
            encoding="utf-8", errors="replace", env=env,
            creationflags=CREATE_NO_WINDOW)
        out = (r.stdout or "") + (r.stderr or "")
        if "PONG" not in out:
            log(f"T2 -p 未过, 输出摘要: {out.strip()[:120]}")
        return "PONG" in out
    except Exception as e:
        log(f"T2 -p 探测异常: {e}")
        return False


def t2_gateway_watch():
    """T2 gateway 健康哨兵：每 60s 验证 gateway 可达（主链路的关键依赖）。
    CLI 凭证探测已废弃（主链路不依赖 CLI 登录，改用 Gateway/REST runs）。"""
    log("T2 gateway 健康哨兵上岗（60s 轮询）")
    last_state = None
    while not _stop.is_set():
        try:
            base = _discover_gateway_port()
            cur = "up" if base else "down"
            if cur != last_state:
                log(f"T2 gateway 状态: {last_state} -> {cur} ({base})")
                if cur == "down" and last_state is not None:
                    channel_append(
                        "[自动·gateway 哨兵] gateway 不可达（WorkBuddy serve 实例可能重启/退出）。"
                        "@主控侧(DSH) 若正派活请暂缓；WinPC 侧将自动重发现，恢复即播报。")
                elif cur == "up" and last_state == "down":
                    channel_append(f"[自动·gateway 哨兵] gateway 已恢复（{base}）。派活可继续。")
                last_state = cur
        except Exception as e:
            log(f"T2 异常: {e}")
        _stop.wait(60)


def _discover_gateway_port():
    """扫 WorkBuddy 进程端口，验根页面标题。返回 base url 或 None"""
    try:
        import subprocess as _sp
        ps = _sp.run(["powershell", "-NoProfile", "-Command",
                      "(Get-Process -Name WorkBuddy -ErrorAction SilentlyContinue).Id -join ','"],
                     capture_output=True, text=True, encoding="utf-8", errors="replace",
                     timeout=10, creationflags=CREATE_NO_WINDOW).stdout
        wb_pids = {x.strip() for x in ps.split(",") if x.strip().isdigit()}
        out = _sp.run(["netstat", "-ano"], capture_output=True, text=True,
                      encoding="utf-8", errors="replace", timeout=10,
                      creationflags=CREATE_NO_WINDOW).stdout
        ports = set()
        for line in out.splitlines():
            parts = line.split()
            if len(parts) >= 4 and parts[0] == "TCP" and "LISTENING" in line and parts[-1] in wb_pids:
                try:
                    ports.add(int(parts[1].rsplit(":", 1)[1]))
                except Exception:
                    pass
        import urllib.request as _ur
        for port in sorted(ports):
            try:
                with _ur.urlopen(_ur.Request(f"http://127.0.0.1:{port}", method="GET"), timeout=3) as r:
                    body = r.read(2048)
                    if b"CodeBuddy Gateway" in body or b"Remote Control" in body:
                        return f"http://127.0.0.1:{port}"
            except Exception:
                pass
    except Exception:
        pass
    return None


# ---------- T3 mesh 哨兵 ----------

def t3_mesh_watch():
    st = load_state()
    known = set(st.get("known_task_ids", []))
    node_state = {}
    client = MeshClient()
    log("T3 mesh 哨兵上岗（30s 轮询）")
    while not _stop.is_set():
        try:
            nodes = client.call("harness_list", {}) or []
            me = [n for n in nodes if isinstance(n, dict)
                  and NODE_NAME in (n.get("name") or "")]
            for n in me:
                key = n.get("name")
                running = n.get("running")
                health = n.get("health")
                prev = node_state.get(key)
                if prev is not None and (prev.get("running") != running or prev.get("health") != health):
                    log(f"T3 节点 {key} 变化: health={prev.get('health')}→{health} running={prev.get('running')}→{running}")
                    if health not in (None, "up"):
                        channel_append(
                            f"[自动·mesh 哨兵] 节点 {key} 健康异常：health={health}（此前 {prev.get('health')}）。"
                            f"@主控侧(DSH) 如正在派活请暂缓，WinPC 侧排查 ANN 绿模/guardian。")
                node_state[key] = {"running": running, "health": health}
            # 跟进已知任务 + 发现新任务
            for n in me:
                rid = n.get("running") or 0
            # harness_list 不带任务明细；用 status 跟进已知 id，新 id 从 running 增量发现靠 dispatch 广播——此处轮询已知 id
            for tid in list(known):
                try:
                    s = client.call("harness_status", {"task_id": tid}) or {}
                    state = s.get("state")
                    if state in ("completed", "failed"):
                        log(f"T3 任务 {tid} 终态: {state}")
                        detail = f"error={s.get('error')}" if state == "failed" else "可经 harness_result 取汇报"
                        channel_append(
                            f"[自动·mesh 哨兵] 任务 {tid} 到达终态：{state}（{detail}）。")
                        known.discard(tid)
                        save_state({"known_task_ids": sorted(known)})
                    elif s.get("pending_permission"):
                        channel_append(
                            f"[自动·mesh 哨兵] 任务 {tid} 触发权限确认 pending_permission，需要人工点允许（或 plug 侧配 --permission-mode dontAsk）。")
                except Exception as e:
                    log(f"T3 status({tid}) 异常: {e}")
        except Exception as e:
            log(f"T3 异常: {e}，尝试重连")
            try:
                client = MeshClient()
            except Exception:
                pass
        _stop.wait(POLL_MESH)


def main():
    log("=" * 60)
    log(f"mesh-guardian 启动（节点名 {NODE_NAME}）")
    for name, path in (("python", PYTHON), ("stdio 网桥", STDIO_BRIDGE), ("node", NODE), ("CLI", CLI)):
        if not os.path.exists(path):
            log(f"[警告] {name} 不存在: {path}（用 MG_PYTHON/MG_STDIO_BRIDGE/MG_NODE/MG_CLI 指过来）")
    threads = [
        threading.Thread(target=t1_channel_watch, name="T1-channel", daemon=True),
        threading.Thread(target=t2_gateway_watch, name="T2-gateway", daemon=True),
        threading.Thread(target=t3_mesh_watch, name="T3-mesh", daemon=True),
    ]
    for t in threads:
        t.start()
    ok = channel_append(
        "[自动·mesh-guardian 上线] WinPC 侧值守进程已启动，三哨兵在岗："
        "①频道哨兵（被 @ 或关键事项自动应答，所有消息机械落盘 channel-watch.log）"
        "②gateway 健康哨兵（60s 轮询，gateway 掉线/恢复自动播报）"
        "③mesh 哨兵（节点健康/任务状态/终态汇报）。本进程只做已证实事件的播报与确认，"
        "复杂决策仍由 WorkBuddy 主会话人工研判。")
    log(f"上线播报: {'成功' if ok else '失败'}")
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        _stop.set()
        log("mesh-guardian 停止")


if __name__ == "__main__":
    main()
