"""review.py — レンダリング済みショートの見た目の自己採点と作り直し判断。

レンダリング後にフレームを抜き、Claude(vision)に「テロップ」「挿絵」を
採点させる。合格点未満なら:
  - テロップ → 文字サイズ・位置の調整アクションをスタイルに適用して再レンダリング
  - 挿絵     → 批評つきでSVGを再生成 or 縮小して再レンダリング
サムネイルは複数フレーム候補を採点させ、最高点のフレームを採用する。

判断ロジック（時刻選定・アクション適用・結果の正規化）は純粋関数にして
テストし、ffmpeg・Claude呼び出しだけを副作用にしている。
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from .claude import ask_claude_json
from .config import Config

TELOP_ACTIONS = ("keep", "font_smaller", "font_bigger", "move_up", "move_down")
ILL_ACTIONS = ("keep", "regenerate", "smaller")

REVIEW_SYSTEM = """あなたはYouTubeショートの映像品質チェッカーです。
渡されるのはレンダリング済みショートの数フレームです。
「テロップ」と「挿絵」を別々に0-100で採点します。70点が合格ラインです。

採点基準:
- テロップ: 読みやすさ（サイズ・行数）、話者の顔・口元に被っていないか、
  画面からはみ出していないか、文字化け（□・意味不明な記号）がないか
- 挿絵: 文字化けや描画崩れがないか、顔に被らず空きスペースに収まっているか、
  大きすぎ・小さすぎないか。挿絵が写っているフレームが無ければ score は null

JSONで出力:
{"telop": {"score": 0-100, "critique": "問題点を1文", "action": "keep|font_smaller|font_bigger|move_up|move_down"},
 "illustration": {"score": 0-100またはnull, "critique": "問題点を1文", "action": "keep|regenerate|smaller"}}
合格でも改善余地は critique に書く。action は不合格のときだけ keep 以外にする。"""

THUMB_SYSTEM = """あなたはYouTubeショートのサムネイル選定者です。
渡される候補フレームを「サムネイルとしての良さ」で0-100採点します。
基準: 表情が生きているか（目が開いている・話の熱が見える）、ブレ・ボケがないか、
テロップが読めるか、クリックしたくなるか。

JSONで出力: {"scores": [候補1の点, 候補2の点, ...]}（候補の数と同じ長さ）"""


# ---- 純粋ロジック ----------------------------------------------------------

def pick_review_times(out_dur: float, ill_files: list[tuple]) -> list[float]:
    """採点用に抜くフレームの時刻（出力タイムライン）。フック・挿絵・本編の3枚まで。"""
    times = [min(0.6, out_dur * 0.5)]
    if ill_files:
        _, s, e = ill_files[0] if len(ill_files[0]) == 3 else (None, ill_files[0][1], ill_files[0][2])
        times.append(max(0.0, min((s + e) / 2, out_dur - 0.1)))
    times.append(out_dur * 0.55)
    uniq: list[float] = []
    for t in times:
        r = round(t, 1)
        if r not in uniq:
            uniq.append(r)
    return uniq[:3]


def thumb_candidate_times(out_dur: float, round2: bool = False) -> list[float]:
    """サムネ候補フレームの時刻。round2は1巡目が全滅だったときの別候補。"""
    ratios = (0.25, 0.55, 0.85) if round2 else (0.1, 0.4, 0.7)
    return [round(out_dur * r, 2) for r in ratios]


def apply_telop_action(style: dict, action: str) -> dict:
    """採点結果のアクションをASSスタイルへ反映した新しいdictを返す（純粋）。"""
    s = dict(style)
    size = int(s.get("caption_fontsize", 72))
    margin = float(s.get("caption_margin", 0.177))
    if action == "font_smaller":
        s["caption_fontsize"] = max(40, int(size * 0.85))
    elif action == "font_bigger":
        s["caption_fontsize"] = min(110, int(size * 1.15))
    elif action == "move_up":
        s["caption_margin"] = min(0.45, round(margin + 0.05, 3))
    elif action == "move_down":
        s["caption_margin"] = max(0.05, round(margin - 0.05, 3))
    return s


def _clamp_score(v):
    if v is None:
        return None
    try:
        return max(0, min(100, int(v)))
    except (TypeError, ValueError):
        return None


def normalize_review(raw: dict) -> dict:
    """visionの返答を安全な形に正規化する（純粋）。"""
    raw = raw if isinstance(raw, dict) else {}
    telop = raw.get("telop") or {}
    ill = raw.get("illustration") or {}
    t_action = str(telop.get("action") or "keep")
    i_action = str(ill.get("action") or "keep")
    t_score = _clamp_score(telop.get("score"))
    return {
        "telop": {
            # テロップは必ず数値にする（採点不能=0はループ側で「直せる指摘なし」として止まる）
            "score": 0 if t_score is None else t_score,
            "critique": str(telop.get("critique") or ""),
            "action": t_action if t_action in TELOP_ACTIONS else "keep",
        },
        "illustration": {
            "score": _clamp_score(ill.get("score")),
            "critique": str(ill.get("critique") or ""),
            "action": i_action if i_action in ILL_ACTIONS else "keep",
        },
    }


def review_passed(review: dict, threshold: int) -> bool:
    """テロップと挿絵（採点があるとき）の両方が合格点か（純粋）。"""
    if review["telop"]["score"] < threshold:
        return False
    ill = review["illustration"]["score"]
    return ill is None or ill >= threshold


# ---- 副作用（ffmpeg / Claude） ---------------------------------------------

def extract_frame(video: Path, t: float, out_path: Path, width: int = 480) -> bool:
    proc = subprocess.run(
        ["ffmpeg", "-y", "-ss", f"{max(0.0, t):g}", "-i", str(video),
         "-frames:v", "1", "-vf", f"scale={width}:-2", "-q:v", "5", str(out_path)],
        capture_output=True,
    )
    return proc.returncode == 0 and out_path.exists()


def review_short(rendered: Path, out_dur: float, ill_files: list[tuple],
                 work_dir: Path, cfg: Config) -> dict | None:
    """レンダリング済みショートを採点する。vision失敗時は None（採点なしで続行）。"""
    frames = []
    for i, t in enumerate(pick_review_times(out_dur, ill_files)):
        f = work_dir / f"review_{i}.jpg"
        if extract_frame(rendered, t, f):
            frames.append(f)
    if not frames:
        return None
    try:
        raw = ask_claude_json(REVIEW_SYSTEM, "このショートを採点してください。",
                              max_tokens=1000, model=cfg.claude_model, images=frames)
        return normalize_review(raw)
    except RuntimeError:
        return None


def best_thumbnail_time(rendered: Path, out_dur: float, work_dir: Path, cfg: Config) -> float:
    """サムネに一番良いフレームの時刻を返す。全滅なら別候補でもう1巡し、最高点を採用。"""
    best_t, best_score = 1.0, -1
    for round2 in (False, True):
        cands = []
        for i, t in enumerate(thumb_candidate_times(out_dur, round2)):
            f = work_dir / f"thumbcand_{int(round2)}_{i}.jpg"
            if extract_frame(rendered, t, f, width=360):
                cands.append((t, f))
        if not cands:
            break
        try:
            raw = ask_claude_json(
                THUMB_SYSTEM, f"候補は{len(cands)}枚です。", max_tokens=300,
                model=cfg.claude_model, images=[f for _, f in cands])
            scores = [(_clamp_score(s) or 0) for s in (raw.get("scores") or [])]
        except RuntimeError:
            return best_t if best_score >= 0 else 1.0
        for (t, _), s in zip(cands, scores):
            if s > best_score:
                best_t, best_score = t, s
        if best_score >= cfg.visual_threshold:
            break  # 合格点のフレームが見つかったら十分
    return best_t
