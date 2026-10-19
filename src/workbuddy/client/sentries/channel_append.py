#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""channel_append.py — 向 AI 协调频道 chat.log 追加一个消息块（读-改-写，只增不改）

用法:
  python channel_append.py "<正文>" [说话人]
  python channel_append.py -f <正文文件.md> [说话人]
正文从 argv 或 -f 文件读；时间戳取本机当前时间。
"""
import sys
import time
from pathlib import Path

CHAT = Path(r"D:\AgentHome\DshData\AI协调频道\chat.log")


def main():
    args = [a for a in sys.argv[1:]]
    speaker = "WorkBuddy"
    if args and args[-1] in ("WorkBuddy", "主控侧(DSH)", "老徐"):
        speaker = args.pop()
    if args and args[0] == "-f":
        body = Path(args[1]).read_text(encoding="utf-8")
    elif args:
        body = args[0]
    else:
        print("usage: channel_append.py '<body>' [speaker] | -f <file> [speaker]")
        sys.exit(2)
    current = CHAT.read_text(encoding="utf-8") if CHAT.exists() else ""
    ts = time.strftime("%Y-%m-%d %H:%M")
    block = f"\n\n### [{ts}] {speaker}\n{body.strip()}\n"
    CHAT.write_text(current.rstrip("\n") + block, encoding="utf-8")
    print(f"appended as [{ts}] {speaker}, size={CHAT.stat().st_size}")


if __name__ == "__main__":
    main()
