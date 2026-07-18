#!/usr/bin/env python3
"""対話式セットアップウィザード — 手作業を数クリックまで減らす。

    python3 setup/setup.py

やってくれること:
  1. キー類の収集と ADMIN_TOKEN の自動生成
  2. YouTubeのリフレッシュトークン取得（ブラウザが開いて承認するだけ）
  3. GASプロジェクトの作成・コード反映・Webアプリのデプロイ（clasp があれば）
  4. Slackアプリのマニフェスト生成（貼り付けるだけでアプリができる）
  5. GASのスクリプトプロパティ設定ファイル（SetupProps.local.js）の生成
  6. GitHub Actions の Secrets 登録（gh CLI があれば）

どのステップも空Enterでスキップでき、何度でも再実行できます。
"""

from __future__ import annotations

import json
import re
import secrets
import shutil
import subprocess
import sys
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GAS_DIR = ROOT / "gas"

YT_SCOPE = "https://www.googleapis.com/auth/youtube.upload"
OAUTH_PORT = 8765


def ask(label: str, default: str = "") -> str:
    hint = f" [{default}]" if default else "（空Enterでスキップ）"
    value = input(f"  {label}{hint}: ").strip()
    return value or default


def step(title: str) -> None:
    print(f"\n=== {title} ===")


def run(cmd: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)


def detect_repo() -> str:
    r = run(["git", "remote", "get-url", "origin"], cwd=ROOT)
    m = re.search(r"github\.com[:/]+([^/]+/[^/.\s]+)", r.stdout)
    return m.group(1) if m else ""


# ---- YouTube OAuth（ローカルでブラウザ承認 → リフレッシュトークン取得） ----

def youtube_oauth(client_id: str, client_secret: str) -> str:
    redirect = f"http://localhost:{OAUTH_PORT}"
    auth_url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
        "client_id": client_id,
        "redirect_uri": redirect,
        "response_type": "code",
        "scope": YT_SCOPE,
        "access_type": "offline",
        "prompt": "consent",
    })
    code_holder: dict = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            code_holder["code"] = (qs.get("code") or [""])[0]
            self.send_response(200)
            self.send_header("content-type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write("承認できました。ターミナルに戻ってください。".encode("utf-8"))

        def log_message(self, *args):
            pass

    print(f"  ブラウザで承認してください… 開かない場合はこのURLへ:\n  {auth_url}")
    webbrowser.open(auth_url)
    server = HTTPServer(("localhost", OAUTH_PORT), Handler)
    while "code" not in code_holder:
        server.handle_request()
    server.server_close()
    if not code_holder["code"]:
        raise RuntimeError("承認コードを受け取れませんでした")

    data = urllib.parse.urlencode({
        "client_id": client_id,
        "client_secret": client_secret,
        "code": code_holder["code"],
        "grant_type": "authorization_code",
        "redirect_uri": redirect,
    }).encode("utf-8")
    with urllib.request.urlopen(
        urllib.request.Request("https://oauth2.googleapis.com/token", data=data), timeout=60
    ) as res:
        body = json.loads(res.read().decode("utf-8"))
    token = body.get("refresh_token", "")
    if not token:
        raise RuntimeError(f"refresh_token が取得できませんでした: {body}")
    return token


# ---- clasp（GASのコード反映とWebアプリのデプロイ） ----

def clasp_setup() -> str:
    """clasp で push + deploy して WebアプリURLを返す。できなければ空文字。"""
    if not shutil.which("clasp"):
        print("  clasp が見つかりません（npm i -g @google/clasp → clasp login）。スキップします。")
        return ""
    if not (GAS_DIR / ".clasp.json").exists():
        print("  GASプロジェクトを新規作成します…")
        r = run(["clasp", "create", "--type", "standalone",
                 "--title", "Youtube Shorts Studio", "--rootDir", "src"], cwd=GAS_DIR)
        if r.returncode != 0:
            print(f"  clasp create に失敗: {r.stderr.strip()[:200]}\n  スキップします（clasp login 済みか確認を）。")
            return ""
    r = run(["clasp", "push", "-f"], cwd=GAS_DIR)
    if r.returncode != 0:
        print(f"  clasp push に失敗: {r.stderr.strip()[:200]}")
        return ""
    print("  コードを反映しました。Webアプリをデプロイします…")
    r = run(["clasp", "deploy", "--description", "setup"], cwd=GAS_DIR)
    m = re.search(r"-\s+(\S+)\s+@", r.stdout)
    if r.returncode != 0 or not m:
        print(f"  clasp deploy に失敗: {(r.stderr or r.stdout).strip()[:200]}")
        return ""
    url = f"https://script.google.com/macros/s/{m.group(1)}/exec"
    print(f"  WebアプリURL: {url}")
    return url


def write_props_file(props: dict) -> Path:
    lines = ",\n".join(
        f"    {json.dumps(k)}: {json.dumps(v, ensure_ascii=False)}" for k, v in props.items() if v
    )
    content = (
        "/**\n"
        " * SetupProps.local.js — setup/setup.py が自動生成（コミットされません）\n"
        " * GASエディタで applyLocalProps() を1回実行 → 続けて setupAll() を実行。\n"
        " * 実行後はこのファイルを削除してかまいません。\n"
        " */\n"
        "function applyLocalProps() {\n"
        "  PropertiesService.getScriptProperties().setProperties({\n"
        f"{lines}\n"
        "  });\n"
        "  return 'OK: プロパティを設定しました。次に setupAll() を実行してください';\n"
        "}\n"
    )
    path = GAS_DIR / "src" / "SetupProps.local.js"
    path.write_text(content, encoding="utf-8")
    return path


def gh_set_secrets(repo: str, secrets_map: dict) -> bool:
    if not shutil.which("gh"):
        print("  gh CLI が見つかりません。GitHubのSettings > Secretsから手動で登録してください:")
        for k, v in secrets_map.items():
            print(f"    {k} = {'（未入力）' if not v else '（入力済みの値）'}")
        return False
    ok = True
    for k, v in secrets_map.items():
        if not v:
            continue
        r = subprocess.run(["gh", "secret", "set", k, "-R", repo, "--body", v],
                           capture_output=True, text=True)
        print(f"  {k}: {'OK' if r.returncode == 0 else 'NG ' + r.stderr.strip()[:100]}")
        ok = ok and r.returncode == 0
    return ok


def main() -> int:
    print("YouTube Shorts Studio セットアップウィザード")
    print("（どの項目も空Enterでスキップできます。何度でも再実行OK）")

    step("1/6 キー類の収集")
    anthropic_key = ask("Claude APIキー (ANTHROPIC_API_KEY)")
    repo = ask("GitHubリポジトリ (owner/repo)", detect_repo())
    github_pat = ask("GitHub PAT（動画到着で即クラウド起動する用。Contents: Read/write）")
    admin_token = secrets.token_urlsafe(32)
    print(f"  ADMIN_TOKEN を自動生成しました: {admin_token[:8]}…")

    step("2/6 YouTube のリフレッシュトークン取得")
    print("  Google CloudでYouTube Data API v3を有効化し、OAuthクライアント（デスクトップ）を作成しておいてください。")
    yt_client_id = ask("YouTube OAuth クライアントID")
    yt_client_secret = ask("YouTube OAuth クライアントシークレット") if yt_client_id else ""
    yt_refresh = ""
    if yt_client_id and yt_client_secret:
        try:
            yt_refresh = youtube_oauth(yt_client_id, yt_client_secret)
            print("  リフレッシュトークンを取得しました。")
        except Exception as e:
            print(f"  取得に失敗: {e}（あとで OAuth Playground でも取得できます）")

    step("3/6 GASのデプロイ（clasp）")
    webapp_url = clasp_setup()
    if not webapp_url:
        webapp_url = ask("デプロイ済みならWebアプリURLを入力")

    step("4/6 Slackアプリのマニフェスト生成")
    manifest_src = (ROOT / "setup" / "slack-app-manifest.yaml").read_text(encoding="utf-8")
    generated = ROOT / "setup" / "slack-app-manifest.generated.yaml"
    generated.write_text(
        manifest_src.replace("REQUEST_URL", webapp_url or "REQUEST_URL"), encoding="utf-8"
    )
    print(f"  生成しました: {generated}")
    print("  https://api.slack.com/apps → Create New App → From a manifest に貼り付け")
    print("  → Install to Workspace → 台本用チャンネルにボットを招待（/invite @shorts-studio）")
    slack_token = ask("Slackボットトークン (xoxb-...)")
    slack_channel = ask("SlackチャンネルID（チャンネル詳細の最下部に表示）")

    step("5/6 GASのプロパティ設定ファイル生成")
    props = {
        "ANTHROPIC_API_KEY": anthropic_key,
        "SLACK_BOT_TOKEN": slack_token,
        "SLACK_CHANNEL_ID": slack_channel,
        "ADMIN_TOKEN": admin_token,
        "WEBAPP_URL": webapp_url,
        "GITHUB_REPO": repo if github_pat else "",
        "GITHUB_TOKEN": github_pat,
    }
    props_path = write_props_file(props)
    print(f"  生成しました: {props_path}")
    if shutil.which("clasp") and (GAS_DIR / ".clasp.json").exists():
        run(["clasp", "push", "-f"], cwd=GAS_DIR)
        print("  GASへ反映済み。")

    step("6/6 GitHub Actions の Secrets 登録")
    if repo:
        gh_set_secrets(repo, {
            "ANTHROPIC_API_KEY": anthropic_key,
            "GAS_WEBAPP_URL": webapp_url,
            "GAS_ADMIN_TOKEN": admin_token,
            "SLACK_BOT_TOKEN": slack_token,
            "YT_CLIENT_ID": yt_client_id,
            "YT_CLIENT_SECRET": yt_client_secret,
            "YT_REFRESH_TOKEN": yt_refresh,
        })

    print("\n=== 残りの手作業（ここだけは自動化できません） ===")
    print("1. GASエディタを開く（gas/ で `clasp open`）→ applyLocalProps() を実行")
    print("   → 続けて setupAll() を実行（権限承認ダイアログに同意）")
    print("   → Slackにテスト通知が届けば成功。スプレッドシートも自動作成されます")
    print("2. SlackアプリのEvent Subscriptionsで request_url が Verified になっているか確認")
    print("   （setupAll実行後に Retry を押せば通ります）")
    print("3. 最初の数本は YOUTUBE_PRIVACY=private でテスト投稿を推奨（gas/README.md参照）")
    print("\nあとはSlackに「台本」と書き込めば始まります 🎬")
    return 0


if __name__ == "__main__":
    sys.exit(main())
