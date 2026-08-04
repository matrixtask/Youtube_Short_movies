"""cli.py — ytshorts コマンド。

  ytshorts init                 ワークスペースと設定ファイルを作る
  ytshorts pull [--watch]       Slackに投げた動画を取り込んで自動処理（常駐可）
  ytshorts run [動画...]        取り込み〜ショート量産まで一気に実行
  ytshorts compile              溜まったショートを1本のまとめ動画に
  ytshorts list                 ショートのストック一覧
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import socket
import sys
import time
from pathlib import Path

from . import compilation, cuts, gasapi, illustrations, planner, pull, render, slackup, subtitles, youtube
from .config import CONFIG_FILENAME, Config, load_config
from .transcribe import all_words, load_or_transcribe, probe_dimensions

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

        style = {
            "font": cfg.subtitle_font,
            "caption_color": cfg.caption_color,
            "hook_color": cfg.hook_color,
            "tsukkomi_color": cfg.tsukkomi_color,
            "title_color": cfg.title_color,
        }
        # 横型ソースは既定で「横幅フィット+上下帯（帯にタイトル）」でショート化する
        landscape = is_landscape(video)
        fit = landscape and cfg.shorts_layout == "fit"
        subs_path = session_dir / f"{short['id']}.ass"
        subs_path.write_text(
            subtitles.build_ass(short, keep, cfg.width, cfg.height,
                                layout="fit" if fit else "crop", **style),
            encoding="utf-8",
        )

        out_name = f"{video.stem}_{short['id']}_{slugify(short['title'])}.mp4"
        out_path = cfg.shorts_dir / out_name
        print("[4/4] レンダリング中…")
        render.render_short(video, keep, subs_path, ill_files, out_path, cfg, fit=fit)

        # 横型ソースなら、まとめ動画・ロング動画用に16:9ワイド版も作る
        wide_name = ""
        if cfg.wide_enabled and landscape:
            wide_name = f"{video.stem}_{short['id']}_wide.mp4"
            wide_subs = session_dir / f"{short['id']}_wide.ass"
            wide_subs.write_text(
                subtitles.build_ass(short, keep, 1920, 1080, **style), encoding="utf-8"
            )
            print("      16:9ワイド版もレンダリング中…")
            render.render_short(video, keep, wide_subs, ill_files,
                                cfg.shorts_dir / wide_name, cfg, size=(1920, 1080))

        made.append({
            "file": out_name,
            "wide_file": wide_name,
            "session": video.stem,
            "short_id": short["id"],
            "title": short["title"],
            "score": short["score"],
            "question_idx": short.get("question_idx", 0),
            "duration": round(out_dur, 1),
            "created_at": dt.datetime.now().strftime("%Y-%m-%d %H:%M"),
        })
    return made


def is_landscape(video: Path) -> bool:
    try:
        w, h = probe_dimensions(video)
        return w > h
    except Exception:
        return False


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


def worker_name() -> str:
    """どのマシンが処理したかをGASの台帳に残すための識別子。"""
    import os
    if os.environ.get("GITHUB_ACTIONS") == "true":
        return "github-actions"
    return f"{socket.gethostname()}/local"


def pull_once(cfg: Config) -> int:
    """Slackに投げられた処理待ち動画を取り込んで処理する。処理した本数を返す。

    動画はGAS側で「確保」してから取得するので、クラウド実行と同時に走っても
    同じ動画を二重処理しない。
    """
    pending = gasapi.claim_pending_videos(cfg, worker_name())
    videos = pending["videos"]
    if not videos:
        return 0
    channel = pending["channel"]
    token = pull.slack_token()
    index = load_index(cfg)
    for v in videos:
        name = f"{v['video_id']}_{pull.safe_filename(v.get('file_name'), v['video_id'])}"
        dest = cfg.inbox / name
        try:
            if not dest.exists():
                print(f"⬇ {v.get('file_name')} をダウンロード中…")
                pull.download_slack_file(v["url_private"], dest, token)
            script = {"script_id": v.get("script_id") or None, "questions": v.get("questions") or []}
            made = process_video(dest, cfg, script if script["questions"] else None, force=False)
            index.extend(made)
            save_index(cfg, index)
            shared = share_shorts_to_slack(cfg, token, channel, v, made)
            summary = (
                f"{v.get('file_name')} から {len(made)}本のショートを生成しました。\n"
                + "\n".join(f"• {m['title']}（{m['score']}点 / {m['duration']}秒）" for m in made)
                + ("\nショートをこのスレッドに置いておきます。" if shared else "")
            )
            gasapi.mark_video_done(cfg, v["video_id"], True, summary)
            print(f"✅ {v.get('file_name')}: ショート{len(made)}本")
        except Exception as e:
            gasapi.mark_video_done(cfg, v["video_id"], False, f"{v.get('file_name')}: {e}")
            print(f"❌ {v.get('file_name')}: {e}", file=sys.stderr)
    return len(videos)


def share_shorts_to_slack(cfg: Config, token: str, channel: str, video: dict, made: list[dict]) -> int:
    """生成したショートをSlackの元スレッドにアップロードし、GASの台帳に登録する。"""
    if not channel:
        return 0
    shared = 0
    for m in made:
        uploads = [(m["file"], "short", f"{m['title']}（{m['score']}点）")]
        if m.get("wide_file"):
            uploads.append((m["wide_file"], "wide", f"{m['title']}（16:9ワイド版・まとめ用）"))
        for fname, kind, title in uploads:
            try:
                info = slackup.upload_to_slack(
                    token, channel, video.get("thread_ts") or None, cfg.shorts_dir / fname,
                    title=title,
                )
                gasapi.register_short(cfg, {
                    "video_id": video.get("video_id", ""),
                    "script_id": video.get("script_id", ""),
                    "title": m["title"],
                    "score": m["score"],
                    "duration": m["duration"],
                    "question_idx": m.get("question_idx", 0),
                    "slack_file_id": info["id"],
                    "url_private": info["url_private"],
                    "kind": kind,
                })
                if kind == "short":
                    shared += 1
            except Exception as e:
                print(f"⚠ Slackへのアップロード失敗 ({fname}): {e}", file=sys.stderr)
    return shared


def cmd_pull(args: argparse.Namespace) -> int:
    cfg = load_config(args.config)
    cfg.ensure_dirs()
    if not cfg.gas_webapp_url or not cfg.gas_admin_token:
        print("gas_webapp_url（config.yaml）と GAS_ADMIN_TOKEN（環境変数）の設定が必要です。")
        return 1
    pull.slack_token()  # 早めに未設定を検出する
    if not args.watch:
        n = pull_once(cfg)
        print("新着動画はありません。" if n == 0 else f"{n}本を処理しました。")
        return 0
    print(f"Slackの新着動画を監視中…（{args.interval}秒間隔、Ctrl+Cで終了）")
    try:
        while True:
            try:
                pull_once(cfg)
            except Exception as e:
                print(f"⚠ {e}", file=sys.stderr)
            time.sleep(args.interval)
    except KeyboardInterrupt:
        return 0


def collect_slack_shorts(cfg: Config, min_score: int) -> tuple[list[dict], Path, str]:
    """GASの台帳からショートを集め、Slackからダウンロードして材料にする。

    縦と横の両方があるショートは横（wide）を優先する。
    """
    ledger = gasapi.fetch_shorts(cfg)
    token = pull.slack_token()
    cache = cfg.workspace / "cache"
    cache.mkdir(parents=True, exist_ok=True)
    entries = []
    for s in compilation.select_compile_entries(ledger["shorts"], min_score):
        fname = f"{s['short_id']}.mp4"
        dest = cache / fname
        if not dest.exists():
            print(f"⬇ {s['title']} をダウンロード中…")
            pull.download_slack_file(s["url_private"], dest, token)
        entries.append({
            "file": fname,
            "title": s["title"],
            "score": s["score"],
            "created_at": s["created_at"],
        })
    return entries, cache, ledger["channel"]


def cmd_compile(args: argparse.Namespace) -> int:
    cfg = load_config(args.config)
    cfg.ensure_dirs()
    channel = ""
    if args.from_slack:
        entries, src_dir, channel = collect_slack_shorts(cfg, args.min_score)
    else:
        entries = []
        for e in load_index(cfg):
            if e["score"] < args.min_score:
                continue
            # ワイド版があればまとめにはそちらを使う
            fname = e.get("wide_file") or e["file"]
            if not (cfg.shorts_dir / fname).exists():
                fname = e["file"]
            if (cfg.shorts_dir / fname).exists():
                entries.append(dict(e, file=fname))
        src_dir = cfg.shorts_dir
    if not entries:
        print("まとめられるショートがありません。先にショートをストックしてください。")
        return 1
    entries.sort(key=lambda e: -e["score"])
    if args.limit:
        entries = entries[: args.limit]
    entries.sort(key=lambda e: e["created_at"])

    name = args.out or f"compilation_{dt.datetime.now().strftime('%Y%m%d_%H%M')}.mp4"
    out_path = cfg.compilations_dir / name
    print(f"{len(entries)}本のショートを1本にまとめています…")
    chapters = compilation.compile_shorts(entries, src_dir, out_path)
    print(f"✅ {out_path}")
    print("--- YouTube概要欄用チャプター ---")
    print(chapters)

    if args.from_slack and channel:
        try:
            slackup.upload_to_slack(
                pull.slack_token(), channel, None, out_path,
                title=f"まとめ動画（{len(entries)}本 / {dt.datetime.now().strftime('%Y-%m-%d')}）",
            )
            gasapi.report_result(
                cfg, None,
                f"まとめ動画ができました（{len(entries)}本）。\n--- 概要欄用チャプター ---\n{chapters}",
            )
            print("Slackにまとめ動画を投稿しました。")
        except Exception as e:
            print(f"⚠ Slackへの投稿に失敗: {e}", file=sys.stderr)
    return 0


def cmd_publish(args: argparse.Namespace) -> int:
    """投稿時刻が来た承認済みショートをYouTubeへアップロードする。"""
    cfg = load_config(args.config)
    cfg.ensure_dirs()
    queue = gasapi.fetch_publish_queue(cfg)
    if not queue:
        print("投稿待ちのショートはありません。")
        return 0
    creds = youtube.credentials_from_env()
    token = pull.slack_token()
    cache = cfg.workspace / "cache"
    cache.mkdir(parents=True, exist_ok=True)
    failed = 0
    for item in queue:
        dest = cache / f"{item['short_id']}.mp4"
        try:
            if not dest.exists():
                print(f"⬇ {item['title']} をダウンロード中…")
                pull.download_slack_file(item["url_private"], dest, token)
            print(f"📤 YouTubeへアップロード中: {item['title']}")
            url = youtube.upload_short(dest, item["title"], item.get("privacy", "private"), creds)
            gasapi.mark_published(cfg, item["short_id"], True, url)
            print(f"✅ {url}")
        except Exception as e:
            failed += 1
            gasapi.mark_published(cfg, item["short_id"], False, str(e))
            print(f"❌ {item['title']}: {e}", file=sys.stderr)
    print(f"投稿 {len(queue) - failed}/{len(queue)} 本が完了しました。")
    return 1 if failed else 0


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

    p_pull = sub.add_parser("pull", help="Slackに投げた動画を取り込んで自動処理する")
    p_pull.add_argument("--watch", action="store_true", help="常駐して新着を監視し続ける")
    p_pull.add_argument("--interval", type=int, default=300, help="監視間隔（秒、既定300）")
    p_pull.set_defaults(func=cmd_pull)

    p_run = sub.add_parser("run", help="動画からショートを量産する")
    p_run.add_argument("videos", nargs="*", help="動画ファイル（省略時は inbox 内すべて）")
    p_run.add_argument("--force", action="store_true", help="文字起こし・プランを作り直す")
    p_run.add_argument("--no-report", action="store_true", help="Slackへの結果通知をしない")
    p_run.set_defaults(func=cmd_run)

    p_comp = sub.add_parser("compile", help="ストックを1本のまとめ動画にする")
    p_comp.add_argument("--min-score", type=int, default=0, help="このスコア以上だけまとめる")
    p_comp.add_argument("--limit", type=int, default=0, help="本数上限（スコア上位から）")
    p_comp.add_argument("--out", help="出力ファイル名")
    p_comp.add_argument("--from-slack", action="store_true",
                        help="GASの台帳とSlack上のファイルを材料にし、結果もSlackへ投稿する（クラウド実行用）")
    p_comp.set_defaults(func=cmd_compile)

    sub.add_parser(
        "publish", help="投稿時刻が来た承認済みショートをYouTubeへ投稿する"
    ).set_defaults(func=cmd_publish)

    sub.add_parser("list", help="ストック一覧").set_defaults(func=cmd_list)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
