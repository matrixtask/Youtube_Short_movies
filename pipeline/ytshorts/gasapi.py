"""gasapi.py — GAS Webアプリ（撮影台本システム）との連携（任意機能）。"""

from __future__ import annotations

import json
import urllib.parse
import urllib.request

from .config import Config


def fetch_latest_script(cfg: Config) -> dict | None:
    """最新の撮影台本（質問リスト）を取得する。未設定・失敗時は None。"""
    if not cfg.gas_webapp_url or not cfg.gas_admin_token:
        return None
    url = (
        cfg.gas_webapp_url
        + "?" + urllib.parse.urlencode({"token": cfg.gas_admin_token, "action": "scripts", "limit": 3})
    )
    try:
        with urllib.request.urlopen(url, timeout=30) as res:
            data = json.loads(res.read().decode("utf-8"))
    except Exception:
        return None
    if not data.get("ok") or not data.get("scripts"):
        return None
    # 撮影済み(shot)を優先、なければ最新
    scripts = data["scripts"]
    shot = [s for s in scripts if s.get("status") == "shot"]
    return (shot or scripts)[-1]


def fetch_pending_videos(cfg: Config) -> list[dict]:
    """Slackに投げられて処理待ちの動画一覧を取得する。未設定・失敗時は空リスト。

    各要素: {video_id, script_id, file_id, file_name, url_private, size, questions}
    """
    if not cfg.gas_webapp_url or not cfg.gas_admin_token:
        return []
    url = (
        cfg.gas_webapp_url
        + "?" + urllib.parse.urlencode({"token": cfg.gas_admin_token, "action": "videos"})
    )
    try:
        with urllib.request.urlopen(url, timeout=30) as res:
            data = json.loads(res.read().decode("utf-8"))
    except Exception:
        return []
    if not data.get("ok"):
        return []
    return data.get("videos") or []


def mark_video_done(cfg: Config, video_id: str, ok: bool, summary: str) -> bool:
    """動画単位の処理結果を報告する（GASが元のスレッドに結果を返す）。"""
    if not cfg.gas_webapp_url or not cfg.gas_admin_token:
        return False
    payload = json.dumps({
        "action": "video_done",
        "token": cfg.gas_admin_token,
        "video_id": video_id,
        "ok": ok,
        "summary": summary,
    }).encode("utf-8")
    req = urllib.request.Request(
        cfg.gas_webapp_url, data=payload, headers={"content-type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.loads(res.read().decode("utf-8")).get("ok", False)
    except Exception:
        return False


def report_result(cfg: Config, script_id: str | None, summary: str) -> bool:
    """処理結果をGASへ報告する（Slack通知される）。未設定・失敗時は False。"""
    if not cfg.gas_webapp_url or not cfg.gas_admin_token:
        return False
    payload = json.dumps({
        "action": "report",
        "token": cfg.gas_admin_token,
        "script_id": script_id or "",
        "summary": summary,
    }).encode("utf-8")
    req = urllib.request.Request(
        cfg.gas_webapp_url, data=payload, headers={"content-type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.loads(res.read().decode("utf-8")).get("ok", False)
    except Exception:
        return False
