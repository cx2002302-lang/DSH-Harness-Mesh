#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""keepalive.py v3 — WinPC 值守统一保活（单实例锁 + 查不清就不动）

设计目标（可持续、免人工维护）：
  - 唯一保活入口：计划任务 harness-mesh-keepalive（登录触发 + 每 1 分钟）。
    任务侧 MultipleInstances=IgnoreNew 只挡"这个任务自己"的重叠，手工或别处
    拉起的那一份靠下面的命名 Mutex 挡。
  - 只做"缺失则拉起、重复则收敛"，已在跑的正常实例一律不碰（幂等，可安全重复执行）
  - 查不动 ≠ 没在跑：进程快照查询失败的那一轮，一个都不拉、一个都不杀，只留跳过原因
  - 管理范围：ann-agent（隧道）、mesh-guardian（哨兵）
    · harnessd_win(7080) 由 start-all.py 看护，此处不重复管
    · guardian.py 只做新节点首次入网的一次性脚本，不在自启链路上
  - 全程 CREATE_NO_WINDOW（pythonw 下不弹窗）

路径/解释器都可用 env 覆盖（发布件不该把机器名和精确版本路径钉死在源码里）：
  KA_PYW  KA_BASE_DIR  KA_ANN_AGENT  KA_MESH_SCRIPT  KA_KEEPALIVE_LOG
  KA_ANN_DATA_DIR  KA_MUTEX_NAME
"""
import ctypes
import glob
import os
import re
import subprocess
import sys
import time
from datetime import datetime


def _default_base():
    """被管的东西在仓库目录里；没有 mesh-guardian.py 的运行时副本目录一律视为非仓库目录。
    发布版:字面量已移除,路径由 KA_BASE_DIR 指定,缺省按"和脚本同目录"处理。"""
    here = os.path.dirname(os.path.abspath(__file__))
    return here  # KA_BASE_DIR 可覆盖;缺省=脚本同目录(发布版不再回退硬编码路径)


BASE_DIR = os.environ.get("KA_BASE_DIR") or _default_base()
ANN = os.environ.get("KA_ANN_AGENT") or os.path.join(BASE_DIR, "ann-agent.exe")
MESH_SCRIPT = os.environ.get("KA_MESH_SCRIPT") or os.path.join(BASE_DIR, "mesh-guardian.py")
LOG = os.environ.get("KA_KEEPALIVE_LOG") or os.path.join(BASE_DIR, "keepalive.log")
ANN_DATA_DIR = os.environ.get("KA_ANN_DATA_DIR") or os.path.join(BASE_DIR, "ann-data")
MUTEX_NAME = os.environ.get("KA_MUTEX_NAME") or "wb_mesh_keepalive_v2"
MANAGED_NAMES = tuple(sorted({"ann-agent.exe", "pythonw.exe", "python.exe",
                              os.path.basename(sys.executable).lower()}))
CREATE_NO_WINDOW = 0x08000000
TASKLIST_TIMEOUT = 20
CIM_TIMEOUT = 25
ERROR_ALREADY_EXISTS = 183


def log(msg):
    line = f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


# ---------- 单实例锁 ----------
_k32 = ctypes.WinDLL("kernel32", use_last_error=True)
# 不声明 restype 的话 64 位句柄会被当 int32 截断
_k32.CreateMutexW.restype = ctypes.c_void_p
_k32.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p]


def acquire_singleton_lock():
    """返回 (要不要继续, 备注)。三种结局：拿到锁 / 别人拿着(退) / 锁没建成(响一声再照跑)。

    锁没建成不退出：Global\\ 要"创建全局对象"权限，受限令牌可能吃 ERROR_ACCESS_DENIED，
    而且任务计划器以外没人保证只有一个入口。退回去 = 这台机器彻底没保活；
    照跑 = 最多两个实例同时巡检，代价远小，但必须留一行日志说明它没在保护。
    """
    problems = []
    for prefix in ("Global\\", "Local\\"):
        name = prefix + MUTEX_NAME
        h = _k32.CreateMutexW(None, False, name)
        err = ctypes.get_last_error()
        if h is None:
            problems.append(f"{name} err={err}")
            continue
        if err == ERROR_ALREADY_EXISTS:
            _k32.CloseHandle(ctypes.c_void_p(h))
            return False, name
        return True, ""
    return True, "单实例锁没建成(%s)，本轮不加锁照跑" % "; ".join(problems)


_LOCK_OK, _LOCK_NOTE = acquire_singleton_lock()
if not _LOCK_OK:
    sys.exit(0)


def find_pythonw():
    """值守要拉的是无窗解释器，但版本目录不该钉死在源码里。env → 自己 → 同目录 → 逐新扫。"""
    env = os.environ.get("KA_PYW")
    if env:
        return env
    exe = sys.executable
    if os.path.basename(exe).lower() == "pythonw.exe":
        return exe
    sibling = os.path.join(os.path.dirname(exe), "pythonw.exe")
    if os.path.exists(sibling):
        return sibling
    home = os.environ.get("USERPROFILE") or os.path.expanduser("~")
    cands = glob.glob(os.path.join(
        home, ".workbuddy", "binaries", "python", "versions", "*", "pythonw.exe"))
    # 版本号按数字比：字典序会把 3.13.12 排在 3.9.1 前面，挑中更旧的那份
    cands.sort(key=lambda p: tuple(int(x) for x in re.split(r"[^0-9]+", os.path.basename(os.path.dirname(p))) if x))
    return cands[-1] if cands else exe


PYW = find_pythonw()


def pids_by_name(name):
    """按映像名查 PID 列表（tasklist，GBK 解码）。查不动返回 None，不是空表。"""
    try:
        r = subprocess.run(["tasklist", "/FI", f"IMAGENAME eq {name}", "/FO", "CSV", "/NH"],
                           capture_output=True, text=True, encoding="gbk", errors="replace",
                           timeout=TASKLIST_TIMEOUT, creationflags=CREATE_NO_WINDOW)
    except Exception as e:
        log(f"tasklist 失败({name}): {e}")
        return None
    if r.returncode != 0:
        log(f"tasklist 返回码 {r.returncode}({name})")
        return None
    pids = []
    for line in (r.stdout or "").splitlines():
        parts = line.split(",")
        if len(parts) >= 2 and parts[0].strip('"').lower() == name.lower():
            pid = parts[1].strip('"')
            if pid.isdigit():
                pids.append(int(pid))
    return pids


_PS_SNIPPET = """
$ErrorActionPreference='Stop';
try { [Console]::OutputEncoding=[Text.Encoding]::UTF8 } catch { };
Get-CimInstance Win32_Process -Filter "%(filt)s" | ForEach-Object {
  $cl = $_.CommandLine; if ($null -eq $cl) { $cl = '' };
  $cl = ($cl -replace "`r", ' ') -replace "`n", ' ';
  $ct = 0; if ($_.CreationDate) { $ct = $_.CreationDate.ToFileTime() };
  "%(d)s" -f $_.ProcessId, $ct, $_.Name, $cl
}
""".replace("%(d)s", "{0}`t{1}`t{2}`t{3}")


def process_snapshot():
    """一发 CIM 拿回 {pid: {name, cmd, created}}；查不动返回 None。

    原来每个 PID 单起一发 powershell（3 个 pythonw 就是 3 发 ≈3s，整轮 4.4s），
    而且单发一失败就"命令行里没这脚本"→ 判成没在跑 → 拉出第二个哨兵。

    自证条件：快照里必须看得见自己。看不见就当查询不可用 —— 输出被转义/编码/截断
    搞坏时 PowerShell 照样返回 0 行，那种"成功"比报错更危险（我拿真进程踩过：
    格式化串用了单引号，`t 没展开成制表符，解析不出任何一行 → 立刻多起了一个
    ann-agent 和一个 mesh-guardian）。
    """
    filt = " or ".join(f"Name='{n}'" for n in MANAGED_NAMES)
    try:
        r = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
                            "-Command", _PS_SNIPPET % {"filt": filt}],
                           capture_output=True, text=True, encoding="utf-8", errors="replace",
                           timeout=CIM_TIMEOUT, creationflags=CREATE_NO_WINDOW)
    except Exception as e:
        log(f"进程快照查询失败: {type(e).__name__}: {e}")
        return None
    if r.returncode != 0:
        log(f"进程快照返回码 {r.returncode}: {(r.stderr or '').strip()[:120]}")
        return None
    snap = {}
    for line in (r.stdout or "").splitlines():
        parts = line.split("\t", 3)
        if len(parts) < 4 or not parts[0].strip().isdigit():
            continue
        snap[int(parts[0])] = {"name": parts[2].strip().lower(),
                               "created": int(parts[1]) if parts[1].isdigit() else 0,
                               "cmd": parts[3]}
    if os.getpid() not in snap:
        log(f"进程快照里没有自己 pid={os.getpid()}（拿回 {len(snap)} 行）：判为查询不可用")
        return None
    return snap


def runs_script(cmd, script_path):
    """命令行里是不是真把这份脚本当参数跑了（不是 -c 里提一嘴、不是编辑器打开它）。"""
    base = os.path.basename(script_path).lower()
    for tok in re.split(r'[\s"]+', cmd or ""):
        t = tok.lower().strip("'")
        if t == base or t.endswith(os.sep + base) or t.endswith("/" + base):
            return True
    return False


def start_detached(args, name, env_extra=None):
    env = dict(os.environ)
    if env_extra:
        env.update(env_extra)
    try:
        proc = subprocess.Popen(args, cwd=BASE_DIR, creationflags=CREATE_NO_WINDOW, env=env,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        log(f"{name} 缺失 -> 已拉起 pid={proc.pid}")
        return True
    except Exception as e:
        log(f"{name} 拉起失败: {e}")
        return False


def kill(pid):
    """收整棵子树：裸 taskkill /F /PID 只杀父，mesh-guardian 的网桥子进程会留在原地。"""
    try:
        r = subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)],
                           capture_output=True, text=True, encoding="gbk", errors="replace",
                           creationflags=CREATE_NO_WINDOW, timeout=20)
        if r.returncode != 0:
            log(f"pid={pid} 终止失败 rc={r.returncode}: {(r.stdout or '').strip()[:80]}")
            return False
        return True
    except Exception as e:
        log(f"pid={pid} 终止异常: {e}")
        return False


def converge(pids, snap, label, script=None):
    """重复实例只留最老的那个。按 PID 排序会挑错人：PID 不是创建顺序，杀掉老的哨兵
    等于把它的 seen_blocks 一起扔了，重启后按旧状态重放历史块、重复自动应答。"""
    mine = os.getpid()
    ordered = sorted([p for p in pids if p != mine],
                     key=lambda p: (snap.get(p, {}).get("created", 0) if snap else 0, p))
    if len(ordered) < 2:
        return
    keep = ordered[0]
    for pid in ordered[1:]:
        # 杀之前再认一次命令行：拿的是几秒前的快照，PID 有可能已经换人了
        if script and not runs_script(snap.get(pid, {}).get("cmd", ""), script):
            log(f"{label} pid={pid} 命令行已不匹配，不敢杀")
            continue
        if kill(pid):
            log(f"{label} 重复实例 {pid} 已清理（保留最老的 {keep}）")


def ensure_ann_agent(snap):
    """ann-agent 必须恰好 1 个。"""
    if snap is not None:
        pids = [p for p, v in snap.items() if v["name"] == "ann-agent.exe"]
    else:
        pids = pids_by_name("ann-agent.exe")
        if pids is None:
            return "跳过(查不到进程)"
    if not pids:
        start_detached([ANN, "run"], "ann-agent", {"ANN_AGENT_DATA_DIR": ANN_DATA_DIR})
        return "已拉起"
    converge(pids, snap, "ann-agent")
    return "ok"


def ensure_mesh_guardian(snap):
    """mesh-guardian 必须恰好 1 个（pythonw 和 python 起的前台调试版都算）。"""
    if snap is None:
        return "跳过(查不到命令行)"
    pids = [p for p, v in snap.items()
            if v["name"] in ("pythonw.exe", "python.exe") and runs_script(v["cmd"], MESH_SCRIPT)]
    if not pids:
        start_detached([PYW, MESH_SCRIPT], "mesh-guardian")
        return "已拉起"
    converge(pids, snap, "mesh-guardian", MESH_SCRIPT)
    return "ok"


def main():
    if _LOCK_NOTE:
        log(f"[警告] {_LOCK_NOTE}")
    t0 = time.time()
    try:
        if not os.path.exists(MESH_SCRIPT):
            log(f"[警告] 被看护脚本不存在: {MESH_SCRIPT}（KA_MESH_SCRIPT/KA_BASE_DIR 指错了？）")
        snap = process_snapshot()
        if snap is None:
            log("[警告] 进程快照不可用：本轮只按映像名退路检查 ann-agent，不碰 mesh-guardian")
        r1 = ensure_ann_agent(snap)
        r2 = ensure_mesh_guardian(snap)
        log(f"巡检完成 ann-agent={r1} mesh-guardian={r2}（{time.time() - t0:.1f}s）")
    except Exception as e:
        log(f"巡检异常: {type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
