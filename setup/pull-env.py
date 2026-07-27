#!/usr/bin/env python3
"""GASのスクリプトプロパティから .env を組み立てる。

    python3 setup/pull-env.py

GAS側で一時的に ALLOW_ENV_EXPORT=true を設定してから実行し、
終わったらそのプロパティを消す（または false にする）こと。

WebアプリURLとADMIN_TOKENだけは手入力（これが鍵そのものなので）。
一度 .env に入れば次回以降は自動で再利用される。
"""

from __future__ import annotations

import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = ROOT / ".env"


def read_env() -> dict:
    env = {}
    if ENV_PATH.exists():
        for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
            m = re.match(r"^([A-Z0-9_]+)=(.*)$", line.strip())
            if m:
                env[m.group(1)] = m.group(2)
    return env


def write_env(env: dict) -> None:
    template = (ROOT / ".env.example").read_text(encoding="utf-8")
    lines = []
    for line in template.splitlines():
        m = re.match(r"^([A-Z0-9_]+)=", line)
        if m and m.group(1) in env:
            lines.append(f"{m.group(1)}={env[m.group(1)]}")
        else:
            lines.append(line)
    # テンプレートに無いキーも残す
    known = set(re.findall(r"^([A-Z0-9_]+)=", "\n".join(lines), re.M))
    extra = [f"{k}={v}" for k, v in env.items() if k not in known]
    if extra:
        lines += ["", "# GASから取得した追加設定"] + extra
    ENV_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    env = read_env()
    url = env.get("YTSHORTS_GAS_WEBAPP_URL") or input("GASのWebアプリURL: ").strip()
    token = env.get("GAS_ADMIN_TOKEN") or input("GASのADMIN_TOKEN: ").strip()
    if not url or not token:
        print("URLとADMIN_TOKENが必要です", file=sys.stderr)
        return 1

    req = url + "?" + urllib.parse.urlencode({"token": token, "action": "env"})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            data = json.loads(res.read().decode("utf-8"))
    except Exception as e:
        print(f"GASに接続できませんでした: {e}", file=sys.stderr)
        return 1
    if not data.get("ok"):
        print(f"GASがエラーを返しました: {data.get('error')}", file=sys.stderr)
        return 1

    fetched = data.get("env") or {}
    env.update({"YTSHORTS_GAS_WEBAPP_URL": url, "GAS_ADMIN_TOKEN": token})
    env.update(fetched)
    write_env(env)

    print(f"✅ .env を更新しました（GASから {len(fetched)}件取得）")
    for k in fetched:
        print(f"   {k}")
    missing = [k for k in ("ANTHROPIC_API_KEY", "SLACK_BOT_TOKEN") if not env.get(k)]
    if missing:
        print(f"⚠ GAS側に未設定のため空のままです: {', '.join(missing)}")
    print("\n終わったらGASの ALLOW_ENV_EXPORT を false（または削除）に戻してください。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
