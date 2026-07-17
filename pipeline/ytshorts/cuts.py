"""cuts.py — 「変な間」を消すためのカット区間計算（純粋ロジック）。

すべての時刻は元動画の秒。keep intervals = 残す区間のリスト [(start, end), ...]。
文字起こしの単語タイムスタンプから発話の塊を検出し、塊の間の沈黙を詰める。
"""

from __future__ import annotations


def merge_intervals(intervals: list[tuple[float, float]], gap: float = 0.0) -> list[tuple[float, float]]:
    """重なり・gap秒以内で隣接する区間をまとめる。"""
    valid = sorted((s, e) for s, e in intervals if e > s)
    merged: list[tuple[float, float]] = []
    for s, e in valid:
        if merged and s <= merged[-1][1] + gap:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))
    return merged


def build_keep_intervals(
    words: list[dict],
    clip_start: float,
    clip_end: float,
    max_pause: float = 0.5,
    pad: float = 0.15,
    min_run: float = 0.25,
) -> list[tuple[float, float]]:
    """単語タイムスタンプから残す区間を作る。

    max_pause 秒を超える単語間の沈黙をカットし、発話の塊の前後に pad 秒残す。
    min_run 秒未満の孤立した発話（咳・ノイズの誤検出など）は捨てる。
    words が空なら clip 全体を残す（沈黙検出できないときに壊さない）。
    """
    ws = [w for w in words if clip_start <= float(w["start"]) and float(w["end"]) <= clip_end]
    if not ws:
        return [(clip_start, clip_end)] if clip_end > clip_start else []

    runs: list[tuple[float, float]] = []
    run_start = float(ws[0]["start"])
    run_end = float(ws[0]["end"])
    for w in ws[1:]:
        s, e = float(w["start"]), float(w["end"])
        if s - run_end > max_pause:
            runs.append((run_start, run_end))
            run_start = s
        run_end = max(run_end, e)
    runs.append((run_start, run_end))

    runs = [(s, e) for s, e in runs if e - s >= min_run]
    padded = [(max(clip_start, s - pad), min(clip_end, e + pad)) for s, e in runs]
    return merge_intervals(padded)


def subtract_intervals(
    keep: list[tuple[float, float]], cuts: list[tuple[float, float]]
) -> list[tuple[float, float]]:
    """keep から cuts（言い直し・NG部分など）を取り除く。"""
    result = list(merge_intervals(keep))
    for cs, ce in merge_intervals(cuts):
        next_result: list[tuple[float, float]] = []
        for s, e in result:
            if ce <= s or cs >= e:
                next_result.append((s, e))
                continue
            if s < cs:
                next_result.append((s, cs))
            if ce < e:
                next_result.append((ce, e))
        result = next_result
    return [(s, e) for s, e in result if e - s > 0.01]


def total_kept(keep: list[tuple[float, float]]) -> float:
    return sum(e - s for s, e in keep)


def map_time(t: float, keep: list[tuple[float, float]]) -> float:
    """元動画の時刻 t を、カット後の出力タイムラインの時刻に写す。

    t がカット済み区間の中にある場合は、直後に残る映像の位置に丸める。
    """
    out = 0.0
    for s, e in keep:
        if t < s:
            return out
        if t <= e:
            return out + (t - s)
        out += e - s
    return out


def map_span(
    start: float, end: float, keep: list[tuple[float, float]], min_len: float = 0.0
) -> tuple[float, float] | None:
    """区間 [start, end] を出力タイムラインへ写す。カットで潰れて min_len 未満なら None。"""
    a = map_time(start, keep)
    b = map_time(end, keep)
    if b - a < min_len:
        return None
    return (a, b)
