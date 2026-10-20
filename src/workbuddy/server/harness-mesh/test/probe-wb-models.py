#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
probe-wb-models.py — wb-gateway-adapter v5 模型表(configOptions)+ session/set_model 验收

自包含:临时 HOME 放 .workbuddy/models.json + env 注入,子进程跑 adapter,NDJSON 走 stdio。
v5 的 session/new 是纯本地生成 sessionId(不碰 gateway),本测试不需要 mock-gateway;
为避免真机端口扫描干扰,仍给 env GATEWAY_URL 指向一个不存在的地址(发现秒回,失败干净落在 prompt 层)。

场景:HOME/.workbuddy/models.json 有 2 个型号(GLM-5.3 / GLM-5.3-Flash),
     HOME/.workbuddy/cache/acc-product-config-v3.json 的 .models 覆盖各种过滤
     (disabled、image/video tags、custom-local:、codewise*/含 completion 的 id),
     2 个正常聊天模型(GLM-5.3-FlashX / Kimi-K2),其中 GLM-5.3/GLM-5.3-Flash 与 models.json 同名应去重;
     env GATEWAY_MODELS="glm-4.6" 再加 1 个,GATEWAY_MODEL="glm-4.6"。
断言 session/new:
  - configOptions[0] 形状:id=model / category=model / type=select
  - options 共 5 个型号:env glm-4.6 最前,其后 models.json 2 个,再目录缓存的 2 个新模型,保序去重
  - currentValue == env GATEWAY_MODEL(glm-4.6)
断言 session/set_model:
  - 已知 sid → 诚实回 error -32602(gateway runs API 不支持按会话选模型),不静默吞
  - 未知 sid → error -32001

结束 kill 子进程并清理临时目录,PASS/FAIL + exit 码。
"""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ADAPTER = os.path.join(ROOT, "scripts", "wb-gateway-adapter.py")


def fail(msg):
    print(f"FAIL: {msg}")
    return 1


def rpc(proc, msg):
    proc.stdin.write((json.dumps(msg) + "\n").encode())
    proc.stdin.flush()


def read_resp(proc, rid, timeout=10):
    """从 adapter stdout 读到 id==rid 的响应(跳过通知)"""
    import time
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


def main():
    rc = 1
    adapter = None
    td = tempfile.mkdtemp(prefix="wb-models-probe-")
    try:
        # 临时 HOME:.workbuddy/models.json 2 个型号 + 官方目录缓存 acc-product-config-v3.json
        wb_dir = os.path.join(td, ".workbuddy")
        cache_dir = os.path.join(wb_dir, "cache")
        os.makedirs(cache_dir)
        with open(os.path.join(wb_dir, "models.json"), "w", encoding="utf-8") as f:
            json.dump([
                {"id": "GLM-5.3", "name": "GLM 5.3", "vendor": "zai"},
                {"id": "GLM-5.3-Flash", "name": "GLM 5.3 Flash", "vendor": "zai"},
            ], f)
        # 目录缓存覆盖各种过滤:disabled、image/video tags、custom-local:、codewise*/含 completion、
        # 正常聊天模型;其中 'GLM-5.3'/'GLM-5.3-Flash' 与 models.json 同名,应被去重
        with open(os.path.join(cache_dir, "acc-product-config-v3.json"), "w", encoding="utf-8") as f:
            json.dump({"models": [
                {"name": "GLM-5.3", "id": "glm-5.3", "tags": ["craft"], "credits": "x0.29"},
                {"name": "GLM-5.3-Flash", "id": "glm-5.3-flash", "tags": ["craft"], "credits": "x0.29"},
                {"name": "GLM-5.3-FlashX", "id": "glm-5.3-flashx", "tags": ["craft"], "credits": "x0.29"},
                {"name": "Kimi-K2", "id": "kimi-k2", "tags": ["text"], "credits": "x0.5"},
                {"name": "IMG-XL", "id": "img-xl", "tags": ["text-to-image"], "credits": "x1"},
                {"name": "IMG-Edit", "id": "img-edit", "tags": ["image-to-image"], "credits": "x1"},
                {"name": "VID-Motion", "id": "vid-motion", "tags": ["text-to-video", "image-to-video"], "credits": "x2"},
                {"name": "My-Local", "id": "custom-local:foo", "tags": ["custom"], "credits": "x0"},
                {"name": "Disabled-M", "id": "disabled-m", "tags": ["craft"], "disabled": True, "credits": "x0.1"},
                {"name": "Codewise-M", "id": "codewise-mini", "tags": ["craft"], "credits": "x0.1"},
                {"name": "Fill-In", "id": "glm-completion-lite", "tags": ["craft"], "credits": "x0.1"},
            ]}, f)

        env = dict(os.environ)
        env["HOME"] = td
        env["USERPROFILE"] = td                      # 适配器优先读 USERPROFILE,一并隔离真机清单
        env["GATEWAY_URL"] = "http://127.0.0.1:1"    # 不存在的地址:发现秒回,prompt 层才会失败
        env["GATEWAY_MODELS"] = "glm-4.6"            # env 再加 1 个,应排最前
        env["GATEWAY_MODEL"] = "glm-4.6"             # currentValue 应取它
        env["ADAPTER_IDLE_EXIT"] = "60"
        env.pop("ADAPTER_LOG", None)

        adapter = subprocess.Popen([sys.executable, ADAPTER], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env)

        rpc(adapter, {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                      "params": {"protocolVersion": 1, "clientCapabilities": {}}})
        r = read_resp(adapter, 1)
        if not r or "result" not in r:
            return fail(f"initialize 失败: {r}")

        rpc(adapter, {"jsonrpc": "2.0", "id": 2, "method": "session/new",
                      "params": {"cwd": os.getcwd(), "mcpServers": []}})
        r = read_resp(adapter, 2)
        if not r or "result" not in r:
            return fail(f"session/new 失败: {r}")
        sid = r["result"].get("sessionId")
        cos = r["result"].get("configOptions") or []
        if len(cos) != 1:
            return fail(f"configOptions 应恰 1 项,实际: {cos}")
        co = cos[0]
        if co.get("id") != "model" or co.get("category") != "model" or co.get("type") != "select":
            return fail(f"configOptions 形状不对: {co}")
        opts = [o.get("value") for o in co.get("options", [])]
        names = [o.get("name") for o in co.get("options", [])]
        if opts != ["glm-4.6", "GLM-5.3", "GLM-5.3-Flash", "GLM-5.3-FlashX", "Kimi-K2"]:
            return fail(f"应为 5 型号:env 优先 + models.json + 目录缓存(过滤后)保序去重,实际 {opts}")
        # 自定义(env + models.json)name 加 " · 自定义" 后缀,自带(目录缓存)不加;value 全干净名
        if names != ["glm-4.6 · 自定义", "GLM-5.3 · 自定义", "GLM-5.3-Flash · 自定义",
                     "GLM-5.3-FlashX", "Kimi-K2"]:
            return fail(f"自定义项 name 应带 ' · 自定义' 后缀、自带项不带,实际 {names}")
        if co.get("currentValue") != "glm-4.6":
            return fail(f"currentValue 应为干净名 glm-4.6,实际 {co.get('currentValue')}")

        # set_model:已知 sid → 诚实 -32602(gateway runs API 不支持按会话选模型)
        rpc(adapter, {"jsonrpc": "2.0", "id": 3, "method": "session/set_model",
                      "params": {"sessionId": sid, "modelId": "GLM-5.3-Flash"}})
        r = read_resp(adapter, 3)
        if not r or r.get("error", {}).get("code") != -32602:
            return fail(f"session/set_model 应诚实回 error -32602,实际: {r}")
        if "不支持" not in r["error"].get("message", ""):
            return fail(f"-32602 message 应说明 gateway 不支持按会话选模型,实际: {r['error']}")

        # set_model:未知 sid → -32001
        rpc(adapter, {"jsonrpc": "2.0", "id": 4, "method": "session/set_model",
                      "params": {"sessionId": "s-unknown", "modelId": "x"}})
        r = read_resp(adapter, 4)
        if not r or r.get("error", {}).get("code") != -32001:
            return fail(f"未知 sid 应回 -32001,实际: {r}")

        print("PASS: configOptions 上报 5 型号(env glm-4.6 优先 + models.json 2 + 目录缓存过滤后 "
              "GLM-5.3-FlashX/Kimi-K2;同名去重、disabled/image/video/custom-local:/补全模型全被滤掉),"
              "自定义项 name 带 ' · 自定义' 后缀且 value 为干净名、自带项 name 无后缀,"
              "currentValue=glm-4.6(干净名);"
              "session/set_model 已知 sid 诚实 -32602、未知 sid -32001")
        rc = 0
    except Exception as e:
        print(f"FAIL: 异常: {e}")
        rc = 1
    finally:
        if adapter:
            adapter.kill()
            adapter.wait()
        try:
            import shutil
            shutil.rmtree(wb_dir, ignore_errors=True)
            os.rmdir(td)
        except OSError:
            pass
    return rc


if __name__ == "__main__":
    sys.exit(main())
