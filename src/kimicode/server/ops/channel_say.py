#!/usr/bin/env python3
"""channel_say.py — 主控侧频道发言(自动时间戳,读-改-写只增不改)

用法:
  python channel_say.py -f <正文.md> [说话人]
  python channel_say.py "<正文>" [说话人]
  DSH_CHANNEL=<chat.log 路径> python channel_say.py ...   # 指定频道(缺省 workbuddy 频道)

说话人缺省"主控侧(DSH)"。时间戳取本机当前时间(NTP 校准,偏差 <1s)。
"""
import os
import sys
from datetime import datetime
from pathlib import Path

CHAT = Path(os.environ.get("DSH_CHANNEL", "${DSH_DATA:-/srv/dsh-data}/AI协调频道/chat.log"))


def main():
    args = sys.argv[1:]
    speaker = "主控侧(DSH)"
    if args and args[-1] in ("WorkBuddy", "主控侧(DSH)", "管理员", "zcode"):
        speaker = args.pop()
    if args and args[0] == "-f":
        body = Path(args[1]).read_text(encoding="utf-8")
    elif args:
        body = args[0]
    else:
        print("用法: channel_say.py [-f 文件 | 正文] [说话人];频道用 DSH_CHANNEL 指定")
        sys.exit(1)
    current = CHAT.read_text(encoding="utf-8") if CHAT.exists() else ""
    ts = datetime.now().strftime("%Y-%m-%d %H:%M")
    block = f"\n### [{ts}] {speaker}\n{body.strip()}\n"
    CHAT.write_text(current + block, encoding="utf-8")
    print(f"已发言 [{ts}] {speaker} → {CHAT.parent.name}(+{len(block)} 字符)")


if __name__ == "__main__":
    main()
