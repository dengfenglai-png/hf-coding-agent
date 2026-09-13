#!/usr/bin/env python3
"""把 mermaid 源码渲染成 PNG（走 kroki.io，POST 源码；用 curl 因其 UA 过 WAF）。"""
import os
import subprocess
import sys

def render(mmd_path: str, out_path: str) -> None:
    subprocess.run(
        ["curl", "-s", "-m", "60", "-X", "POST", "https://kroki.io/mermaid/png",
         "--data-binary", f"@{mmd_path}", "-H", "Content-Type: text/plain",
         "-o", out_path],
        check=True,
    )
    print(f"rendered {out_path} ({os.path.getsize(out_path)} bytes)")

if __name__ == "__main__":
    render(sys.argv[1], sys.argv[2])
