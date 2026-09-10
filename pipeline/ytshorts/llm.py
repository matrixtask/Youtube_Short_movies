"""Provider routing for editing, SVG illustration and vision review.

auto selects Astra when OPENAI_API_KEY is set, otherwise the legacy Claude client.
An API error never switches providers. Uses only the standard library.
"""

from __future__ import annotations

import base64
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

from . import claude
from .config import Config

OPENAI_URL = "https://api.openai.com/v1/responses"
REASONING_EFFORTS = ("low", "medium", "high", "xhigh", "max")


def provider(cfg: Config) -> str:
    value = cfg.llm_provider.strip().lower()
    if value == "auto":
        return "openai" if os.environ.get("OPENAI_API_KEY", "").strip() else "anthropic"
    if value not in ("openai", "anthropic"):
        raise RuntimeError("llm_provider は auto / openai / anthropic を指定してください")
    return value


def identity(cfg: Config) -> dict:
    selected = provider(cfg)
    return {
        "provider": selected,
        "model": cfg.openai_model if selected == "openai" else cfg.claude_model,
        "reasoning": cfg.openai_reasoning_effort if selected == "openai" else "",
    }


def response_text(body: dict) -> str:
    # Never accept truncated JSON/SVG or a refusal as a usable edit plan.
    if not isinstance(body, dict) or body.get("status") != "completed":
        raise RuntimeError("OpenAI response was not completed")
    chunks = []
    for item in body.get("output", []):
        if item.get("type") != "message":
            continue
        for part in item.get("content", []):
            if part.get("type") == "refusal":
                raise RuntimeError("OpenAI declined this request")
            if part.get("type") == "output_text":
                chunks.append(part["text"])
    text = "\n".join(chunks).strip()
    if not text:
        raise RuntimeError("OpenAI response contained no output text")
    return text


def ask_openai(system: str, user: str, cfg: Config, max_tokens: int,
               images: list | None = None) -> str:
    key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not key:
        raise RuntimeError("環境変数 OPENAI_API_KEY が未設定です")
    if cfg.openai_reasoning_effort not in REASONING_EFFORTS:
        raise RuntimeError("openai_reasoning_effort は low / medium / high / xhigh / max を指定してください")
    content = [{"type": "input_text", "text": user}]
    for image in images or []:
        path = Path(image)
        media = "image/png" if path.suffix.lower() == ".png" else "image/jpeg"
        data = base64.b64encode(path.read_bytes()).decode("ascii")
        content.append({"type": "input_image", "image_url": f"data:{media};base64,{data}",
                        "detail": "auto"})
    payload = {
        "model": cfg.openai_model,
        "instructions": system,
        "input": [{"role": "user", "content": content}],
        "reasoning": {"effort": cfg.openai_reasoning_effort},
        # Responses counts reasoning tokens in this limit as well as visible output.
        "max_output_tokens": max(12000, max_tokens + 8000),
        "store": False,
    }
    request = urllib.request.Request(
        OPENAI_URL, data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=300) as res:
                return response_text(json.loads(res.read().decode("utf-8")))
        except urllib.error.HTTPError as error:
            error.close()
            if error.code in (429, 500, 502, 503, 504) and attempt < 2:
                time.sleep(2 ** (attempt + 1))
                continue
            # Error bodies can echo credentials/input. Keep them out of Slack/logs.
            raise RuntimeError(f"OpenAI API error HTTP {error.code}") from None
        except (urllib.error.URLError, TimeoutError):
            raise RuntimeError("OpenAI API connection failed or timed out") from None
    raise RuntimeError("OpenAI API: リトライ上限に達しました")


def ask_text(system: str, user: str, cfg: Config, max_tokens: int = 4000,
             images: list | None = None) -> str:
    if provider(cfg) == "openai":
        return ask_openai(system, user, cfg, max_tokens, images)
    return claude.ask_claude(system, user, max_tokens, cfg.claude_model, images=images)


def ask_json(system: str, user: str, cfg: Config, max_tokens: int = 4000,
             images: list | None = None):
    for attempt in range(2):
        text = ask_text(system, user + "\n\n出力はJSONのみ。前置きや説明は書かない。",
                        cfg, max_tokens, images)
        try:
            return claude.parse_json_loose(text)
        except ValueError:
            if attempt == 1:
                raise RuntimeError("AIのJSONパースに失敗しました") from None
