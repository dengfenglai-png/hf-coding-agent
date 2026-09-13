#!/usr/bin/env python3
"""调用 DeepSeek vision 模型描述图片，用于校验 mermaid 渲染效果。
用法: python3 vision_check.py <api_key> <image_path> <prompt>"""
import base64
import json
import os
import sys

import requests

def vision(api_key: str, image_path: str, prompt: str) -> str:
    ext = os.path.splitext(image_path)[1].lstrip(".").lower()
    mime = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg"}.get(ext, "image/png")
    with open(image_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    resp = requests.post(
        "https://api.deepseek.com/chat/completions",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json={
            "model": "deepseek-v4-flash-vision-exp",
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
            ]}],
        },
        timeout=120,
    )
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"]

if __name__ == "__main__":
    print(vision(sys.argv[1], sys.argv[2], sys.argv[3]))
