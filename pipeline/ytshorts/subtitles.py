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


def ass_color(hex_color: str) -> str:
    """'#RRGGBB' をASSの '&H00BBGGRR' 形式に変換する（純粋）。"""
    h = str(hex_color).lstrip("#")
    if len(h) != 6:
        return "&H00FFFFFF"
    r, g, b = h[0:2], h[2:4], h[4:6]
    return f"&H00{b}{g}{r}".upper()


def build_ass_header(
    width: int = 1080,
    height: int = 1920,
    font: str = "Noto Sans CJK JP",
    caption_color: str = "#FFFFFF",
    hook_color: str = "#FFE600",
    tsukkomi_color: str = "#FFD700",
    title_color: str = "#FFFFFF",
) -> str:
    # Caption=下部中央 / Hook=中央上寄りの大テキスト / Tsukkomi=上部のネタ字幕 /
    # Title=上帯の常時タイトル（fitレイアウト用）。余白は高さに比例させる
    mv_caption = round(height * 0.177)
    mv_hook = round(height * 0.219)
    mv_tsukkomi = round(height * 0.365)
    mv_title = round(height * 0.055)
    return f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,{font},72,{ass_color(caption_color)},&H000000FF,&H00101010,&H96000000,-1,0,0,0,100,100,0,0,1,5,2,2,60,60,{mv_caption},1
Style: Hook,{font},96,{ass_color(hook_color)},&H000000FF,&H00101010,&H96000000,-1,0,0,0,100,100,0,0,1,7,3,8,60,60,{mv_hook},1
Style: Tsukkomi,{font},66,{ass_color(tsukkomi_color)},&H000000FF,&H00101010,&H96000000,-1,0,0,0,100,100,0,0,1,5,2,8,60,60,{mv_tsukkomi},1
Style: Title,{font},84,{ass_color(title_color)},&H000000FF,&H00101010,&H96000000,-1,0,0,0,100,100,0,0,1,4,2,8,60,60,{mv_title},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def build_events(short: dict, keep: list[tuple[float, float]], layout: str = "crop") -> list[str]:
    """ショート1本ぶんのASSイベント行を作る（出力タイムライン基準）。

    layout='fit' のときは上帯にタイトルを常時表示する。
    """
    events: list[str] = []

    def dialogue(style: str, start: float, end: float, text: str) -> str:
        return (
            f"Dialogue: 0,{format_ass_time(start)},{format_ass_time(end)},"
            f"{style},,0,0,0,,{ass_escape(text)}"
        )

    if layout == "fit" and short.get("title"):
        total = cuts.total_kept(keep) or 3600.0
        events.append(dialogue("Title", 0.0, total, short["title"]))

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


def build_ass(
    short: dict,
    keep: list[tuple[float, float]],
    width: int = 1080,
    height: int = 1920,
    layout: str = "crop",
    **style,
) -> str:
    return build_ass_header(width, height, **style) + "\n".join(build_events(short, keep, layout)) + "\n"
