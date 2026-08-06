"""claude.py — Claude API クライアント（標準ライブラリのみで動く）。"""

from __future__ import annotations

import base64
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

API_URL = "https://api.anthropic.com/v1/messages"


def _image_block(path: Path) -> dict:
    suffix = Path(path).suffix.lower()
    media = "image/png" if suffix == ".png" else "image/jpeg"
    data = base64.b64encode(Path(path).read_bytes()).decode("ascii")
    return {"type": "image", "source": {"type": "base64", "media_type": media, "data": data}}


def ask_claude(system: str, user: str, max_tokens: int = 4000,
               model: str = "claude-sonnet-5", images: list | None = None) -> str:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("環境変数 ANTHROPIC_API_KEY が未設定です")
    if images:
        content = [_image_block(p) for p in images] + [{"type": "text", "text": user}]
    else:
        content = user
    payload = {
        "model": model,
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{"role": "user", "content": content}],
    }
    req = urllib.request.Request(
        API_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "content-type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        },
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=300) as res:
                body = json.loads(res.read().decode("utf-8"))
            return "\n".join(b["text"] for b in body["content"] if b.get("type") == "text")
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="replace")[:300]
            if e.code in (429, 500, 502, 503, 529) and attempt < 2:
                time.sleep(2 ** (attempt + 1))
                continue
            raise RuntimeError(f"Claude API error {e.code}: {detail}") from e
    raise RuntimeError("Claude API: リトライ上限に達しました")


def parse_json_loose(text: str):
    """LLMの返答からJSONを寛容に取り出す。```json フェンスや前後の文を無視する。"""
    if text is None:
        raise ValueError("empty response")
    s = str(text).strip().replace("```json", "").replace("```", "")
    starts = [i for i in (s.find("["), s.find("{")) if i >= 0]
    if not starts:
        raise ValueError(f"no JSON found in: {s[:200]}")
    start = min(starts)
    closer = "]" if s[start] == "[" else "}"
    end = s.rfind(closer)
    if end <= start:
        raise ValueError(f"unbalanced JSON in: {s[:200]}")
    return json.loads(s[start : end + 1])


def ask_claude_json(system: str, user: str, max_tokens: int = 4000,
                    model: str = "claude-sonnet-5", images: list | None = None):
    """JSONを返させる呼び出し。パース失敗時は1回だけリトライ。"""
    suffix = "\n\n出力はJSONのみ。前置きや説明は書かない。"
    for attempt in range(2):
        text = ask_claude(system, user + suffix, max_tokens, model, images=images)
        try:
            return parse_json_loose(text)
        except (ValueError, json.JSONDecodeError):
            if attempt == 1:
                raise RuntimeError(f"ClaudeのJSONパースに失敗: {text[:300]}")
