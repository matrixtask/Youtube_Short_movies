"""youtube.py — YouTube Data API v3 でのショート投稿（標準ライブラリのみ）。

OAuthはリフレッシュトークン方式。環境変数:
  YT_CLIENT_ID / YT_CLIENT_SECRET / YT_REFRESH_TOKEN
（取得手順は pipeline/README.md 参照。scope: youtube.upload）
"""

from __future__ import annotations

import json
import os
import urllib.parse
import urllib.request
from pathlib import Path

TOKEN_URL = "https://oauth2.googleapis.com/token"
UPLOAD_URL = (
    "https://www.googleapis.com/upload/youtube/v3/videos"
    "?uploadType=resumable&part=snippet,status"
)

MAX_TITLE_LEN = 100


def credentials_from_env() -> dict:
    creds = {
        "client_id": os.environ.get("YT_CLIENT_ID", ""),
        "client_secret": os.environ.get("YT_CLIENT_SECRET", ""),
        "refresh_token": os.environ.get("YT_REFRESH_TOKEN", ""),
    }
    missing = [k for k, v in creds.items() if not v]
    if missing:
        raise RuntimeError(
            "YouTube投稿に必要な環境変数が未設定です: "
            + ", ".join("YT_" + k.upper() for k in missing)
        )
    return creds


def fetch_access_token(creds: dict) -> str:
    data = urllib.parse.urlencode({
        "client_id": creds["client_id"],
        "client_secret": creds["client_secret"],
        "refresh_token": creds["refresh_token"],
        "grant_type": "refresh_token",
    }).encode("utf-8")
    req = urllib.request.Request(TOKEN_URL, data=data)
    with urllib.request.urlopen(req, timeout=60) as res:
        body = json.loads(res.read().decode("utf-8"))
    token = body.get("access_token")
    if not token:
        raise RuntimeError(f"アクセストークンの取得に失敗: {body}")
    return token


def youtube_title(title: str) -> str:
    """YouTubeのタイトル制約に合わせる（<> 禁止・100文字・#Shorts付与）（純粋）。"""
    t = str(title).replace("<", "＜").replace(">", "＞").strip()
    suffix = " #Shorts"
    if len(t) + len(suffix) > MAX_TITLE_LEN:
        t = t[: MAX_TITLE_LEN - len(suffix) - 1] + "…"
    return t + suffix


def build_video_body(title: str, description: str, privacy: str) -> dict:
    """videos.insert のリクエストボディ（純粋）。"""
    if privacy not in ("public", "unlisted", "private"):
        privacy = "private"
    return {
        "snippet": {
            "title": youtube_title(title),
            "description": description,
            "categoryId": "22",  # People & Blogs
        },
        "status": {
            "privacyStatus": privacy,
            "selfDeclaredMadeForKids": False,
        },
    }


def upload_short(path: Path, title: str, privacy: str, creds: dict, description: str = "") -> str:
    """ショートをアップロードして動画URLを返す。"""
    access = fetch_access_token(creds)
    body = build_video_body(title, description or f"{title}\n\n#Shorts", privacy)
    size = path.stat().st_size

    init_req = urllib.request.Request(
        UPLOAD_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {access}",
            "content-type": "application/json; charset=utf-8",
            "X-Upload-Content-Type": "video/mp4",
            "X-Upload-Content-Length": str(size),
        },
    )
    with urllib.request.urlopen(init_req, timeout=120) as res:
        location = res.headers.get("Location")
    if not location:
        raise RuntimeError("アップロードセッションの開始に失敗しました")

    put_req = urllib.request.Request(
        location,
        data=path.read_bytes(),
        method="PUT",
        headers={
            "Authorization": f"Bearer {access}",
            "content-type": "video/mp4",
        },
    )
    with urllib.request.urlopen(put_req, timeout=1800) as res:
        result = json.loads(res.read().decode("utf-8"))
    video_id = result.get("id")
    if not video_id:
        raise RuntimeError(f"アップロードに失敗: {result}")
    return f"https://www.youtube.com/shorts/{video_id}"
