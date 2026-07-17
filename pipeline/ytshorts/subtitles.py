"""subtitles.py — ASS字幕の生成（純粋ロジック）。

時刻の入力は元動画の秒。keep intervals を使って出力タイムラインへ写してから
イベントを作る。フック（冒頭の大テキスト）とツッコミ（上部のネタ字幕）も
ASSのイベントとして焼き込む。
"""

from __future__ import annotations

from . import cuts

HOOK_DURATION = 2.8


def format_ass_time(seconds: float) -> str:
    seconds = max(0.0, seconds)
    h = int(seconds // 3600)
    m = int(seconds % 3600 // 60)
    s = seconds % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def ass_escape(text: str) -> str:
    return str(text).replace("\\", "\\\\").replace("{", "(").replace("}", ")").replace("\n", "\\N")


def build_ass_header(width: int = 1080, height: int = 1920) -> str:
    # 縦動画用: Caption=下部中央 / Hook=中央上寄りの大テキスト / Tsukkomi=上部の黄色
    return f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Noto Sans CJK JP,72,&H00FFFFFF,&H000000FF,&H00101010,&H96000000,-1,0,0,0,100,100,0,0,1,5,2,2,60,60,340,1
Style: Hook,Noto Sans CJK JP,96,&H0000E6FF,&H000000FF,&H00101010,&H96000000,-1,0,0,0,100,100,0,0,1,7,3,8,60,60,420,1
Style: Tsukkomi,Noto Sans CJK JP,66,&H0000D7FF,&H000000FF,&H00101010,&H96000000,-1,0,0,0,100,100,0,0,1,5,2,8,60,60,700,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def build_events(short: dict, keep: list[tuple[float, float]]) -> list[str]:
    """ショート1本ぶんのASSイベント行を作る（出力タイムライン基準）。"""
    events: list[str] = []

    def dialogue(style: str, start: float, end: float, text: str) -> str:
        return (
            f"Dialogue: 0,{format_ass_time(start)},{format_ass_time(end)},"
            f"{style},,0,0,0,,{ass_escape(text)}"
        )

    if short.get("hook"):
        events.append(dialogue("Hook", 0.0, HOOK_DURATION, short["hook"]))

    for c in short.get("captions") or []:
        span = cuts.map_span(c["start"], c["end"], keep, min_len=0.15)
        if span is None:
            continue  # 字幕対象の発話ごとカットされた
        events.append(dialogue("Caption", span[0], span[1], c["text"]))

    for o in short.get("overlays") or []:
        t = cuts.map_time(o["time"], keep)
        events.append(dialogue("Tsukkomi", t, t + float(o.get("duration", 2.5)), o["text"]))

    return events


def build_ass(short: dict, keep: list[tuple[float, float]], width: int = 1080, height: int = 1920) -> str:
    return build_ass_header(width, height) + "\n".join(build_events(short, keep)) + "\n"
