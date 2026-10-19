#!/usr/bin/env python3
"""stdio↔TCP 桥:把 stdin/stdout 透传到 TCP 长连接。
用途:workbuddy 通过 ssh -R 把远端 codebuddy --acp 挂到本机 127.0.0.1:PORT,
mesh 的 acp-stdio 节点用本脚本作为 command,即可像本地进程一样对话。
用法: python3 acp-tcp.py <host> <port>
"""
import socket, sys, threading

def pump(src, dst):
    try:
        while True:
            data = src.read(1) if src is sys.stdin else src.recv(65536)
            if not data:
                break
            dst.write(data) if dst in (sys.stdout, sys.stderr) else dst.sendall(data)
            if dst is sys.stdout:
                dst.flush()
    except Exception:
        pass
    finally:
        try:
            if dst in (sys.stdout, sys.stderr):
                dst.flush()
            else:
                dst.shutdown(socket.SHUT_WR)
        except Exception:
            pass

def main():
    host, port = sys.argv[1], int(sys.argv[2])
    sock = socket.create_connection((host, port), timeout=10)
    sock.settimeout(None)
    t1 = threading.Thread(target=pump, args=(sys.stdin, sock), daemon=True)
    t2 = threading.Thread(target=pump, args=(sock, sys.stdout), daemon=True)
    t1.start(); t2.start()
    t2.join(600)  # ACP 会话最长 10 分钟,避免僵尸桥
    sys.exit(0)

if __name__ == "__main__":
    main()
