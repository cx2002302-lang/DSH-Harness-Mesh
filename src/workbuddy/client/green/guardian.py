#!/usr/bin/env python3
"""guardian — Windows/被控机绿模看护进程(无服务、无 admin、拷贝即用)。

职责:
  1. 首次运行(无 ann-data/agent.json):自动执行 bootstrap 入网,
     看到 "Tailnet IP" 后自动收尾,进入常驻看护——一次双击全搞定。
  2. 常驻看护两个子进程,崩溃自动拉回(退避 1→60s):
     - ann-agent(.exe) run      :tailnet 数据面 + --forward 7080→127.0.0.1:7080
     - harnessd.py              :插头协议服务端(监听 127.0.0.1:7080)
  3. Ctrl+C 全停;进程日志在本目录 guardian.log。

现状(2026-10-21):日常看护已交给 keepalive.py(计划任务每 1 分钟,只管 ann-agent +
mesh-guardian)。本脚本不在计划任务/启动项里,也不再由任何组件拉起,只保留
"新节点首次入网 bootstrap" 这条用途 —— 别和 keepalive.py 同时跑,两边会互相杀。

用法:  python guardian.py        (Windows 可双击;建议加 shell:startup 开机自启)
"""
import ctypes
import os
import socket
import subprocess
import sys
import threading
import time

# Windows 无窗口化:子进程(ann-agent/harnessd)绝不弹控制台窗口
NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0  # CREATE_NO_WINDOW

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT_DIR = os.path.join(HERE, "ann-data")
AGENT_BIN = "ann-agent.exe" if os.name == "nt" else "./ann-agent"
PYTHON = sys.executable

# bootstrap 静默时的最长等待(原版硬编码 90s 且等不到也不放手,见 ensure_joined)
BOOTSTRAP_WAIT = float(os.environ.get("GUARDIAN_BOOTSTRAP_WAIT", "90"))
MUTEX_NAME = "Global\\wb_mesh_guardian_v1"
ERROR_ALREADY_EXISTS = 183

CHILDREN = [
    # (名字, 命令, 环境)
    ("ann-agent", [AGENT_BIN, "run"], {"ANN_AGENT_DATA_DIR": AGENT_DIR}),
    ("harnessd", [PYTHON, os.path.join(HERE, "harnessd.py"),
                  "--host", "127.0.0.1", "--port", "7080",
                  "--plugs", os.path.join(HERE, "plugs.json")], {}),
]

# 首次入网参数:优先读同目录 bootstrap.env(新节点接入时按节点填写),无则读环境变量。
# 入网码/服务器不再写死在源码里(码 24h 有效、3 次额度,进了 git 就等于公开)。
# bootstrap.env 示例:
#   CODE=xxxxxxxx
#   HOSTNAME=MY-PC
#   TAGS=tag:agent
#   FORWARD=7080=127.0.0.1:7080
DEFAULTS = {
    "CODE": os.environ.get("ANN_BOOTSTRAP_CODE", ""),
    "HOSTNAME": os.environ.get("COMPUTERNAME") or socket.gethostname(),
    "TAGS": "tag:agent",
    "FORWARD": "7080=127.0.0.1:7080",
    "SERVER": os.environ.get("ANN_BOOTSTRAP_SERVER", ""),
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


def ensure_joined():
    """无 agent.json 时自动 bootstrap:等到 Tailnet IP 出现即收尾(然后由 run 模式接管)。"""
    if os.path.exists(os.path.join(AGENT_DIR, "agent.json")):
        return True
    cfg = load_bootstrap_env()
    if not cfg.get("CODE") or not cfg.get("SERVER"):
        log("入网失败:缺 CODE / SERVER —— 在 bootstrap.env 里填,或设环境变量 "
            "ANN_BOOTSTRAP_CODE、ANN_BOOTSTRAP_SERVER")
        return False
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
    lines = []
    stop_pump = threading.Event()

    def pump():
        # bootstrap 一个字不吐时,readline 会一直阻塞:必须放线程里,主线程只等到 deadline
        try:
            for raw in iter(proc.stdout.readline, b""):
                if stop_pump.is_set():
                    return
                lines.append(raw.decode("utf-8", errors="replace").rstrip())
        except Exception:
            pass

    t = threading.Thread(target=pump, daemon=True)
    t.start()
    deadline = time.time() + BOOTSTRAP_WAIT
    seen = 0
    try:
        while time.time() < deadline and not joined:
            while seen < len(lines):
                line = lines[seen]
                seen += 1
                if line:
                    log("bootstrap| " + line[:160])
                if "Tailnet IP" in line:
                    joined = True
                    break
            if joined:
                break
            time.sleep(0.2)
        if not joined:
            log(f"bootstrap {BOOTSTRAP_WAIT:.0f}s 内没等到 Tailnet IP(已读到 {seen} 行),放手")
        stop_pump.set()
    finally:
        kill_tree(proc, "bootstrap 收尾")
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


def kill_tree(proc, why=""):
    """收树终止。裸 terminate()=TerminateProcess,只杀父,ann-agent/harnessd 的子进程留孤儿。"""
    if proc is None or getattr(proc, "pid", None) is None:
        return
    if proc.poll() is not None:
        return
    if os.name == "nt":
        try:
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                           capture_output=True, creationflags=NO_WINDOW, timeout=15)
        except Exception as e:
            log(f"taskkill pid={proc.pid} 失败({why}): {e}")
    try:
        proc.terminate()
        proc.wait(timeout=5)
    except Exception:
        try:
            proc.kill()
            proc.wait(timeout=5)
        except Exception:
            pass


def acquire_singleton_lock():
    """命名 Mutex 单例锁。返回句柄(保住别释放)或 None(已有一个 guardian 在跑)。

    没有这把锁,"开机触发 + 手动双击"就会跑出两份 guardian:两份各拉一个 ann-agent
    抢同一个 ann-data/同一条隧道,再被 keepalive.py 的"重复则杀多余"轮流回收。
    """
    if os.name != "nt":
        return object()
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateMutexW.restype = ctypes.c_void_p
    k32.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p]
    handle = k32.CreateMutexW(None, False, MUTEX_NAME)
    err = ctypes.get_last_error()
    if err == ERROR_ALREADY_EXISTS:
        return None
    if not handle:
        # Global\ 命名空间要 SeCreateGlobalPrivilege,拿不到时退回本机 Local\
        handle = k32.CreateMutexW(None, False, "Local\\wb_mesh_guardian_v1")
        if ctypes.get_last_error() == ERROR_ALREADY_EXISTS:
            return None
        log(f"[警告] 单例锁创建失败(err={err}),本次尽力而为")
    return handle


def main():
    singleton = acquire_singleton_lock()
    if singleton is None:
        log(f"已有一个 guardian 在跑(锁 {MUTEX_NAME} 已存在),本次退出,不重复拉起")
        sys.exit(0)
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
            kill_tree(p, f"Ctrl+C {name}")


if __name__ == "__main__":
    main()
