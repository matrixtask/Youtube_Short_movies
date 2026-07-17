"""compilation.py — 撮りためたショートを1本のまとめ動画（16:9）に繋ぐ。

縦のショートをぼかし背景つきのピラーボックスで 1920x1080 に載せ、
チャプター用のタイムスタンプ一覧も出力する。
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from .transcribe import probe_duration


def build_compilation_filter(
    n: int, width: int = 1920, height: int = 1080, fps: int = 30
) -> str:
    """n本のショートを繋ぐ filter_complex（純粋）。"""
    if n < 1:
        raise ValueError("ショートが0本です")
    parts: list[str] = []
    for i in range(n):
        parts.append(
            f"[{i}:v]scale={width}:{height}:force_original_aspect_ratio=increase,"
            f"crop={width}:{height},boxblur=luma_radius=40:luma_power=2[bg{i}]"
        )
        parts.append(f"[{i}:v]scale=-2:{height}[fg{i}]")
        parts.append(
            f"[bg{i}][fg{i}]overlay=(W-w)/2:0,fps={fps},setsar=1[v{i}]"
        )
        parts.append(
            f"[{i}:a]aformat=sample_rates=48000:channel_layouts=stereo[a{i}]"
        )
    pairs = "".join(f"[v{i}][a{i}]" for i in range(n))
    parts.append(f"{pairs}concat=n={n}:v=1:a=1[vout][aout]")
    return ";".join(parts)


def format_chapter_time(seconds: float) -> str:
    m, s = divmod(int(seconds), 60)
    h, m = divmod(m, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def build_chapters(entries: list[dict], durations: list[float]) -> str:
    """YouTube概要欄に貼るチャプターリストを作る（純粋）。"""
    lines = []
    t = 0.0
    for entry, dur in zip(entries, durations):
        lines.append(f"{format_chapter_time(t)} {entry.get('title', entry.get('file', ''))}")
        t += dur
    return "\n".join(lines)


def compile_shorts(entries: list[dict], shorts_dir: Path, out_path: Path) -> str:
    """ショートを1本に繋いでレンダリングし、チャプター文字列を返す。"""
    files = [shorts_dir / e["file"] for e in entries]
    cmd = ["ffmpeg", "-y"]
    for f in files:
        cmd += ["-i", str(f)]
    cmd += [
        "-filter_complex", build_compilation_filter(len(files)),
        "-map", "[vout]", "-map", "[aout]",
        "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        str(out_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed:\n{proc.stderr[-2000:]}")

    durations = [probe_duration(f) for f in files]
    chapters = build_chapters(entries, durations)
    out_path.with_suffix(".chapters.txt").write_text(chapters + "\n", encoding="utf-8")
    return chapters
