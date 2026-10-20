#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
zcode-adapter-models-patch.py — 给远端 zcode-adapter.py(session/new 上报模型表)打「精确字符串替换」补丁

用法:
  python zcode-adapter-models-patch.py <目标文件路径> [--check]
    --check  只校验锚点是否存在,不写盘

背景:远端 Windows 机 D:\\AgentHome\\DshData\\wb-green\\zcode-adapter.py(zcode 的 ACP 适配器,
-p 引擎)要在 session/new 上报模型表。本脚本没拿过该文件全文,所以全部用「精确字符串替换」:
任何锚点找不到 → FAIL 且不落盘;检测到已打过补丁 → 幂等跳过。

三处替换:
  a) session/new 的 respond 行 → 构造 result,模型清单非空时附 configOptions(select 型)
     并在文件头部(ZCODE_CJS 赋值之后)新增 MODELS(env ZCODE_MODELS 可覆盖,默认
     GLM-5.3,GLM-5.3-Flash —— zcode 桌面 3.15.3 builtin 注册表里的真实型号)
  b) method not found 兜底分支前,插入 session/set_model 分支:诚实拒绝(-32602),
     因为 zcode CLI(-p)无 --model,静默接受会跑错模型
  c) 文件头 docstring「配置(env,…)」段加 ZCODE_MODELS 说明行

退出码:0 = 成功/已打过补丁;1 = 锚点缺失(未改动目标文件)。纯 stdlib,中文输出。
"""
import os
import re as _re
import sys

# ---------- 补丁定义 ----------

# a-1) 头部 MODELS 定义:插在 ZCODE_CJS 赋值语句(以 ZCODE_CJS = 开头的行)之后
MODELS_DEF = (
    "\n"
    "# 会话模型表:zcode 桌面 3.15.3 builtin 注册表里的真实型号;env ZCODE_MODELS 可覆盖\n"
    "MODELS = [m.strip() for m in os.environ.get(\"ZCODE_MODELS\", \"GLM-5.3,GLM-5.3-Flash\").split(\",\") if m.strip()]\n"
)

# a-2) session/new 的 respond 行替换(缩进在 apply_patch 里按目标文件实际缩进重建)
ANCHOR_A = 'respond(rid, {"jsonrpc": "2.0", "id": rid, "result": {"sessionId": acp_sid}})'

# b) method not found 兜底分支前插入 session/set_model(前插)
# 2026-10-20 实踩:目标文件续行缩进与本地摘要不一致(24 vs 26 空格),锚点改正则、缩进弹性匹配
ANCHOR_B_RE = _re.compile(
    r'        elif rid is not None:\n'
    r'\s+respond\(rid, \{"jsonrpc": "2\.0", "id": rid,\n'
    r'\s+"error": \{"code": -32601, "message": f"method not found: \{method\}"\}\}\)')
INSERT_B = (
    '        elif method == "session/set_model":\n'
    '            # 诚实拒绝:zcode CLI(-p)无 --model,不支持按会话选模型;静默接受会跑错模型\n'
    '            respond(rid, {"jsonrpc": "2.0", "id": rid,\n'
    '                          "error": {"code": -32602, "message":\n'
    '                                    "zcode -p 引擎不支持按会话选模型;请在 ZCode 桌面端 /model 切换,"\n'
    '                                    "或在 plugs.json env ZCODE_MODELS 登记"}})\n'
)

# c) docstring「配置(env,…)」段加 ZCODE_MODELS 说明行:插在锚点所在行之后
ANCHOR_C = "配置(env,"

# 幂等探测标记
MARKERS = ("MODELS = [m.strip() for m in os.environ.get(\"ZCODE_MODELS\"",
           '"session/set_model"',
           "ZCODE_MODELS 逗号分隔的可用型号登记")


def find_cjs_line_end(src):
    """返回 ZCODE_CJS = ... 赋值语句(可多行,按括号配平吞到闭合)结束偏移;找不到返回 -1。
    实踩:目标文件是多行调用 ZCODE_CJS = os.environ.get(\n "ZCODE_CJS",\n r"..."),只吞首行会把 MODELS 插进调用中间。"""
    lines = src.splitlines(keepends=True)
    off = 0
    for i, line in enumerate(lines):
        if _re.match(r"^\s*ZCODE_CJS\s*=", line):  # 必须带 =:docstring 里的同名描述行不算(实踩 NameError)
            depth = line.count("(") - line.count(")")
            end = off + len(line)
            while depth > 0 and i + 1 < len(lines):
                i += 1
                end += len(lines[i])
                depth += lines[i].count("(") - lines[i].count(")")
            return end
        off += len(line)
    return -1


MODELS_LINE_RE = _re.compile(r"^\s*MODELS = \[m\.strip\(\).*\n?", _re.M)


def apply_patch(src):
    """返回 (新文本, 各步结果消息列表);失败抛 ValueError(不落盘)。
    逐块幂等:每块先看自己的产物在不在,在就跳过——兼容「半打好」状态(实踩:
    MODELS 落进 docstring 触发 NameError 后,其余块已生效,整体标记不能再当跳过依据)。"""
    msgs = []

    # a-1) MODELS 归一化:剥掉一切既有定义(无论落哪),重新插到真赋值语句之后
    src2, n_strip = MODELS_LINE_RE.subn("", src)
    pos = find_cjs_line_end(src2)
    if pos < 0:
        raise ValueError("锚点 a-1(ZCODE_CJS = 赋值行)未找到")
    src2 = src2[:pos] + MODELS_DEF + src2[pos:]
    msgs.append(f"a-1) MODELS 定义已归位到 ZCODE_CJS 赋值之后(剥除旧定义 {n_strip} 处) ✔")

    # c) docstring 段
    if "ZCODE_MODELS 逗号分隔的可用型号登记" in src2:
        msgs.append("c) docstring 说明行已在,跳过")
    else:
        idx = src2.find(ANCHOR_C)
        if idx < 0:
            raise ValueError("锚点 c(docstring「配置(env,…」)未找到")
        line_end = src2.find("\n", idx)
        if line_end < 0:
            line_end = len(src2)
        insert_c = ("  ZCODE_MODELS 逗号分隔的可用型号登记(默认 GLM-5.3,GLM-5.3-Flash;"
                    "仅上报展示,不支持按会话切换)\n")
        src2 = src2[:line_end + 1] + insert_c + src2[line_end + 1:]
        msgs.append("c) docstring 配置段:已插入 ZCODE_MODELS 说明行 ✔")

    # a-2) session/new respond 行:产物在则跳过
    if 'result["configOptions"]' in src2:
        msgs.append("a-2) configOptions respond 已在,跳过")
    elif src2.count(ANCHOR_A) != 1:
        raise ValueError(f"锚点 a-2(session/new respond 行)出现 {src2.count(ANCHOR_A)} 次(应为 1)")
    else:
        line_start = src2.rfind("\n", 0, src2.find(ANCHOR_A)) + 1
        indent = src2[line_start:src2.find(ANCHOR_A)]  # 锚点行原有缩进
        body = (
            'result = {"sessionId": acp_sid}\n'
            + indent + 'if MODELS:  # 模型清单非空时上报模型表(configOptions select)\n'
            + indent + '    result["configOptions"] = [{"id": "model", "name": "Model", "category": "model",\n'
            + indent + '                                "type": "select", "currentValue": MODELS[0],\n'
            + indent + '                                "options": [{"value": m, "name": m} for m in MODELS]}]\n'
            + indent + 'respond(rid, {"jsonrpc": "2.0", "id": rid, "result": result})'
        )
        src2 = src2.replace(ANCHOR_A, body)
        msgs.append("a-2) session/new:已改为构造 result 并附 configOptions 模型表 ✔")

    # b) method not found 兜底分支前插 session/set_model
    if '"session/set_model"' in src2:
        msgs.append("b) set_model 分支已在,跳过")
    else:
        hits_b = ANCHOR_B_RE.findall(src2)
        if len(hits_b) != 1:
            raise ValueError(f"锚点 b(method not found 分支)出现 {len(hits_b)} 次(应为 1)")
        src2 = ANCHOR_B_RE.sub(lambda m: INSERT_B + m.group(0), src2, count=1)
        msgs.append("b) 已在 method not found 前插入 session/set_model 诚实拒绝分支(-32602) ✔")

    return src2, msgs


def main():
    args = [a for a in sys.argv[1:] if a != "--check"]
    check = "--check" in sys.argv[1:]
    if len(args) != 1:
        print("用法: python zcode-adapter-models-patch.py <目标文件路径> [--check]")
        return 1
    path = args[0]
    if not os.path.exists(path):
        print(f"FAIL: 目标文件不存在: {path}")
        return 1
    with open(path, "r", encoding="utf-8", newline="") as f:
        src = f.read()
    if "\r\n" in src:  # Windows CRLF 归一为 LF 再匹配(多行锚点才不被 \r 卡死)
        src = src.replace("\r\n", "\n")

    # --check 模式:逐块报状态(已打/可打/缺锚点)
    if check:
        ok = True
        models_pos = [m.start() for m in _re.finditer(r"^\s*MODELS = \[m\.strip\(\)", src, _re.M)]
        assign = find_cjs_line_end(src)
        models_ok = bool(models_pos) and assign >= 0 and all(p > assign for p in models_pos)
        print(f"CHECK a-1 MODELS: {'已正确归位' if models_ok else ('存在但错位(需归位)' if models_pos else '未打')}"
              f";赋值锚点 {'在' if assign >= 0 else '缺失'}")
        ok = ok and assign >= 0
        for name, done, anchor_cnt in (
                ("a-2 configOptions respond", 'result["configOptions"]' in src, src.count(ANCHOR_A)),
                ("b set_model 分支", '"session/set_model"' in src, len(ANCHOR_B_RE.findall(src))),
                ("c docstring 说明行", "ZCODE_MODELS 逗号分隔" in src, src.count(ANCHOR_C))):
            if done:
                print(f"CHECK {name}: 已打")
            elif anchor_cnt == 1:
                print(f"CHECK {name}: 未打(锚点在,可打)")
            else:
                print(f"CHECK {name}: 未打且锚点缺失/不唯一({anchor_cnt})")
                ok = False
        print("CHECK: " + ("可打/可修" if ok else "有缺锚点的块,不会落盘"))
        return 0 if ok else 1

    try:
        new_src, msgs = apply_patch(src)
    except ValueError as e:
        print(f"FAIL: {e}(未落盘)")
        return 1
    with open(path, "w", encoding="utf-8", newline="\n") as f:  # 统一 LF 落盘(Python 源码无所谓行尾)
        f.write(new_src)
    for m in msgs:
        print(m)
    print(f"OK: 补丁已写入 {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
