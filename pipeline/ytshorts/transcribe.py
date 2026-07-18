"""transcribe.py — faster-whisper による単語タイムスタンプ付き文字起こし。"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from .config import Config


def probe_dimensions(video: Path) -> tuple[int, int]:
    """表示上の幅・高さを返す（スマホ動画の回転メタデータも考慮）。"""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height:stream_side_data=rotation",
         "-of", "json", str(video)],
        capture_output=True, text=True, check=True,
    )
    stream = json.loads(out.stdout)["streams"][0]
    w, h = int(stream["width"]), int(stream["height"])
    rotation = 0
    for sd in stream.get("side_data_list") or []:
        if "rotation" in sd:
            rotation = int(sd["rotation"])
    if abs(rotation) % 180 == 90:
        w, h = h, w
    return w, h


def probe_duration(video: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(video)],
        capture_output=True, text=True, check=True,
    )
    return float(out.stdout.strip())


def transcribe(video: Path, cfg: Config) -> dict:
    """動画を文字起こしして {duration, language, segments} を返す。

    segments: [{start, end, text, words: [{start, end, word}]}]
    """
    try:
        from faster_whisper import WhisperModel
    except ImportError as e:
        raise RuntimeError(
            "faster-whisper が見つかりません。`pip install faster-whisper` を実行してください"
        ) from e

    device = cfg.whisper_device
    compute = "auto"
    if device == "auto":
        try:
            import torch  # noqa: F401
            device = "cuda" if torch.cuda.is_available() else "cpu"
        except ImportError:
            device = "cpu"
    if device == "cpu":
        compute = "int8"

    model = WhisperModel(cfg.whisper_model, device=device, compute_type=compute)
    segments, info = model.transcribe(
        str(video),
        language=cfg.language,
        word_timestamps=True,
        vad_filter=True,
    )

    result_segments = []
    for seg in segments:
        result_segments.append({
            "start": round(seg.start, 3),
            "end": round(seg.end, 3),
            "text": seg.text.strip(),
            "words": [
                {"start": round(w.start, 3), "end": round(w.end, 3), "word": w.word}
                for w in (seg.words or [])
            ],
        })

    return {
        "duration": probe_duration(video),
        "language": info.language,
        "segments": result_segments,
    }


def load_or_transcribe(video: Path, session_dir: Path, cfg: Config) -> dict:
    path = session_dir / "transcript.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    data = transcribe(video, cfg)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    return data


def all_words(transcript: dict) -> list[dict]:
    words: list[dict] = []
    for seg in transcript["segments"]:
        words.extend(seg["words"])
    return words


def transcript_as_text(transcript: dict) -> str:
    """Claudeに渡す用: タイムスタンプ付きの読みやすいテキスト。"""
    lines = []
    for seg in transcript["segments"]:
        lines.append(f"[{seg['start']:.1f} - {seg['end']:.1f}] {seg['text']}")
    return "\n".join(lines)
