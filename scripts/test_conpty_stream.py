"""Verify ConPTY truly streams knot-cli output token-by-token.

用法:
    python scripts/test_conpty_stream.py
可选参数:
    --msg "你好"   自定义 prompt
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--msg", default="用 10 个要点介绍一下 hermes-agent-studio 这个项目")
    ap.add_argument("--model", default="glm-5.1")
    args = ap.parse_args()

    try:
        import winpty  # type: ignore
    except ImportError:
        print("[fatal] pywinpty not installed. pip install pywinpty")
        sys.exit(1)

    import shutil
    cli = shutil.which("knot-cli") or shutil.which("knot-cli.exe")
    if not cli:
        print("[fatal] knot-cli not found")
        sys.exit(2)
    cmd_dir = os.path.dirname(cli)
    bare = "knot-cli"
    env = dict(os.environ)
    env["PATH"] = cmd_dir + os.pathsep + env.get("PATH", "")
    env.setdefault("PYTHONIOENCODING", "utf-8")

    argv = ["cmd.exe", "/c", bare, "chat", "-m", args.model, "-p", args.msg]
    cmdline = subprocess.list2cmdline(argv[2:])
    wrapped = f'cmd.exe /c {cmdline}'
    print(f"[cmdline] {wrapped}")

    pty = winpty.PtyProcess.spawn(wrapped, cwd=None, env=env, dimensions=(40, 200))
    t0 = time.time()
    total = 0
    last = t0
    print("─" * 60)
    while pty.isalive():
        try:
            data = pty.read(1024)
        except EOFError:
            break
        except Exception as e:
            print(f"[read err] {e}")
            break
        if not data:
            continue
        now = time.time()
        gap = now - last
        last = now
        total += len(data)
        # 每块输出一个时间戳头，证明是实时流
        sys.stdout.write(f"\n[+{now-t0:5.2f}s Δ{gap*1000:5.0f}ms {len(data):3d}ch] ")
        sys.stdout.write(data)
        sys.stdout.flush()
    try:
        tail = pty.read(2048)
        if tail:
            sys.stdout.write(f"\n[+{time.time()-t0:5.2f}s tail {len(tail):3d}ch] {tail}")
    except Exception:
        pass
    rc = pty.exitstatus
    print(f"\n{'─'*60}\n[rc] {rc}   [total] {total} chars   [elapsed] {time.time()-t0:.2f}s")


if __name__ == "__main__":
    main()
