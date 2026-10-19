#!/usr/bin/env python3
"""guardian — Windows/被控机绿模看护进程(无服务、无 admin、拷贝即用)。

职责:
  1. 首次运行(无 ann-data/agent.json):自动执行 bootstrap 入网,
     看到 "Tailnet IP" 后自动收尾,进入常驻看护——一次双击全搞定。
  2. 常驻看护两个子进程,崩溃自动拉回(退避 1→60s):
     - ann-agent(.exe) run      :tailnet 数据面 + --forward 7080→127.0.0.1:7080
     - harnessd.py              :插头协议服务端(监听 127.0.0.1:7080)
  3. Ctrl+C 全停;进程日志在本目录 guardian.log。

用法:  python guardian.py        (Windows 可双击;建议加 shell:startup 开机自启)
"""
import os
import socket
import subprocess
import sys
import time

# Windows 无窗口化:子进程(ann-agent/harnessd)绝不弹控制台窗口
NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0  # CREATE_NO_WINDOW

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT_DIR = os.path.join(HERE, "ann-data")
AGENT_BIN = "ann-agent.exe" if os.name == "nt" else "./ann-agent"
PYTHON = sys.executable

CHILDREN = [
    # (名字, 命令, 环境)
    ("ann-agent", [AGENT_BIN, "run"], {"ANN_AGENT_DATA_DIR": AGENT_DIR}),
    ("harnessd", [PYTHON, os.path.join(HERE, "harnessd.py"),
                  "--host", "127.0.0.1", "--port", "7080",
                  "--plugs", os.path.join(HERE, "plugs.json")], {}),
]

# 首次入网参数:优先读同目录 bootstrap.env(新节点接入时按节点填写),无则用内置默认
# bootstrap.env 示例:
#   CODE=xxxxxxxx
#   HOSTNAME=MY-PC
#   TAGS=tag:agent
#   FORWARD=7080=127.0.0.1:7080
DEFAULTS = {
    "CODE": "8abc4194",
    "HOSTNAME": os.environ.get("COMPUTERNAME") or __import__("socket").gethostname(),
    "TAGS": "tag:agent",
    "FORWARD": "7080=127.0.0.1:7080",
    "SERVER": os.environ.get("MESH_SERVER", "http://127.0.0.1:8444"),
}


def load_bootstrap_env():
    cfg = dict(DEFAULTS)
    env_file = os.path.join(HERE, "bootstrap.env")
    if os.path.exists(env_file):
        for line in open(env_file, encoding="utf-8"):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                cfg[k.strip().upper()] = v.strip()
    return cfg


BOOTSTRAP_ARGS = None  # ensure_joined 时按 load_bootstrap_env() 组装


def ensure_joined():
    """无 agent.json 时自动 bootstrap:等到 Tailnet IP 出现即收尾(然后由 run 模式接管)。"""
    if os.path.exists(os.path.join(AGENT_DIR, "agent.json")):
        return True
    cfg = load_bootstrap_env()
    args = [AGENT_BIN, "bootstrap",
            "--server=" + cfg["SERVER"],
            "--code=" + cfg["CODE"],
            "--hostname=" + cfg["HOSTNAME"],
            "--forward", cfg["FORWARD"]]
    if cfg.get("TAGS"):
        args += ["--advertise-tags", cfg["TAGS"]]
    log("首次运行:自动 bootstrap 入网(host=%s tags=%s)..." % (cfg["HOSTNAME"], cfg.get("TAGS")))
    env = {**os.environ, "ANN_AGENT_DATA_DIR": AGENT_DIR}
    proc = subprocess.Popen(args, cwd=HERE, env=env, creationflags=NO_WINDOW,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    joined = False
    deadline = time.time() + 90
    buf = b""
    try:
        while time.time() < deadline:
            chunk = proc.stdout.read(4096)
            if not chunk:
                break
            buf += chunk
            while b"\n" in buf:
                raw, _, buf = buf.partition(b"\n")
                line = raw.decode("utf-8", errors="replace").rstrip()
                if line:
                    log("bootstrap| " + line[:160])
                if "Tailnet IP" in line:
                    joined = True
                    break
            if joined:
                break
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
    if joined and os.path.exists(os.path.join(AGENT_DIR, "agent.json")):
        log("入网成功,配置已保存,进入常驻看护")
        return True
    log("入网失败:请检查网络/入网码(码 24h 有效、3 次额度),或手动运行 ann-agent.exe bootstrap")
    return False

BACKOFF = [1, 2, 5, 10, 30, 60]


def log(msg):
    line = f"[guardian {time.strftime('%H:%M:%S')}] {msg}"
    # pythonw(无窗口)运行下 sys.stdout 是 None:只写日志文件,不 print,绝不弹窗
    if sys.stdout is not None:
        try:
            print(line, flush=True)
        except UnicodeEncodeError:
            print(line.encode("ascii", errors="replace").decode("ascii"), flush=True)
        except Exception:
            pass
    try:
        with open(os.path.join(HERE, "guardian.log"), "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def spawn(cmd, extra_env):
    env = {**os.environ, **extra_env}
    return subprocess.Popen(cmd, cwd=HERE, env=env, creationflags=NO_WINDOW)


def port_in_use(host, port, timeout=1.0):
    """检测端口是否已有进程监听(用于避免重复拉起同端口的 harnessd)"""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(timeout)
            return s.connect_ex((host, port)) == 0
    except Exception:
        return False


class _ExternalProc:
    """占位:表示该子进程由外部提供(如 harnessd_win 已占 7080)"""
    returncode = None

    def poll(self):
        return None


def main():
    if not ensure_joined():
        sys.exit(1)
    log(f"guardian 启动 pid={os.getpid()} dir={HERE}")
    procs = {}
    fails = {name: 0 for name, _, _ in CHILDREN}
    try:
        while True:
            for name, cmd, env in CHILDREN:
                p = procs.get(name)
                if p is None or p.poll() is not None:
                    # harnessd 端口已被外部进程(harnessd_win)占用时,不再重复拉起,
                    # 避免"每 6 秒 spawn 一次→端口冲突退出 code=1"的空转循环
                    if name == "harnessd" and port_in_use("127.0.0.1", 7080):
                        if p is None:
                            log("harnessd: 7080 已被外部进程占用 → 跳过托管(使用外部实例)")
                            procs[name] = _ExternalProc()
                        continue
                    if p is not None:
                        log(f"{name} 退出(code={p.returncode}),{BACKOFF[min(fails[name], len(BACKOFF)-1)]}s 后拉回")
                        time.sleep(BACKOFF[min(fails[name], len(BACKOFF) - 1)])
                        fails[name] += 1
                    else:
                        log(f"启动 {name}: {' '.join(cmd)}")
                    procs[name] = spawn(cmd, env)
                    if fails[name] == 0 or p is None:
                        pass
            # 有任一成功跑过 60s,退避计数清零
            for name, p in procs.items():
                if p.poll() is None and fails[name] > 0:
                    fails[name] = max(0, fails[name] - 1)
            time.sleep(5)
    except KeyboardInterrupt:
        log("Ctrl+C,停止所有子进程")
        for name, p in procs.items():
            try:
                p.terminate()
            except Exception:
                pass
        time.sleep(1)
        for name, p in procs.items():
            try:
                p.kill()
            except Exception:
                pass


if __name__ == "__main__":
    main()
