"""planner.py — Claude による編集プラン生成と、その正規化（純粋ロジック）。

プランのスキーマ（時刻はすべて元動画の秒）:
{
  "shorts": [
    {
      "id": "s1",
      "title": "ショートのタイトル案",
      "hook": "冒頭0-2.5秒に大きく出すフックテキスト",
      "clip": {"start": 12.3, "end": 55.0},
      "extra_cuts": [{"start": 20.1, "end": 21.4, "reason": "言い直し"}],
      "captions": [{"start": 13.0, "end": 15.2, "text": "字幕テキスト"}],
      "overlays": [{"time": 30.2, "duration": 2.5, "text": "ツッコミ・ネタ字幕"}],
      "illustrations": [{"time": 40.0, "duration": 3.0, "prompt": "挿絵の内容"}],
      "score": 82,
      "score_reason": "..."
    }
  ]
}
"""

from __future__ import annotations

import json

from .claude import ask_claude_json
from .config import Config
from .transcribe import transcript_as_text

PLANNER_SYSTEM = """あなたはYouTubeショート専門の動画編集者です。
撮りっぱなしのインタビュー回答動画の文字起こし（タイムスタンプ付き）から、
バズるショート動画の編集プランをJSONで出力します。

編集方針:
- 1つの質問への回答 = 1本のショート。話が良ければ1回答から複数本切り出してもよい
- clip は話のまとまりで切る。冒頭は結論やフックになる一言から始まるように選ぶ
- extra_cuts で言い直し・噛み・「えー」「あのー」などのフィラー・脱線を刻んでカットする
  （無音の間は自動でカットされるので、無音カットの指示は不要）
- captions は発話に沿った字幕。1行15文字以内、話し言葉を整えすぎない
- overlays はツッコミ・補足・ネタ字幕（画面上部に出る）。笑いどころや強調に1本あたり1〜3個
- illustrations は挿絵カット（イラストが2〜4秒表示される）。話の具体物・たとえ話・
  感情が動く場面に1本あたり1〜2個。prompt はイラストレーターへの日本語指示
- score は0-100。フックの強さ・話のオチ・テンポで採点。凡庸な回答は低くてよい

時刻は必ず文字起こしのタイムスタンプの範囲内で指定する。"""


def build_planner_prompt(transcript: dict, cfg: Config, script_questions: list[dict] | None) -> str:
    parts = []
    if script_questions:
        parts.append("この動画は以下の質問に答えたものです（台本）:")
        for q in script_questions:
            line = f"Q{q.get('idx')}. {q.get('question')}"
            if q.get("neta"):
                line += f"（ネタ指示: {q['neta']}）"
            parts.append(line)
        parts.append("")
    parts.append("文字起こし（[開始秒 - 終了秒] テキスト）:")
    parts.append(transcript_as_text(transcript))
    parts.append("")
    parts.append(
        f"各ショートはカット後 {cfg.short_min_sec:.0f}〜{cfg.short_max_sec:.0f} 秒に収める。"
        "できるだけ多くのショートを切り出す（質の低いものも score を付けて出す）。"
    )
    parts.append(
        'JSONで出力: {"shorts": [{"id", "title", "hook", "clip": {"start", "end"}, '
        '"extra_cuts": [{"start", "end", "reason"}], "captions": [{"start", "end", "text"}], '
        '"overlays": [{"time", "duration", "text"}], '
        '"illustrations": [{"time", "duration", "prompt"}], "score", "score_reason"}]}'
    )
    return "\n".join(parts)


def build_planner_system(cfg: Config) -> str:
    system = PLANNER_SYSTEM
    system += (
        f"\n\nこの動画はYouTubeチャンネル「{cfg.channel_concept}」のコンテンツです。"
        "タイトル・フック・ツッコミ・挿絵はチャンネルの文脈とトーンに合わせること。"
    )
    if cfg.style_notes:
        system += "\n\n編集テイストの指示（必ず従う）:\n" + cfg.style_notes
    return system


def generate_plan(transcript: dict, cfg: Config, script_questions: list[dict] | None = None) -> dict:
    raw = ask_claude_json(
        build_planner_system(cfg),
        build_planner_prompt(transcript, cfg, script_questions),
        max_tokens=16000,
        model=cfg.claude_model,
    )
    return normalize_plan(raw, transcript["duration"])


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def normalize_plan(plan: dict, duration: float) -> dict:
    """Claudeの出力を検証・補正する。壊れたショートは捨てる。"""
    shorts = []
    for i, s in enumerate(plan.get("shorts") or []):
        try:
            clip = s["clip"]
            start = _clamp(float(clip["start"]), 0.0, duration)
            end = _clamp(float(clip["end"]), 0.0, duration)
        except (KeyError, TypeError, ValueError):
            continue
        if end - start < 3.0:
            continue

        def in_clip(t: float) -> float:
            return _clamp(float(t), start, end)

        extra_cuts = []
        for c in s.get("extra_cuts") or []:
            try:
                cs, ce = in_clip(c["start"]), in_clip(c["end"])
            except (KeyError, TypeError, ValueError):
                continue
            if ce > cs:
                extra_cuts.append({"start": cs, "end": ce, "reason": str(c.get("reason", ""))})

        captions = []
        for c in s.get("captions") or []:
            try:
                cs, ce = in_clip(c["start"]), in_clip(c["end"])
                text = str(c["text"]).strip()
            except (KeyError, TypeError, ValueError):
                continue
            if ce > cs and text:
                captions.append({"start": cs, "end": ce, "text": text})
        captions.sort(key=lambda c: c["start"])

        overlays = []
        for o in s.get("overlays") or []:
            try:
                t = in_clip(o["time"])
                dur = _clamp(float(o.get("duration", 2.5)), 0.5, 6.0)
                text = str(o["text"]).strip()
            except (KeyError, TypeError, ValueError):
                continue
            if text:
                overlays.append({"time": t, "duration": dur, "text": text})

        illustrations = []
        for o in s.get("illustrations") or []:
            try:
                t = in_clip(o["time"])
                dur = _clamp(float(o.get("duration", 3.0)), 1.0, 6.0)
                prompt = str(o["prompt"]).strip()
            except (KeyError, TypeError, ValueError):
                continue
            if prompt:
                illustrations.append({"time": t, "duration": dur, "prompt": prompt})

        try:
            score = int(_clamp(float(s.get("score", 0)), 0, 100))
        except (TypeError, ValueError):
            score = 0

        shorts.append({
            "id": str(s.get("id") or f"s{i + 1}"),
            "title": str(s.get("title") or "").strip() or f"short {i + 1}",
            "hook": str(s.get("hook") or "").strip(),
            "clip": {"start": start, "end": end},
            "extra_cuts": extra_cuts,
            "captions": captions,
            "overlays": overlays,
            "illustrations": illustrations,
            "score": score,
            "score_reason": str(s.get("score_reason") or ""),
        })
    return {"shorts": shorts}


def load_or_generate_plan(transcript: dict, session_dir, cfg: Config, script_questions=None) -> dict:
    path = session_dir / "plan.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    plan = generate_plan(transcript, cfg, script_questions)
    path.write_text(json.dumps(plan, ensure_ascii=False, indent=1), encoding="utf-8")
    return plan
