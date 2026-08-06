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


def band_color_arg(hex_color: str) -> str:
    """'#RRGGBB' をffmpegのcolor引数 '0xRRGGBB' にする（純粋）。"""
    h = str(hex_color).lstrip("#")
    return f"0x{h}" if len(h) == 6 else "0x101820"


def build_filter_complex(
    keep: list[tuple[float, float]],
    subs_path: str | None,
    illustrations: list[tuple[int, float, float]],
    width: int = 1080,
    height: int = 1920,
    fps: int = 30,
    fit: bool = False,
    band_color: str = "#101820",
    video_y: float = 0.42,
    ill_width: float = 0.8,
    ill_y: float = 0.38,
    ill_x: float = 0.5,
) -> str:
    """ショート1本ぶんの filter_complex を組み立てる。

    keep          : 残す区間（元動画の秒）
    subs_path     : ASSファイルのパス（Noneなら字幕なし）
    illustrations : [(入力インデックス, 出力開始秒, 出力終了秒), ...]
                    入力インデックスは ffmpeg コマンドの -i の並び（動画が0）
    fit           : True なら横型ソースを横幅フィットで縮小し、上下を帯で埋める
                    （タイトル・字幕は帯に載る）。False は中央切り抜き
    """
    if not keep:
        raise ValueError("keep intervals が空です")
    parts: list[str] = []
    for i, (s, e) in enumerate(keep):
        parts.append(f"[0:v]trim=start={s:.3f}:end={e:.3f},setpts=PTS-STARTPTS[v{i}]")
        parts.append(f"[0:a]atrim=start={s:.3f}:end={e:.3f},asetpts=PTS-STARTPTS[a{i}]")
    pairs = "".join(f"[v{i}][a{i}]" for i in range(len(keep)))
    parts.append(f"{pairs}concat=n={len(keep)}:v=1:a=1[vcut][acut]")

    if fit:
        # 横幅フィット + 上下帯（既定では映像を中央よりやや上に置き、下の帯を字幕用に広く取る）
        chain = (
            f"[vcut]scale={width}:-2,"
            f"pad={width}:{height}:0:(oh-ih)*{video_y:g}:color={band_color_arg(band_color)},"
            f"fps={fps},setsar=1"
        )
    else:
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
        # 幅は短辺基準にする（縦=幅の80%、横=左右の空きに収まるサイズになる）
        px = int(min(width, height) * ill_width)
        parts.append(f"[{idx}:v]scale={px}:-1[ill{k}]")
        # 挿絵の中心が (ill_x, ill_y)（画面に対する比率）に来るように置く
        x_expr = f"{int(width * ill_x)}-w/2"
        offset = int(height * (0.5 - ill_y))
        parts.append(
            f"[{label}][ill{k}]overlay={x_expr}:(H-h)/2-{offset}"
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
    fit: bool = False,
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
        fit=fit,
        band_color=cfg.band_color,
        video_y=cfg.video_y,
        ill_width=cfg.illustration_width,
        ill_y=cfg.illustration_y,
        ill_x=cfg.illustration_x,
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
    fit: bool = False,
) -> None:
    cmd = build_short_command(video, keep, subs_path, illustration_files, out_path, cfg, size, fit)
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed:\n{proc.stderr[-2000:]}")
