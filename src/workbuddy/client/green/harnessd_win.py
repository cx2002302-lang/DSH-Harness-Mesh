#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
harnessd 的 Windows 被控端实现（与 208 上 harness-mesh 的 acp-plug 协议兼容）

## 为什么要写这个
mesh 侧的本地节点（plugId 默认按计算机名生成：`<计算机名>-workbuddy`，可用
HM_NODE_NAME 覆盖）类型是 `acp-plug`，它不是简单的
「TCP→stdio 哑桥」。主控的完整流程是：

  控制连接(4字节长度帧 JSON-RPC)
    hello            -> 自报 node/plugs/protocol
    task.open{plugId,cwd} -> {streamId}       # 此时 spawn CLI 子进程
  另开一条数据连接：
    首帧 {method:"attach", params:{streamId}} # 这一帧仍带4字节帧头
    ---- 此后这条连接变成【裸字节管道】----
    主控 SDK <-> codebuddy --acp 之间直接跑 NDJSON(JSON-RPC)
    initialize -> session/new -> ...

所以被控端必须实现：控制面(task.open/close/hello/ping) + 数据面(attach 后裸透传)。

## 协议要点（逆向自 harnessd.py，已验证）
- 传输：TCP AF_INET，无 pty/unix socket，故 Windows 可直接实现
- 帧：4 字节大端无符号长度 + UTF-8 JSON（仅控制连接与 attach 首帧使用）
- 单条消息上限 8 MiB
- 首帧 method=="attach" → 数据管道；否则 → 控制连接（首帧需回放）
- read 必须用 read1/os.read，绝不能用 read(n)（会阻塞攒满 n 字节）

用法：
  python <HM_BASE_DIR>/harnessd_win.py [--host 0.0.0.0] [--port 7080]
环境变量：
  ANN_NODE_IP   自报的 ANN 绿模地址（部署时提供,形如 <ANN-NODE-IP>）
"""
import argparse
import json
import os
import platform
import re
import shutil
import socket
import struct
import subprocess
import sys
import threading
import time

# 运行时根目录：plugs.json、logs、默认 cwd、cbcli 都从这里派生。
# 运行目录钉死在单一固定路径时，影子实例(换端口做验证)会把自己的日志写进生产同一份
# harnessd_win.log，排查时两条时间线混在一起；给个 env 覆盖，验证和发布都能用。
DEFAULT_CWD = os.environ.get("HM_BASE_DIR", os.getcwd())  # 缺省=当前运行目录;部署时用 HM_BASE_DIR 指定
PLUGS_FILE = os.path.join(DEFAULT_CWD, "plugs.json")
LOGDIR = os.path.join(DEFAULT_CWD, "logs")

# ---- codebuddy CLI 位置 ----
# HM_NODE / HM_CBJS / HM_NODE_NAME / HM_BASE_DIR 可覆盖；不给就按当前机器发现。
# 原来这里写死了当前机器的用户目录 + 精确版本号 22.22.2-6 + 一台机器的 plugId：
# 换台机器或换个用户，spawn 直接 ENOENT，而 plugs.json 缺省时没人能改源码里的字面量。
def _home():
    return os.environ.get("USERPROFILE") or os.environ.get("HOME") or os.path.expanduser("~")


def _newest_version_dir(root, exe):
    """.workbuddy/binaries/node/versions/<版本>/ 里挑最新的一份。
    版本号按数字比：字典序会把 22.22.2 排在 3.9.1 前面。"""
    try:
        vs = [d for d in os.listdir(root) if os.path.exists(os.path.join(root, d, exe))]
    except OSError:
        return None
    if not vs:
        return None
    vs.sort(key=lambda d: [int(x) for x in re.split(r"[^0-9]+", d) if x])
    return os.path.join(root, vs[-1], exe)


def _find_node():
    return (_newest_version_dir(os.path.join(_home(), ".workbuddy", "binaries", "node", "versions"),
                                "node.exe")
            or shutil.which("node") or "node")


NODE = os.environ.get("HM_NODE") or _find_node()

# 首选：官方独立 CLI（2.168.2，装在运行时根目录的 cbcli 下）。
# 不要用 app.asar 里解出来的旧快照（2.103.3）——它不认识当前的
# account-scoped-external-link 认证类型，AuthenticationManager 会无限重试，
# 导致 session/new 永久挂起（既不返回也不报错）。
CBJS_NEW = os.path.join(DEFAULT_CWD, "cbcli", "node_modules", "@tencent-ai",
                        "codebuddy-code", "dist", "codebuddy.js")
CBJS_OLD = os.path.join(_home(), ".workbuddy", "temp", "app-extracted", "cli", "dist", "codebuddy.js")
CBJS = os.environ.get("HM_CBJS") or next(
    (p for p in (CBJS_NEW, CBJS_OLD) if os.path.exists(p)), CBJS_NEW)

# 桌面端注入的这些变量会让 CLI 走错认证分支 / 连错端点，spawn 时必须剥掉
STRIP_ENV = [
    "ACC_PRODUCT_CONFIG_PATH", "CODEBUDDY_HOST", "CODEBUDDY_MCP_CONFIG",
    "CODEBUDDY_CONFIG_DIR", "WORKBUDDY_CONFIG_DIR",
    "CODEBUDDY_FORCE_LITE_WB_BUNDLE", "CODEBUDDY_FORCE_HEADLESS_BUNDLE",
    "CODEBUDDY_SERVICE_PROXY_URL",
]


def build_clean_env():
    """给子进程一个干净的环境：剥掉桌面注入变量，补上中国版与凭据。"""
    env = {k: v for k, v in os.environ.items() if k not in STRIP_ENV}
    env["CODEBUDDY_INTERNET_ENVIRONMENT"] = "internal"   # 中国版必须
    env["PYTHONIOENCODING"] = "utf-8"
    # 若外部已提供 CODEBUDDY_API_KEY / CODEBUDDY_AUTH_TOKEN，原样继承
    return env

CREATE_NO_WINDOW = 0x08000000
MAX_FRAME = 8 * 1024 * 1024

LOCK = threading.Lock()
STREAMS = {}          # streamId -> {"proc":..., "conn":..., "plug_id":...}
SEQ = {"n": 0}
CTL_CONNS = []        # 活跃控制连接(用于 task.exit 事件回传)

# 默认 plugs：即使 mesh 侧 plugId 与本地不完全一致，也有兜底。
# 节点名按"计算机名+workbuddy"自动取(mesh 侧统一的命名规约)，HM_NODE_NAME 可覆盖；
# 原来这里钉死了由当前这台机器算出来的 plugId，同网段第二台机一起上线就撞名。
NODE_NAME = os.environ.get("HM_NODE_NAME") or f"{os.environ.get('COMPUTERNAME') or platform.node()}-workbuddy"
DEFAULT_PLUGS = [
    {"plugId": NODE_NAME, "name": "workbuddy",
     "command": NODE, "args": [CBJS, "--acp"]},
    {"plugId": "workbuddy", "name": "workbuddy",
     "command": NODE, "args": [CBJS, "--acp"]},
    {"plugId": "wb-adapter", "name": "workbuddy",
     "command": NODE, "args": [CBJS, "--acp"]},
]


def log(msg):
    try:
        os.makedirs(LOGDIR, exist_ok=True)
        with open(os.path.join(LOGDIR, "harnessd_win.log"), "a", encoding="utf-8") as f:
            f.write(f"[{time.strftime('%H:%M:%S')}] {msg}\n")
    except Exception:
        pass
    sys.stderr.write(f"[{time.strftime('%H:%M:%S')}] {msg}\n")
    sys.stderr.flush()


# ---------------- 分帧 ----------------
def _recv_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


def send_frame(sock, obj):
    body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    sock.sendall(struct.pack(">I", len(body)) + body)


def recv_frame(sock):
    header = _recv_exact(sock, 4)
    if header is None:
        return None
    (length,) = struct.unpack(">I", header)
    if length > MAX_FRAME:
        raise ValueError(f"frame too large: {length}")
    body = _recv_exact(sock, length)
    if body is None:
        return None
    return json.loads(body.decode("utf-8"))


# ---------------- plugs ----------------
def load_plugs():
    try:
        with open(PLUGS_FILE, encoding="utf-8") as f:
            data = json.load(f)
        plugs = data.get("plugs", data) if isinstance(data, dict) else data
        if plugs:
            log(f"已从 {PLUGS_FILE} 载入 {len(plugs)} 个 plug")
            return plugs
    except FileNotFoundError:
        pass
    except Exception as e:
        log(f"读取 plugs.json 失败({e})，用内置默认")
    return DEFAULT_PLUGS


def find_plug(plugs, plug_id):
    """按 plugId / id / name / aliases 匹配（多 harness 架构：别名兼容旧 plugId）"""
    for p in plugs:
        ids = [p.get("plugId"), p.get("id"), p.get("name")]
        ids += list(p.get("aliases") or [])
        if plug_id and plug_id in [x for x in ids if x]:
            return p
    return None


# ---------------- 自报 ----------------
def _lan_addr():
    """UDP connect 技巧取本机内网 IPv4(不发包，只让内核挑一条路由)。
    探测目标原来钉死一个具体内网 IP:80——换台没有这个网段的机器，挑不到路由就静默
    变 None，主控按 lan_addr 找节点找不到，现场还没法改。LAN_PROBE_IP/PORT 可指到
    本地可达地址；那条也挑不出来时再兜一发公网 DNS(同样只是挑路由)。"""
    host = os.environ.get("LAN_PROBE_IP", "192.0.2.1")  # 缺省=RFC5737 文档占位地址;部署时用 LAN_PROBE_IP 指到局域网可达地址
    port = int(os.environ.get("LAN_PROBE_PORT", "80"))
    targets = [(host, port)]
    fallback = ("8.8.8.8", 53)
    if fallback not in targets:
        targets.append(fallback)
    for h, p in targets:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect((h, p))
            return s.getsockname()[0]
        except OSError:
            continue
        finally:
            s.close()
    return None


def self_report(plugs):
    ann = os.environ.get("ANN_NODE_IP")
    lan = _lan_addr()
    return {
        "computer_name": platform.node(),
        "os": f"{platform.system()} {platform.release()}",
        "lan_addr": lan,
        "ann_addr": ann,
        "plugs": [p.get("plugId") for p in plugs],
        "harnessd_uptime_s": int(time.time() - START),
    }


# ---------------- 数据管道 ----------------
def kill_tree(proc, why=""):
    """terminate() 在 Windows 上只干掉直接子进程，插头自己起的 CLI/孙进程会留成孤儿
    (2026-10-21 主控审计必修③)。taskkill /T 收整棵树，收不动再退化成 terminate/kill。"""
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


def _pipe(conn, proc, stream_id):
    """attach 之后：裸字节双向透传。"""

    def pump_in():
        try:
            while True:
                chunk = conn.recv(65536)
                if not chunk:
                    break
                proc.stdin.write(chunk)
                proc.stdin.flush()
        except Exception:
            pass
        finally:
            try:
                proc.stdin.close()
            except Exception:
                pass

    def pump_out():
        try:
            while True:
                # read1：有数据立刻返回，绝不能用 read(n)（会阻塞攒满）
                chunk = proc.stdout.read1(65536)
                if not chunk:
                    break
                conn.sendall(chunk)
        except Exception:
            pass
        finally:
            # 先 shutdown 再 close：Windows 下 close() 不会打断另一个线程正卡在 recv 上的
            # pump_in，管道关掉而 pump_in 永远挂着 = conn 悬挂(必修③的另一半)
            try:
                conn.shutdown(socket.SHUT_RD)
            except Exception:
                pass
            try:
                conn.close()
            except Exception:
                pass

    t_in = threading.Thread(target=pump_in, daemon=True)
    t_out = threading.Thread(target=pump_out, daemon=True)
    t_in.start()
    t_out.start()
    t_out.join()
    log(f"数据管道结束 {stream_id}")
    # task.exit 事件回传(DSH 超时清理依赖):通知所有活跃控制连接
    try:
        exit_code = proc.poll()
        notify_task_exit(stream_id, exit_code)
    except Exception as e:
        log(f"task.exit 通知失败: {e}")
    kill_tree(proc, "管道结束")
    with LOCK:
        STREAMS.pop(stream_id, None)


# ---------------- task.open / close ----------------
def task_open(params, plugs):
    plug_id = params.get("plugId")
    cwd = params.get("cwd") or DEFAULT_CWD
    plug = find_plug(plugs, plug_id)
    if plug is not None:
        # 多 harness 架构：命中但未启用 / 未配置时给明确错误（不静默回退）
        if not plug.get("enabled", True):
            return None, f"plug disabled: {plug.get('note') or plug_id}"
        if not plug.get("command"):
            return None, f"plug not configured: {plug.get('note') or plug_id}"
    if not plug:
        # 匹配不到就是匹配不到：静默回退到列表首个 plug 会让主控把别的 harness 的
        # 回复当成目标 harness 的（实测 2026-10-21 00:05 探测 qoder-exec 拿到
        # workbuddy 的 49 模型表），多 harness 网格里这个错会一路传到结论里
        return None, f"unknown plugId: {plug_id}"

    cmd = plug.get("command")
    args = plug.get("args", [])
    if not os.path.isdir(cwd):
        cwd = DEFAULT_CWD

    # CLI 内部会起辅助服务，端口撞到桌面占用的 11613 会 EADDRINUSE，这里动态挑一个空闲端口
    with socket.socket() as _s:
        _s.bind(("127.0.0.1", 0))
        free_port = _s.getsockname()[1]

    try:
        # kimi 等原生 ACP CLI 不认识 --port,插头用 no_auto_port 声明不追加
        extra = [] if plug.get("no_auto_port") else ["--port", str(free_port)]
        # plug.env 后放：插头自己声明的变量应当覆盖守护进程的继承环境（此前被完全忽略，
        # 导致 plugs.json 的 env 段形同注释，调参只能改适配器代码重启）
        proc = subprocess.Popen(
            [cmd] + list(args) + extra,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            cwd=cwd, env={**build_clean_env(), **(plug.get("env") or {})},
            creationflags=CREATE_NO_WINDOW,
        )
    except Exception as e:
        log(f"spawn 失败: {e}")
        return None, str(e)

    with LOCK:
        SEQ["n"] += 1
        stream_id = f"s-{SEQ['n']:04d}"
        STREAMS[stream_id] = {"proc": proc, "conn": None, "plug_id": plug_id}

    # stderr 落盘，不干扰协议流
    os.makedirs(LOGDIR, exist_ok=True)
    errf = open(os.path.join(LOGDIR, f"plug-{proc.pid}.err.log"), "ab", buffering=0)
    threading.Thread(target=lambda: [errf.write(c) for c in iter(lambda: proc.stderr.read1(4096), b"")],
                     daemon=True).start()

    log(f"task.open plugId={plug_id} cwd={cwd} -> {stream_id} pid={proc.pid}")
    return {"streamId": stream_id}, None


def notify_task_exit(stream_id, exit_code):
    """向所有活跃控制连接广播 task.exit 事件(死因回传,主控超时清理依赖)
    格式: {"jsonrpc":"2.0","method":"task.exit","params":{"streamId","exitCode","reason","ts"}}"""
    msg = {"jsonrpc": "2.0", "method": "task.exit",
           "params": {"streamId": stream_id,
                      "exitCode": exit_code,
                      "reason": "pipe_closed",
                      "ts": int(time.time() * 1000)}}
    with LOCK:
        conns = list(CTL_CONNS)
    for c in conns:
        try:
            send_frame(c, msg)
            log(f"task.exit 已回传 {stream_id} exitCode={exit_code}")
        except Exception as e:
            log(f"task.exit 回传失败({stream_id}): {e}")


def task_close(params):
    sid = params.get("streamId")
    with LOCK:
        st = STREAMS.pop(sid, None)
    if not st:
        return {"ok": False}
    try:
        kill_tree(st["proc"], f"task.close {sid}")
    except Exception:
        pass
    try:
        if st.get("conn"):
            st["conn"].close()
    except Exception:
        pass
    log(f"task.close {sid}")
    return {"ok": True}


# ---------------- 控制连接 ----------------
def control_loop(conn, addr, first, plugs):
    with LOCK:
        CTL_CONNS.append(conn)

    def dispatch(msg):
        method = msg.get("method")
        rid = msg.get("id")
        params = msg.get("params") or {}
        if method == "hello":
            return {"node": self_report(plugs), "plugs": plugs, "protocol": "plug/1"}
        if method == "ping":
            return "pong"
        if method == "plug.list":
            return {"plugs": plugs}
        if method == "plug.reload":
            return {"plugs": load_plugs()}
        if method == "task.open":
            res, err = task_open(params, plugs)
            if err:
                return {"error": err}
            return res
        if method == "task.close":
            return task_close(params)
        return None

    try:
        msg = first
        while True:
            if msg is None:
                return
            if "method" in msg and "id" in msg:
                try:
                    res = dispatch(msg)
                    if res is None:
                        send_frame(conn, {"jsonrpc": "2.0", "id": msg.get("id"),
                                          "error": {"code": -32601,
                                                    "message": f"unknown method {msg.get('method')}"}})
                    else:
                        send_frame(conn, {"jsonrpc": "2.0", "id": msg.get("id"), "result": res})
                except Exception as e:
                    log(f"dispatch 异常: {e}")
                    try:
                        send_frame(conn, {"jsonrpc": "2.0", "id": msg.get("id"),
                                          "error": {"code": -32000, "message": str(e)}})
                    except Exception:
                        return
            msg = recv_frame(conn)
    except Exception as e:
        log(f"控制连接结束 {addr}: {e}")
    finally:
        with LOCK:
            try:
                CTL_CONNS.remove(conn)
            except ValueError:
                pass
        try:
            conn.close()
        except Exception:
            pass


def peel(conn, addr, plugs):
    try:
        conn.settimeout(30)
        first = recv_frame(conn)
    except Exception as e:
        log(f"peel error {addr}: {e}")
        conn.close()
        return
    if first is None:
        conn.close()
        return
    if first.get("method") == "attach":
        conn.settimeout(None)
        stream_id = (first.get("params") or {}).get("streamId")
        with LOCK:
            st = STREAMS.get(stream_id)
        if not st:
            log(f"attach 未知 stream {stream_id}（可能已关闭或 task.open 未完成）")
            conn.close()
            return
        st["conn"] = conn
        log(f"attach {stream_id} from {addr[0]}:{addr[1]} pid={st['proc'].pid}")
        _pipe(conn, st["proc"], stream_id)
        return
    conn.settimeout(None)
    control_loop(conn, addr, first, plugs)


def main():
    global START
    START = time.time()
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=7080)
    args = ap.parse_args()

    plugs = load_plugs()
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((args.host, args.port))
    srv.listen(32)
    log(f"harnessd(win) 就绪 {args.host}:{args.port}  plugs={[p.get('plugId') for p in plugs]}")
    log(f"ANN_NODE_IP={os.environ.get('ANN_NODE_IP')}")

    while True:
        try:
            conn, addr = srv.accept()
        except Exception as e:
            log(f"accept 失败: {e}")
            time.sleep(1)
            continue
        threading.Thread(target=peel, args=(conn, addr, plugs), daemon=True).start()


if __name__ == "__main__":
    main()
