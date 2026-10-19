#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""keepalive.py v2 — WinPC 值守统一保活（单实例锁 + 幂等）
设计目标（本机用户要求：可持续、免人工维护）：
  - 唯一保活入口：schtasks harness-mesh-keepalive 每 5 分钟触发本脚本
  - 单实例锁：本脚本自身用命名 Mutex 防并发（多触发只跑一个）
  - 只做"缺失则拉起、重复则收敛"，已在跑的正常实例一律不碰（幂等，安全重复执行）
  - 管理范围：ann-agent（隧道）、mesh-guardian（哨兵）
    · harnessd_win(7080) 交给本机用户的 start-all(WbMeshBridge) 管，此处不重复管
    · guardian.py 已废弃（功能被本脚本覆盖），不再拉起
  - 全程 CREATE_NO_WINDOW（pythonw 下不弹窗）
"""
import ctypes
import os
import subprocess
import sys
from datetime import datetime

PYW = os.path.expanduser(r"~\.workbuddy\binaries\python\versions\3.13.12\pythonw.exe")
GB = os.environ.get("MESH_GREEN_DIR", r"D:\DshData\wb-green")
ANN = os.path.join(GB, "ann-agent.exe")
LOG = os.path.join(GB, "keepalive.log")
CREATE_NO_WINDOW = 0x08000000
MUTEX_NAME = "Global\\wb_mesh_keepalive_v2"

# ---------- 单实例锁 ----------
_k32 = ctypes.WinDLL("kernel32", use_last_error=True)
_k32.CreateMutexW.restype = ctypes.c_void_p
_k32.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p]
_HANDLE = _k32.CreateMutexW(None, False, MUTEX_NAME)
if ctypes.get_last_error() == 183:  # ERROR_ALREADY_EXISTS
    sys.exit(0)                      # 已有实例在跑，本次直接退出（幂等）


def log(msg):
    line = f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def pids_by_name(name):
    """按映像名查 PID 列表（tasklist，GBK 解码）"""
    try:
        out = subprocess.run(["tasklist", "/FI", f"IMAGENAME eq {name}", "/FO", "CSV", "/NH"],
                             capture_output=True, text=True, encoding="gbk",
                             errors="replace", timeout=20,
                             creationflags=CREATE_NO_WINDOW).stdout
        pids = []
        for line in out.splitlines():
            parts = line.split(",")
            if len(parts) >= 2 and parts[0].strip('"').lower() == name.lower():
                pid = parts[1].strip('"')
                if pid.isdigit():
                    pids.append(int(pid))
        return pids
    except Exception as e:
        log(f"tasklist 失败({name}): {e}")
        return []


def cmdline_has(pid, keyword):
    """进程命令行是否含关键词（用 CIM，失败则视为不匹配）"""
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             f"(Get-CimInstance Win32_Process -Filter \"ProcessId={pid}\").CommandLine"],
            capture_output=True, text=True, encoding="gbk", errors="replace",
            timeout=15, creationflags=CREATE_NO_WINDOW).stdout
        return keyword.lower() in (out or "").lower()
    except Exception:
        return False


def start_detached(args, name, env_extra=None):
    env = dict(os.environ)
    if env_extra:
        env.update(env_extra)
    try:
        subprocess.Popen(args, cwd=GB, creationflags=CREATE_NO_WINDOW, env=env,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        log(f"{name} 缺失 -> 已拉起")
        return True
    except Exception as e:
        log(f"{name} 拉起失败: {e}")
        return False


def kill(pid):
    try:
        subprocess.run(["taskkill", "/F", "/PID", str(pid)],
                       capture_output=True, creationflags=CREATE_NO_WINDOW, timeout=15)
        return True
    except Exception:
        return False


def ensure_mesh_guardian():
    """mesh-guardian 必须恰好 1 个（按命令行含 mesh-guardian.py 判断）"""
    pids = pids_by_name("pythonw.exe")
    live = [p for p in pids if cmdline_has(p, "mesh-guardian.py")]
    if not live:
        start_detached([PYW, os.path.join(GB, "mesh-guardian.py")], "mesh-guardian")
    elif len(live) > 1:
        live.sort()
        for extra in live[1:]:
            if kill(extra):
                log(f"mesh-guardian 重复实例 {extra} 已清理（保留 {live[0]}）")


def ensure_ann_agent():
    """ann-agent 必须恰好 1 个"""
    pids = pids_by_name("ann-agent.exe")
    if not pids:
        start_detached([ANN, "run"], "ann-agent",
                       {"ANN_AGENT_DATA_DIR": os.path.join(GB, "ann-data")})
    elif len(pids) > 1:
        pids.sort()
        for extra in pids[1:]:
            if kill(extra):
                log(f"ann-agent 重复实例 {extra} 已清理（保留 {pids[0]}）")


def main():
    try:
        ensure_ann_agent()
        ensure_mesh_guardian()
        log("巡检完成（ann-agent / mesh-guardian 已确保单实例）")
    except Exception as e:
        log(f"巡检异常: {type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
