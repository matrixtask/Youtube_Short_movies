"""illustrations.py — Astra/Claude に SVG の挿絵を描かせて PNG 化する。

画像生成APIに依存せず、AI が出力するフラットなベクターイラストを使う。
PNG化は cairosvg → rsvg-convert → inkscape の順で試し、どれも無ければ
その挿絵はスキップされる（動画は挿絵なしで完成する）。
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
from pathlib import Path

from .llm import ask_text, identity
from .config import Config

SVG_SYSTEM = """あなたはYouTubeショート向けの挿絵を描くイラストレーターです。
指示された場面を1枚のSVGで描きます。

ルール:
- <svg> 開始タグから </svg> 終了タグまでのみ出力する。説明文は書かない
- viewBox="0 0 900 900"、背景は透過（背景の矩形を描かない）
- フラットデザイン。太い輪郭線(stroke)、はっきりした色、シンプルな形
- 遠目でも伝わる大きなモチーフ1〜2個。細かすぎる描写はしない
- 文字は入れない。絵だけで伝える（環境によりフォントが崩れるため）。
  どうしても必要なら数字か記号だけにし、
  font-family="Noto Sans CJK JP, Noto Sans JP, sans-serif" を必ず指定する"""


def extract_svg(text: str) -> str | None:
    m = re.search(r"<svg[\s\S]*?</svg>", text)
    return m.group(0) if m else None


def svg_to_png(svg_path: Path, png_path: Path, size: int = 900) -> bool:
    try:
        import cairosvg
        cairosvg.svg2png(url=str(svg_path), write_to=str(png_path),
                         output_width=size, output_height=size)
        return True
    except ImportError:
        pass
    except Exception:
        return False
    for cmd in (
        ["rsvg-convert", "-w", str(size), "-h", str(size), "-o", str(png_path), str(svg_path)],
        ["inkscape", str(svg_path), "-w", str(size), "-o", str(png_path)],
    ):
        if shutil.which(cmd[0]):
            try:
                subprocess.run(cmd, check=True, capture_output=True)
                return True
            except subprocess.CalledProcessError:
                continue
    return False


def generate_illustrations(short: dict, out_dir: Path, cfg: Config,
                           critique: str = "") -> list[Path | None]:
    """ショートの挿絵を生成してPNGパスのリストを返す（失敗分は None）。

    critique を渡すと既存の挿絵を捨てて描き直す（見た目採点で不合格だったとき）。
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    results: list[Path | None] = []
    for i, ill in enumerate(short.get("illustrations") or []):
        png = out_dir / f"{short['id']}_ill{i}.png"
        svg_path = out_dir / f"{short['id']}_ill{i}.svg"
        cache_key_path = out_dir / f"{short['id']}_ill{i}.cache-key"
        cache_key = hashlib.sha256(json.dumps(
            {"ai": identity(cfg), "prompt": ill["prompt"]}, sort_keys=True,
        ).encode("utf-8")).hexdigest()
        if critique:
            png.unlink(missing_ok=True)
            svg_path.unlink(missing_ok=True)
        legacy_cache = not cache_key_path.exists() and identity(cfg)["provider"] == "anthropic"
        if png.exists() and (legacy_cache or (
            cache_key_path.exists() and cache_key_path.read_text() == cache_key
        )):
            results.append(png)
            continue
        prompt = "場面: " + ill["prompt"]
        if critique:
            prompt += ("\n\n前回の絵は品質チェックで不合格でした。指摘: " + critique +
                       "\n指摘を避けて、よりシンプルで崩れない絵にしてください。")
        try:
            text = ask_text(SVG_SYSTEM, prompt, cfg, max_tokens=4000)
            svg = extract_svg(text)
        except RuntimeError:
            svg = None
        if not svg:
            results.append(None)
            continue
        svg_path.write_text(svg, encoding="utf-8")
        if svg_to_png(svg_path, png):
            cache_key_path.write_text(cache_key, encoding="ascii")
            results.append(png)
        else:
            results.append(None)
    return results
