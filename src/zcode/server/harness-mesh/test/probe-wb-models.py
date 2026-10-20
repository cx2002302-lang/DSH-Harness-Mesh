#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
probe-wb-models.py — wb-gateway-adapter 模型表(configOptions)+ session/set_model 验收

自包含:tempfile 起 mock-gateway(127.0.0.1:18999)+ 子进程跑 adapter,NDJSON 走 stdio。

场景1:env GATEWAY_MODELS=glm-4.6,glm-4.5-air
  断言:session/new 响应 configOptions 含 4 个模型(env 2 + gateway 2)且 currentValue=="glm-4.6"
        set_model 成功回 {};未知 sid 回 -32001
场景2:临时 HOME 放 .workbuddy/models.json(2 个模型),env 不给 GATEWAY_MODELS
  断言:configOptions 含 4 个模型(models.json 2 + gateway 2),currentValue 为 models.json 首个

结束 kill 全部子进程,PASS/FAIL + 对应 exit 码。
"""
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
MOCK = os.path.join(ROOT, "scripts", "mock-gateway.py")
ADAPTER = os.path.join(ROOT, "scripts", "wb-gateway-adapter.py")
PORT = 18999
BASE = f"http://127.0.0.1:{PORT}"


def fail(msg):
    print(f"FAIL: {msg}")
    return 1


def start_mock(workdir):
    """把 mock-gateway.py 复制进 tempfile 并把端口换成 18999,起子进程"""
    src = open(MOCK, encoding="utf-8").read().replace("127.0.0.1\", 9999", f"127.0.0.1\", {PORT}")
    assert f", {PORT})" in src, "mock 端口替换失败"
    path = os.path.join(workdir, "mock-gateway.py")
    open(path, "w", encoding="utf-8").write(src)
    return subprocess.Popen([sys.executable, path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def wait_mock(timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(BASE + "/api/models", timeout=1) as r:
                return json.loads(r.read().decode())
        except Exception:
            time.sleep(0.1)
    raise RuntimeError("mock-gateway 未就绪")


def rpc(proc, msg):
    proc.stdin.write((json.dumps(msg) + "\n").encode())
    proc.stdin.flush()


def read_resp(proc, rid, timeout=10):
    """从 adapter stdout 读到 id==rid 的响应(跳过通知)"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            time.sleep(0.05)
            continue
        try:
            m = json.loads(line)
        except Exception:
            continue
        if m.get("id") == rid:
            return m
    return None


def start_adapter(env_overrides):
    env = dict(os.environ)
    # 隔离真实机器上的 ~/.workbuddy/models.json,防止污染断言
    env.pop("USERPROFILE", None)
    env["GATEWAY_URL"] = BASE
    env.update(env_overrides)
    return subprocess.Popen(
        [sys.executable, ADAPTER], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, env=env)


def session_new_models(adapter):
    """initialize + session/new,返回 (sid, configOptions 模型 value 列表, co 对象);失败时 sid=None"""
    rpc(adapter, {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                  "params": {"protocolVersion": 1, "clientCapabilities": {}}})
    r = read_resp(adapter, 1)
    if not r or "result" not in r:
        return None, None, f"initialize 失败: {r}"
    rpc(adapter, {"jsonrpc": "2.0", "id": 2, "method": "session/new",
                  "params": {"cwd": os.getcwd(), "mcpServers": []}})
    r = read_resp(adapter, 2)
    if not r or "result" not in r:
        return None, None, f"session/new 失败: {r}"
    sid = r["result"].get("sessionId")
    co = (r["result"].get("configOptions") or [{}])[0]
    opts = [o.get("value") for o in co.get("options", [])]
    return sid, opts, co


def scenario_1(td):
    """env GATEWAY_MODELS 2 个 + gateway /api/models 2 个 = 4;set_model 交互"""
    adapter = start_adapter({"GATEWAY_MODELS": "glm-4.6,glm-4.5-air", "HOME": td})
    try:
        sid, opts, co = session_new_models(adapter)
        if sid is None:
            return fail(opts)
        if co.get("id") != "model" or co.get("category") != "model":
            return fail(f"configOptions 形状不对: {co}")
        if len(opts) != 4:
            return fail(f"场景1 模型数应为 4,实际 {opts}")
        if co.get("currentValue") != "glm-4.6":
            return fail(f"场景1 currentValue 应为 glm-4.6,实际 {co.get('currentValue')}")
        if opts[:2] != ["glm-4.6", "glm-4.5-air"] or opts[2:] != ["wb-coder-pro", "wb-chat-lite"]:
            return fail(f"场景1 合并保序不对: {opts}")

        rpc(adapter, {"jsonrpc": "2.0", "id": 3, "method": "session/set_model",
                      "params": {"sessionId": sid, "modelId": "glm-4.5-air"}})
        r = read_resp(adapter, 3)
        if not r or r.get("result") != {}:
            return fail(f"场景1 session/set_model 应成功回 {{}},实际: {r}")

        rpc(adapter, {"jsonrpc": "2.0", "id": 4, "method": "session/set_model",
                      "params": {"sessionId": "s-unknown", "modelId": "x"}})
        r = read_resp(adapter, 4)
        if not r or r.get("error", {}).get("code") != -32001:
            return fail(f"场景1 未知 sid 应回 -32001,实际: {r}")
    finally:
        adapter.kill()
        adapter.wait()
    print("PASS 场景1: configOptions 上报 4 模型(env 2 + gateway 2),currentValue=glm-4.6,"
          "set_model 成功/未知 sid 报 -32001")
    return 0


def scenario_2(td):
    """临时 HOME 放 .workbuddy/models.json(2 个),env 不给 GATEWAY_MODELS + gateway 2 个 = 4"""
    wb_dir = os.path.join(td, ".workbuddy")
    os.makedirs(wb_dir)
    with open(os.path.join(wb_dir, "models.json"), "w", encoding="utf-8") as f:
        json.dump([
            {"id": "GLM-5.3", "name": "GLM 5.3", "vendor": "zai"},
            {"id": "GLM-5.3-Flash", "name": "GLM 5.3 Flash", "vendor": "zai"},
        ], f)
    adapter = start_adapter({"HOME": td})  # 不给 GATEWAY_MODELS
    try:
        sid, opts, co = session_new_models(adapter)
        if sid is None:
            return fail(opts)
        if co.get("id") != "model" or co.get("category") != "model":
            return fail(f"场景2 configOptions 形状不对: {co}")
        if len(opts) != 4:
            return fail(f"场景2 模型数应为 4,实际 {opts}")
        if co.get("currentValue") != "GLM-5.3":
            return fail(f"场景2 currentValue 应为 models.json 首个 GLM-5.3,实际 {co.get('currentValue')}")
        if opts[:2] != ["GLM-5.3", "GLM-5.3-Flash"] or opts[2:] != ["wb-coder-pro", "wb-chat-lite"]:
            return fail(f"场景2 合并保序不对: {opts}")
    finally:
        adapter.kill()
        adapter.wait()
    print("PASS 场景2: configOptions 上报 4 模型(.workbuddy/models.json 2 + gateway 2),"
          "currentValue=GLM-5.3,合并保序正确")
    return 0


def main():
    procs = []
    rc = 1
    try:
        with tempfile.TemporaryDirectory() as td:
            mock = start_mock(td)
            procs.append(mock)
            models_api = wait_mock()
            ids_api = [m["id"] for m in models_api["models"]]
            assert set(ids_api) == {"wb-coder-pro", "wb-chat-lite"}, f"mock /api/models 异常: {ids_api}"

            rc = scenario_1(td)
            if rc == 0:
                rc = scenario_2(td)
    except Exception as e:
        print(f"FAIL: 异常: {e}")
        rc = 1
    finally:
        for p in procs:
            try:
                p.kill()
            except Exception:
                pass
        for p in procs:
            p.wait()
    return rc


if __name__ == "__main__":
    sys.exit(main())
