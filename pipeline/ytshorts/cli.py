"""cli.py — ytshorts コマンド。

  ytshorts init                 ワークスペースと設定ファイルを作る
  ytshorts run [動画...]        取り込み〜ショート量産まで一気に実行
  ytshorts compile              溜まったショートを1本のまとめ動画に
  ytshorts list                 ショートのストック一覧
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
from pathlib import Path

from . import compilation, cuts, gasapi, illustrations, planner, render, subtitles
from .config import CONFIG_FILENAME, Config, load_config
from .transcribe import all_words, load_or_transcribe

VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".mkv", ".webm"}


def slugify(text: str, limit: int = 24) -> str:
    s = re.sub(r"[^\w぀-ヿ一-鿿]+", "_", str(text)).strip("_")
    return s[:limit] or "short"


def load_index(cfg: Config) -> list[dict]:
    path = cfg.shorts_dir / "index.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return []


def save_index(cfg: Config, index: list[dict]) -> None:
    path = cfg.shorts_dir / "index.json"
    path.write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8")


def cmd_init(args: argparse.Namespace) -> int:
    cfg = load_config(args.config)
    cfg.ensure_dirs()
    example = Path(__file__).resolve().parent.parent / "config.example.yaml"
    target = Path(args.config or CONFIG_FILENAME)
    if not target.exists() and example.exists():
        target.write_text(example.read_text(encoding="utf-8"), encoding="utf-8")
        print(f"設定ファイルを作成しました: {target}")
    print(f"ワークスペース: {cfg.workspace.resolve()}")
    print(f"撮った動画は {cfg.inbox} に入れて `ytshorts run` を実行してください。")
    return 0


def find_inbox_videos(cfg: Config) -> list[Path]:
    return sorted(
        p for p in cfg.inbox.iterdir()
        if p.suffix.lower() in VIDEO_EXTS
    ) if cfg.inbox.exists() else []


def process_video(video: Path, cfg: Config, script: dict | None, force: bool) -> list[dict]:
    """1本の撮りっぱなし動画からショートを量産する。生成したindexエントリを返す。"""
    session_dir = cfg.sessions / video.stem
    session_dir.mkdir(parents=True, exist_ok=True)
    if force:
        for name in ("transcript.json", "plan.json"):
            (session_dir / name).unlink(missing_ok=True)

    print(f"[1/4] 文字起こし中… ({video.name})")
    transcript = load_or_transcribe(video, session_dir, cfg)
    words = all_words(transcript)
    print(f"      {transcript['duration']:.0f}秒 / {len(words)}語")

    print("[2/4] Claudeが編集プランを作成中…")
    questions = script.get("questions") if script else None
    plan = planner.load_or_generate_plan(transcript, session_dir, cfg, questions)
    shorts = plan["shorts"]
    print(f"      {len(shorts)}本のショート候補（品質ゲート: {cfg.quality_threshold}点）")

    made: list[dict] = []
    for short in shorts:
        tag = f"  - [{short['score']:3d}点] {short['title']}"
        if short["score"] < cfg.quality_threshold:
            print(f"{tag} → 見送り（{short['score_reason'][:40]}）")
            continue

        clip = short["clip"]
        keep = cuts.build_keep_intervals(
            words, clip["start"], clip["end"], cfg.max_pause, cfg.pad
        )
        keep = cuts.subtract_intervals(
            keep, [(c["start"], c["end"]) for c in short["extra_cuts"]]
        )
        if not keep:
            print(f"{tag} → 見送り（カット後に映像が残らない）")
            continue
        out_dur = cuts.total_kept(keep)
        if out_dur < cfg.short_min_sec:
            print(f"{tag} → 見送り（カット後 {out_dur:.0f}秒 で短すぎる）")
            continue

        print(f"{tag} → レンダリング（カット後 {out_dur:.0f}秒）")
        print("[3/4] 挿絵を生成中…")
        ill_pngs = illustrations.generate_illustrations(short, session_dir / "illustrations", cfg)
        ill_files: list[tuple[Path, float, float]] = []
        for ill, png in zip(short["illustrations"], ill_pngs):
            if png is None:
                continue
            start = cuts.map_time(ill["time"], keep)
            ill_files.append((png, start, start + ill["duration"]))

        subs_path = session_dir / f"{short['id']}.ass"
        subs_path.write_text(
            subtitles.build_ass(short, keep, cfg.width, cfg.height), encoding="utf-8"
        )

        out_name = f"{video.stem}_{short['id']}_{slugify(short['title'])}.mp4"
        out_path = cfg.shorts_dir / out_name
        print("[4/4] レンダリング中…")
        render.render_short(video, keep, subs_path, ill_files, out_path, cfg)

        made.append({
            "file": out_name,
            "session": video.stem,
            "short_id": short["id"],
            "title": short["title"],
            "score": short["score"],
            "duration": round(out_dur, 1),
            "created_at": dt.datetime.now().strftime("%Y-%m-%d %H:%M"),
        })
    return made


def cmd_run(args: argparse.Namespace) -> int:
    cfg = load_config(args.config)
    cfg.ensure_dirs()
    videos = [Path(v) for v in args.videos] or find_inbox_videos(cfg)
    if not videos:
        print(f"動画が見つかりません。{cfg.inbox} に入れるか、パスを指定してください。")
        return 1

    script = gasapi.fetch_latest_script(cfg)
    if script:
        print(f"撮影台本を取得: {script['script_id']}（{len(script['questions'])}問）")

    index = load_index(cfg)
    all_made: list[dict] = []
    for video in videos:
        made = process_video(video, cfg, script, args.force)
        all_made.extend(made)
    index.extend(all_made)
    save_index(cfg, index)

    print()
    print(f"✅ ショート {len(all_made)}本を生成 → {cfg.shorts_dir}")
    for m in all_made:
        print(f"   {m['file']} ({m['score']}点 / {m['duration']}秒)")

    if not args.no_report:
        summary = (
            f"{len(videos)}本の動画から {len(all_made)}本のショートを生成しました。\n"
            + "\n".join(f"• {m['title']}（{m['score']}点 / {m['duration']}秒）" for m in all_made)
        )
        if gasapi.report_result(cfg, script["script_id"] if script else None, summary):
            print("Slackに結果を通知しました。")
    return 0


def cmd_compile(args: argparse.Namespace) -> int:
    cfg = load_config(args.config)
    cfg.ensure_dirs()
    entries = [e for e in load_index(cfg) if e["score"] >= args.min_score]
    entries = [e for e in entries if (cfg.shorts_dir / e["file"]).exists()]
    if not entries:
        print("まとめられるショートがありません。先に `ytshorts run` でストックしてください。")
        return 1
    entries.sort(key=lambda e: -e["score"])
    if args.limit:
        entries = entries[: args.limit]
    entries.sort(key=lambda e: e["created_at"])

    name = args.out or f"compilation_{dt.datetime.now().strftime('%Y%m%d_%H%M')}.mp4"
    out_path = cfg.compilations_dir / name
    print(f"{len(entries)}本のショートを1本にまとめています…")
    chapters = compilation.compile_shorts(entries, cfg.shorts_dir, out_path)
    print(f"✅ {out_path}")
    print("--- YouTube概要欄用チャプター ---")
    print(chapters)
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    cfg = load_config(args.config)
    index = load_index(cfg)
    if not index:
        print("ストックはまだありません。")
        return 0
    total = sum(e["duration"] for e in index)
    print(f"ショートのストック: {len(index)}本（合計 {total / 60:.1f}分）")
    for e in index:
        print(f"  {e['created_at']}  [{e['score']:3d}点] {e['duration']:5.1f}s  {e['title']}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ytshorts", description="YouTubeショート量産パイプライン")
    parser.add_argument("--config", help=f"設定ファイル（既定: {CONFIG_FILENAME}）")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("init", help="ワークスペースと設定ファイルを作る").set_defaults(func=cmd_init)

    p_run = sub.add_parser("run", help="動画からショートを量産する")
    p_run.add_argument("videos", nargs="*", help="動画ファイル（省略時は inbox 内すべて）")
    p_run.add_argument("--force", action="store_true", help="文字起こし・プランを作り直す")
    p_run.add_argument("--no-report", action="store_true", help="Slackへの結果通知をしない")
    p_run.set_defaults(func=cmd_run)

    p_comp = sub.add_parser("compile", help="ストックを1本のまとめ動画にする")
    p_comp.add_argument("--min-score", type=int, default=0, help="このスコア以上だけまとめる")
    p_comp.add_argument("--limit", type=int, default=0, help="本数上限（スコア上位から）")
    p_comp.add_argument("--out", help="出力ファイル名")
    p_comp.set_defaults(func=cmd_compile)

    sub.add_parser("list", help="ストック一覧").set_defaults(func=cmd_list)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
