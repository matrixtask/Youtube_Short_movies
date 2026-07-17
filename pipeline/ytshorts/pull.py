"""pull.py — Slackに投げられた動画の取り込み（GAS経由）。

GASのWebアプリから処理待ち動画のリストをもらい、Slackからダウンロードして
inboxに置く。ダウンロードには SLACK_BOT_TOKEN 環境変数（files:read 権限）が要る。
"""

from __future__ import annotations

import os
import re
import shutil
import urllib.request
from pathlib import Path


def safe_filename(name: str, fallback: str = "video") -> str:
    """Slackのファイル名をローカル保存できる安全な名前にする（純粋）。"""
    base = Path(str(name or "")).name
    stem, dot, ext = base.rpartition(".")
    if not dot:
        stem, ext = base, "mp4"
    stem = re.sub(r"[^\w\-぀-ヿ一-鿿]+", "_", stem).strip("_") or fallback
    ext = re.sub(r"[^A-Za-z0-9]", "", ext).lower() or "mp4"
    return f"{stem}.{ext}"


def slack_token() -> str:
    token = os.environ.get("SLACK_BOT_TOKEN", "")
    if not token:
        raise RuntimeError(
            "環境変数 SLACK_BOT_TOKEN が未設定です（動画のダウンロードに必要。files:read 権限）"
        )
    return token


def download_slack_file(url: str, dest: Path, token: str) -> None:
    """Slackの url_private から dest へダウンロードする。途中失敗でゴミを残さない。"""
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    tmp = dest.with_suffix(dest.suffix + ".part")
    try:
        with urllib.request.urlopen(req, timeout=1800) as res, open(tmp, "wb") as f:
            content_type = res.headers.get("content-type", "")
            if "text/html" in content_type:
                # 認可エラー時、SlackはログインページのHTMLを200で返すことがある
                raise RuntimeError(
                    "Slackがファイルの代わりにHTMLを返しました。"
                    "SLACK_BOT_TOKEN の files:read 権限とチャンネル参加を確認してください"
                )
            shutil.copyfileobj(res, f)
        tmp.replace(dest)
    finally:
        tmp.unlink(missing_ok=True)
