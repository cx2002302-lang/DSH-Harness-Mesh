#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""channel_append.py — 向 AI 协调频道 chat.log 追加一个消息块（只增不改）

用法:
  python channel_append.py "<正文>" [说话人]
  python channel_append.py -f <正文文件.md> [说话人]
正文从 argv 或 -f 文件读；时间戳取本机当前时间。
频道路径可用 HM_CHAT_LOG 覆盖（默认主频道）。

2026-10-21 改写：原来是"读全文 → 拼 → 写全文"。线程外的跨进程并发它挡不住——
另一个写者在这期间落盘的新块，会被这份旧内容原样盖掉（频道规约是 append-only，
盖掉=丢消息；同缺陷在 mesh-guardian 上实测并发 120+120 块丢 32 块，还写出过半个块
让 UTF-8 解码失败）。现在改成"抢跨进程字节锁 → 只看文件尾几个字节定空行 → O_APPEND
写这一块"，任何情况下都不再整写回文件。参照实现：mesh-guardian._append_locked。
"""
import os
import sys
import time

if os.name == "nt":
    import msvcrt

CHAT = os.environ.get("HM_CHAT_LOG") or os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "AI协调频道", "chat.log")
LOCK_OFF = 1 << 30          # 远超文件尾的哨兵偏移:只当排队牌，读全文的人碰不到


def append_block(path, text):
    data = text.encode("utf-8")
    # O_BINARY:Windows 上 os.open 默认文本模式会把 "\n" 再翻一次，上面已按 CRLF 房规拼好
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_BINARY", 0))
    locked = False
    try:
        if os.name == "nt":
            os.lseek(fd, LOCK_OFF, os.SEEK_SET)
            for _ in range(100):          # 最多等 5s；抢不到就报错，不许盲写
                try:
                    msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                    locked = True
                    break
                except OSError:
                    time.sleep(0.05)
            else:
                raise SystemExit("频道锁 5s 没抢到（有写者卡住），本次未写入")
        off = 0
        while off < len(data):            # os.write 可能只写一半，漏掉的那半就是丢的块
            off += os.write(fd, data[off:])
    finally:
        if locked:
            try:
                os.lseek(fd, LOCK_OFF, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            except OSError:
                pass
        os.close(fd)
    return len(data)


def main():
    args = [a for a in sys.argv[1:]]
    speaker = "WorkBuddy"
    if args and args[-1] in ("WorkBuddy", "主控侧(DSH)", "qoder"):  # 发言人白名单;历史遗留人名已移除,如需兼容用环境变量注入(见 README)
        speaker = args.pop()
    if args and args[0] == "-f":
        body = open(args[1], encoding="utf-8").read()
    elif args:
        body = args[0]
    else:
        print("usage: channel_append.py '<body>' [speaker] | -f <file> [speaker]")
        sys.exit(2)
    ts = time.strftime("%Y-%m-%d %H:%M")
    tail = b""
    if os.path.exists(CHAT):
        with open(CHAT, "rb") as f:
            f.seek(max(0, os.path.getsize(CHAT) - 8))
            tail = f.read()
    n = len(tail) - len(tail.rstrip(b"\n"))    # 块间留且只留一个空行
    text = ("\n" * max(0, 2 - n) + f"### [{ts}] {speaker}\n{body.strip()}\n").replace("\n", "\r\n")
    size = append_block(CHAT, text)
    print(f"appended as [{ts}] {speaker}, size={os.path.getsize(CHAT)}, block_bytes={size}")


if __name__ == "__main__":
    main()
