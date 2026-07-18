"""render.py — ffmpeg によるショートのレンダリング。

filter_complex の組み立ては純粋関数（テスト対象）、実行は subprocess。
流れ: カット区間だけ trim/concat → 9:16 に整形 → ASS字幕焼き込み → 挿絵overlay。
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from .config import Config


def escape_filter_path(path: str) -> str:
    """ffmpegフィルタ引数内のパスをエスケープする（ass=... 用）。"""
    return str(path).replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


def build_filter_complex(
    keep: list[tuple[float, float]],
    subs_path: str | None,
    illustrations: list[tuple[int, float, float]],
    width: int = 1080,
    height: int = 1920,
    fps: int = 30,
) -> str:
    """ショート1本ぶんの filter_complex を組み立てる。

    keep          : 残す区間（元動画の秒）
    subs_path     : ASSファイルのパス（Noneなら字幕なし）
    illustrations : [(入力インデックス, 出力開始秒, 出力終了秒), ...]
                    入力インデックスは ffmpeg コマンドの -i の並び（動画が0）
    """
    if not keep:
        raise ValueError("keep intervals が空です")
    parts: list[str] = []
    for i, (s, e) in enumerate(keep):
        parts.append(f"[0:v]trim=start={s:.3f}:end={e:.3f},setpts=PTS-STARTPTS[v{i}]")
        parts.append(f"[0:a]atrim=start={s:.3f}:end={e:.3f},asetpts=PTS-STARTPTS[a{i}]")
    pairs = "".join(f"[v{i}][a{i}]" for i in range(len(keep)))
    parts.append(f"{pairs}concat=n={len(keep)}:v=1:a=1[vcut][acut]")

    chain = (
        f"[vcut]scale={width}:{height}:force_original_aspect_ratio=increase,"
        f"crop={width}:{height},fps={fps},setsar=1"
    )
    label = "vfmt"
    parts.append(f"{chain}[{label}]")

    if subs_path:
        parts.append(f"[{label}]ass='{escape_filter_path(subs_path)}'[vsub]")
        label = "vsub"

    for k, (idx, start, end) in enumerate(illustrations):
        parts.append(f"[{idx}:v]scale={int(width * 0.8)}:-1[ill{k}]")
        parts.append(
            f"[{label}][ill{k}]overlay=(W-w)/2:(H-h)/2-{int(height * 0.12)}"
            f":enable='between(t,{start:.3f},{end:.3f})'[vov{k}]"
        )
        label = f"vov{k}"

    parts.append(f"[{label}]null[vout]")
    return ";".join(parts)


def build_short_command(
    video: Path,
    keep: list[tuple[float, float]],
    subs_path: Path | None,
    illustration_files: list[tuple[Path, float, float]],
    out_path: Path,
    cfg: Config,
    size: tuple[int, int] | None = None,
) -> list[str]:
    """ffmpeg コマンド全体を組み立てる（純粋）。size で出力解像度を上書きできる。"""
    width, height = size or (cfg.width, cfg.height)
    cmd = ["ffmpeg", "-y", "-i", str(video)]
    specs: list[tuple[int, float, float]] = []
    for i, (png, start, end) in enumerate(illustration_files):
        cmd += ["-i", str(png)]
        specs.append((i + 1, start, end))
    fc = build_filter_complex(
        keep,
        str(subs_path) if subs_path else None,
        specs,
        width,
        height,
        cfg.fps,
    )
    cmd += [
        "-filter_complex", fc,
        "-map", "[vout]", "-map", "[acut]",
        "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        str(out_path),
    ]
    return cmd


def render_short(
    video: Path,
    keep: list[tuple[float, float]],
    subs_path: Path | None,
    illustration_files: list[tuple[Path, float, float]],
    out_path: Path,
    cfg: Config,
    size: tuple[int, int] | None = None,
) -> None:
    cmd = build_short_command(video, keep, subs_path, illustration_files, out_path, cfg, size)
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed:\n{proc.stderr[-2000:]}")
