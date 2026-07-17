"""slackup.py — 生成したショートをSlackへアップロードする。

ショートの実体はSlack上に置く（= スマホからそのまま確認・保存・投稿できて、
まとめ動画のときはSlackからダウンロードして材料にする）。
files:write 権限が必要。
"""

from __future__ import annotations

import json
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://slack.com/api/"


def _slack_form(method: str, token: str, params: dict) -> dict:
    data = urllib.parse.urlencode(params).encode("utf-8")
    req = urllib.request.Request(
        API + method,
        data=data,
        headers={
            "Authorization": f"Bearer {token}",
            "content-type": "application/x-www-form-urlencoded",
        },
    )
    with urllib.request.urlopen(req, timeout=120) as res:
        body = json.loads(res.read().decode("utf-8"))
    if not body.get("ok"):
        raise RuntimeError(f"Slack API error ({method}): {body.get('error')}")
    return body


def _slack_json(method: str, token: str, payload: dict) -> dict:
    req = urllib.request.Request(
        API + method,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "content-type": "application/json; charset=utf-8",
        },
    )
    with urllib.request.urlopen(req, timeout=120) as res:
        body = json.loads(res.read().decode("utf-8"))
    if not body.get("ok"):
        raise RuntimeError(f"Slack API error ({method}): {body.get('error')}")
    return body


def upload_to_slack(
    token: str, channel: str, thread_ts: str | None, path: Path, title: str
) -> dict:
    """ファイルをアップロードしてチャンネル（またはスレッド）に共有する。

    戻り値: {"id": ファイルID, "url_private": ダウンロードURL}
    """
    size = path.stat().st_size
    got = _slack_form(
        "files.getUploadURLExternal", token, {"filename": path.name, "length": size}
    )
    upload_req = urllib.request.Request(got["upload_url"], data=path.read_bytes())
    with urllib.request.urlopen(upload_req, timeout=1800) as res:
        res.read()

    complete: dict = {"files": [{"id": got["file_id"], "title": title}]}
    if channel:
        complete["channel_id"] = channel
        if thread_ts:
            complete["thread_ts"] = thread_ts
    _slack_json("files.completeUploadExternal", token, complete)

    try:
        info = _slack_form("files.info", token, {"file": got["file_id"]})
        url_private = str(info.get("file", {}).get("url_private_download")
                          or info.get("file", {}).get("url_private") or "")
    except RuntimeError:
        url_private = ""
    return {"id": got["file_id"], "url_private": url_private}
