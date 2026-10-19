#!/usr/bin/env python3
"""harnessd — Harness Mesh 插头协议服务端(被控机侧)。

角色:每台被控机跑一个 harnessd,把本机的 harness(插头)暴露给主控。
  - 控制连接:JSON-RPC(长度分帧),常驻——hello/plug.list/ping/task.open/task.close
  - 数据连接:按需新建,attach 到 streamId 后变成原始字节管道
    (ACP 的 NDJSON 端到端跑在主控 SDK 与被控 CLI 之间,harnessd 不懂 ACP)

典型部署(绿模,Windows/被控机):
  ann-agent.exe run --forward 7080=127.0.0.1:7080   # tailnet:7080 → 本机
  python harnessd.py --host 127.0.0.1 --port 7080 --plugs plugs.json
  python guardian.py                                  # 看护上面两个进程

配置 plugs.json:
  [{"plugId": "workbuddy", "kind": "acp", "command": "codebuddy", "args": ["--acp"], "cwd": null, "model": null}]

自报(D-q):hello 响应带 computer_name/os/lan_addr/plugs,主控自动登记员工档案;
  ann_addr 优先取环境变量 ANN_NODE_IP(由 guardian/agent 注入),否则 null。
"""
import argparse
import json
import os
import platform
import signal
import socket
import struct
import subprocess
import sys
import threading
import time

LOCK = threading.Lock()
STREAMS = {}          # streamId -> {"proc": Popen, "conn": socket|None, "plug": dict}
STREAM_SEQ = [0]
PLUGS = []            # [{plugId, kind, command, args, cwd, model}]
PLUGS_PATH = None     # plugs.json 路径(plug.reload 用)
CONTROLS = []         # 活跃的控制连接(task.exit 通知用)
CONTROLS_LOCK = threading.Lock()
STARTED_AT = time.time()


def log(msg):
    sys.stderr.write(f"[harnessd] {msg}\n")
    sys.stderr.flush()


# ---------- 帧:4 字节大端长度 + UTF-8 JSON ----------

def send_frame(sock, obj):
    body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    sock.sendall(struct.pack(">I", len(body)) + body)


def recv_frame(sock):
    header = _recv_exact(sock, 4)
    if header is None:
        return None
    (length,) = struct.unpack(">I", header)
    if length > 8 * 1024 * 1024:
        raise ValueError(f"frame too large: {length}")
    body = _recv_exact(sock, length)
    if body is None:
        return None
    return json.loads(body.decode("utf-8"))


def _recv_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


# ---------- 自报与插头清单 ----------

def lan_addr():
    """经 UDP connect 技巧取本机内网 IPv4(不真发包)。"""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("<ANN_SERVER>", 8443))
            return s.getsockname()[0]
    except OSError:
        return None


def self_report():
    return {
        "computer_name": platform.node() or socket.gethostname(),
        "os": f"{platform.system()} {platform.release()}",
        "lan_addr": lan_addr(),
        "ann_addr": os.environ.get("ANN_NODE_IP") or None,
        "plugs": [p["plugId"] for p in PLUGS],
        "harnessd_uptime_s": int(time.time() - STARTED_AT),
    }


def find_plug(plug_id):
    for p in PLUGS:
        if p["plugId"] == plug_id:
            return p
    return None


# ---------- 任务流管理 ----------


def task_open(params):
    plug = find_plug(params.get("plugId") or "")
    if not plug:
        raise ValueError(f"plug not found: {params.get('plugId')}")
    with LOCK:
        STREAM_SEQ[0] += 1
        stream_id = f"s-{STREAM_SEQ[0]:04d}"
    cwd = params.get("cwd") or plug.get("cwd") or None
    cmd = [plug["command"], *plug.get("args", [])]
    proc = subprocess.Popen(
        cmd, cwd=cwd,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env={**os.environ, **(plug.get("env") or {})},
    )
    stderr_buf = bytearray()
    stderr_lock = threading.Lock()

    def pump_stderr():
        try:
            while True:
                chunk = proc.stderr.read1(4096)
                if not chunk:
                    break
                with stderr_lock:
                    stderr_buf.extend(chunk)
                    del stderr_buf[:-2000]
        except Exception:
            pass

    threading.Thread(target=pump_stderr, daemon=True).start()

    def exit_waiter():
        code = proc.wait()
        elapsed = time.time() - st["opened"]
        with stderr_lock:
            tail = bytes(stderr_buf[-2000:]).decode("utf-8", errors="replace")
        log(f"stream {stream_id} proc exited code={code} after {elapsed:.1f}s stderr={tail[:200]!r}")
        # 早退(60s 内)就把死因推给主控(远程排错关键通道)
        if elapsed < 60:
            notify_controls({
                "method": "task.exit",
                "params": {"streamId": stream_id, "plugId": plug["plugId"],
                           "code": code, "elapsed_ms": int(elapsed * 1000), "stderr": tail},
            })

    st = {"proc": proc, "conn": None, "plug": plug, "opened": time.time()}
    with LOCK:
        STREAMS[stream_id] = st
    threading.Thread(target=exit_waiter, daemon=True).start()
    log(f"task.open {stream_id} plug={plug['plugId']} pid={proc.pid} cmd={' '.join(cmd)}")
    return {"streamId": stream_id}


def task_close(stream_id):
    with LOCK:
        st = STREAMS.pop(stream_id, None)
    if not st:
        return
    proc = st["proc"]
    try:
        proc.terminate()
    except Exception:
        pass
    conn = st.get("conn")
    if conn:
        try:
            conn.close()
        except Exception:
            pass
    log(f"task.close {stream_id}")


def reload_plugs():
    """热重载 plugs 文件,返回插头名列表。"""
    global PLUGS
    with open(PLUGS_PATH, "r", encoding="utf-8") as f:
        PLUGS = json.load(f)
    names = [x["plugId"] for x in PLUGS]
    log(f"plug.reload -> {names}")
    return names


def notify_controls(obj):
    """向所有活跃控制连接推送通知(如 task.exit 远程死因)。"""
    with CONTROLS_LOCK:
        conns = list(CONTROLS)
    for c in conns:
        try:
            send_frame(c, obj)
        except Exception:
            pass


def watch_procs():
    """进程退出即清 stream 表(防泄漏)。"""
    while True:
        time.sleep(5)
        with LOCK:
            for sid in list(STREAMS):
                proc = STREAMS[sid]["proc"]
                if proc.poll() is not None:
                    log(f"stream {sid} proc exited code={proc.returncode}")
                    conn = STREAMS[sid].get("conn")
                    if conn:
                        try:
                            conn.close()
                        except Exception:
                            pass
                    del STREAMS[sid]


def serve(host, port):
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((host, port))
    srv.listen(16)
    log(f"listening on {host}:{port} plugs={[p['plugId'] for p in PLUGS]}")
    threading.Thread(target=watch_procs, daemon=True).start()
    while True:
        conn, addr = srv.accept()
        # 控制/数据连接的区分:数据连接首帧是 attach——但要在读首帧后才知道。
        # 策略:都按"先读一帧"处理;control handler 循环读帧,data handler 读首帧即 attach。
        # 简化:新起一个 peel 线程读首帧,据此分流。
        threading.Thread(target=peel, args=(conn, addr), daemon=True).start()


def peel(conn, addr):
    """读首帧分流:attach → 数据管道;其余 → 控制连接(首帧已消费,需回放)。"""
    try:
        conn.settimeout(30)
        first = recv_frame(conn)
    except Exception as error:
        log(f"peel error from {addr}: {error}")
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
            log(f"attach unknown stream {stream_id}")
            conn.close()
            return
        st["conn"] = conn
        proc = st["proc"]
        log(f"attach {stream_id} from {addr[0]}:{addr[1]} pid={proc.pid}")
        _pipe(conn, proc, stream_id)
        return
    # 控制连接:首帧已读出,交给控制循环前先处理这一帧
    conn.settimeout(None)
    threading.Thread(target=control_loop, args=(conn, addr, first), daemon=True).start()


def control_loop(conn, addr, first):
    peer = f"{addr[0]}:{addr[1]}"
    log(f"control conn from {peer}")
    with CONTROLS_LOCK:
        CONTROLS.append(conn)
    try:
        msg = first
        while True:
            method = msg.get("method")
            params = msg.get("params") or {}
            rid = msg.get("id")
            if method == "hello":
                send_frame(conn, {"jsonrpc": "2.0", "id": rid, "result": {
                    "node": self_report(), "plugs": PLUGS, "protocol": "plug/1"}})
            elif method == "plug.list":
                send_frame(conn, {"jsonrpc": "2.0", "id": rid, "result": {"plugs": PLUGS}})
            elif method == "ping":
                send_frame(conn, {"jsonrpc": "2.0", "id": rid, "result": "pong"})
            elif method == "plug.reload":
                # 热重载 plugs 文件(改配置后不用重启 harnessd)
                try:
                    names = reload_plugs()
                    send_frame(conn, {"jsonrpc": "2.0", "id": rid, "result": {"plugs": names}})
                except Exception as error:
                    send_frame(conn, {"jsonrpc": "2.0", "id": rid, "error": {"code": -32000, "message": str(error)}})
            elif method == "task.open":
                try:
                    result = task_open(params)
                    send_frame(conn, {"jsonrpc": "2.0", "id": rid, "result": result})
                except Exception as error:
                    send_frame(conn, {"jsonrpc": "2.0", "id": rid,
                                      "error": {"code": -32000, "message": str(error)}})
            elif method == "task.close":
                task_close(params.get("streamId"))
                send_frame(conn, {"jsonrpc": "2.0", "id": rid, "result": {"ok": True}})
            elif rid is not None:
                send_frame(conn, {"jsonrpc": "2.0", "id": rid,
                                  "error": {"code": -32601, "message": f"method not found: {method}"}})
            msg = recv_frame(conn)
            if msg is None:
                break
    except Exception as error:
        log(f"control conn {peer} error: {error}")
    finally:
        with CONTROLS_LOCK:
            if conn in CONTROLS:
                CONTROLS.remove(conn)
        conn.close()
        log(f"control conn {peer} closed")


def _pipe(conn, proc, stream_id):
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
                # read1:最多一次底层读,有数据即返回——交互式 NDJSON 不能用 read(n)(会阻塞攒满 n 字节)
                chunk = proc.stdout.read1(65536)
                if not chunk:
                    break
                conn.sendall(chunk)
        except Exception:
            pass
        finally:
            try:
                conn.close()
            except Exception:
                pass

    t_in = threading.Thread(target=pump_in, daemon=True)
    t_out = threading.Thread(target=pump_out, daemon=True)
    t_in.start()
    t_out.start()
    t_in.join()
    t_out.join()
    with LOCK:
        STREAMS.pop(stream_id, None)
    log(f"stream {stream_id} pipe finished")


def main():
    parser = argparse.ArgumentParser(description="harness-mesh plug server (被控机侧)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=7080)
    parser.add_argument("--plugs", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "plugs.json"))
    args = parser.parse_args()

    global PLUGS, PLUGS_PATH
    PLUGS_PATH = args.plugs
    with open(args.plugs, "r", encoding="utf-8") as f:
        PLUGS = json.load(f)

    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    signal.signal(signal.SIGINT, lambda *_: sys.exit(0))
    serve(args.host, args.port)


if __name__ == "__main__":
    main()
