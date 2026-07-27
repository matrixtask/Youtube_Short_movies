#!/usr/bin/env python3
"""`.env` を組み立てて検証する（新しいPCのセットアップ・設定の移行に使う）。

    make env-pull          # または python3 setup/pull-env.py

集める順（あとの方が優先）:
  1. .env.example            … 雛形（コメントを保つため）
  2. 既存の .env             … すでに入っている値
  3. setup/github-secrets.local.txt … ウィザードの出力（名前を読み替える）
  4. GASのスクリプトプロパティ … ALLOW_ENV_EXPORT=true のときだけ

最後に値の妥当性（URLが途中で切れていないか、GASに繋がるか）を検証する。
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
TEMPLATE_PATH = ROOT / ".env.example"
SECRETS_PATH = ROOT / "setup" / "github-secrets.local.txt"

# ウィザードの出力（GitHub Secrets名）→ .env のキー名
ALIASES = {"GAS_WEBAPP_URL": "YTSHORTS_GAS_WEBAPP_URL"}


def parse_env_file(path: Path) -> dict:
    if not path.exists():
        return {}
    pairs = re.findall(r"^\s*([A-Z0-9_]+)=(.*)$", path.read_text(encoding="utf-8"), re.M)
    return {ALIASES.get(k, k): v.strip() for k, v in pairs if v.strip()}


def fetch_from_gas(url: str, token: str) -> dict:
    """GASのスクリプトプロパティから許可リストの値を取得（失敗しても致命的にしない）。"""
    if not url or not token:
        return {}
    req = url + "?" + urllib.parse.urlencode({"token": token, "action": "env"})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:  # 302は自動追従
            data = json.loads(res.read().decode("utf-8"))
    except Exception as e:
        print(f"  GASからの取得はスキップ: {e}")
        return {}
    if not data.get("ok"):
        print(f"  GASからの取得はスキップ: {data.get('error')}")
        return {}
    got = data.get("env") or {}
    print(f"  GASから {len(got)}件 取得")
    return got


def write_env(env: dict) -> None:
    lines = []
    for line in TEMPLATE_PATH.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^([A-Z0-9_]+)=", line)
        lines.append(f"{m.group(1)}={env[m.group(1)]}" if m and env.get(m.group(1)) else line)
    known = set(re.findall(r"^([A-Z0-9_]+)=", "\n".join(lines), re.M))
    extra = [f"{k}={v}" for k, v in env.items() if k not in known]
    if extra:
        lines += ["", "# 追加設定"] + extra
    ENV_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")


def validate(env: dict) -> list[str]:
    """よくある事故（URLの切れ・キーの欠落・GAS不通）を検出する。"""
    problems = []
    url = env.get("YTSHORTS_GAS_WEBAPP_URL", "")
    token = env.get("GAS_ADMIN_TOKEN", "")

    if not url:
        problems.append("YTSHORTS_GAS_WEBAPP_URL が空です")
    else:
        # 画面の省略表示（AKfycb…）をコピーした事故が多いので弾く
        if "…" in url or "..." in url:
            problems.append("URLに「…」が含まれています（省略表示をコピーしています。コピーボタンを使ってください）")
        elif not url.endswith("/exec"):
            problems.append("URLが /exec で終わっていません")
        elif len(url) < 80:
            problems.append(f"URLが短すぎます（{len(url)}文字）。途中で切れている可能性があります")

    for key in ("ANTHROPIC_API_KEY", "SLACK_BOT_TOKEN", "GAS_ADMIN_TOKEN"):
        if not env.get(key):
            problems.append(f"{key} が空です")

    if url and token and not problems:
        req = url + "?" + urllib.parse.urlencode({"token": token, "action": "videos"})
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                body = json.loads(res.read().decode("utf-8"))
            if not body.get("ok"):
                problems.append(f"GASが拒否しました: {body.get('error')}（ADMIN_TOKENを確認）")
        except json.JSONDecodeError:
            problems.append("GASがJSONを返しません（URLが別のデプロイを指している可能性）")
        except Exception as e:
            problems.append(f"GASに接続できません: {e}")
    return problems


def main() -> int:
    if not TEMPLATE_PATH.exists():
        print(".env.example が見つかりません", file=sys.stderr)
        return 1

    env: dict = {}
    print("=== 設定を集めています ===")

    existing = parse_env_file(ENV_PATH)
    if existing:
        print(f"  既存の .env から {len(existing)}件")
        env.update(existing)

    from_secrets = parse_env_file(SECRETS_PATH)
    if from_secrets:
        print(f"  {SECRETS_PATH.name} から {len(from_secrets)}件")
        env.update(from_secrets)

    if not env.get("YTSHORTS_GAS_WEBAPP_URL"):
        env["YTSHORTS_GAS_WEBAPP_URL"] = input("  GASのWebアプリURL: ").strip()
    if not env.get("GAS_ADMIN_TOKEN"):
        env["GAS_ADMIN_TOKEN"] = input("  GASのADMIN_TOKEN: ").strip()

    env.update(fetch_from_gas(env["YTSHORTS_GAS_WEBAPP_URL"], env["GAS_ADMIN_TOKEN"]))

    write_env(env)
    print(f"\n✅ .env を書き出しました（{len([v for v in env.values() if v])}件）")

    problems = validate(env)
    if problems:
        print("\n⚠ 確認が必要です:")
        for p in problems:
            print(f"   - {p}")
        print("\n   正しい値の場所:")
        print("   - URL   … SlackアプリのEvent Subscriptions の Request URL")
        print("   - その他 … GASエディタ > プロジェクトの設定 > スクリプト プロパティ")
        print("              （ADMIN_TOKEN → .envでは GAS_ADMIN_TOKEN）")
        return 1

    print("🎉 検証OK。GASに接続できました。`make pull` が使えます")
    return 0


if __name__ == "__main__":
    sys.exit(main())
