#!/usr/bin/env bash
# ローカル実行環境の一発構築（Ubuntu想定）。何度実行しても安全。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== 1/4 システム依存（ffmpeg・日本語フォント・SVG変換・venv） ==="
missing=()
command -v ffmpeg >/dev/null || missing+=(ffmpeg)
command -v rsvg-convert >/dev/null || missing+=(librsvg2-bin)
fc-list 2>/dev/null | grep -qi "Noto Sans CJK" || missing+=(fonts-noto-cjk)
# Debian/Ubuntuでは venv が別パッケージなので、python3 -m venv の可否で判定する
python3 -c "import venv, ensurepip" 2>/dev/null || missing+=("python3-venv" python3-pip)
if [ ${#missing[@]} -gt 0 ]; then
  echo "  インストールします: ${missing[*]}（sudoパスワードを聞かれることがあります）"
  sudo apt-get update -qq && sudo apt-get install -y "${missing[@]}"
else
  echo "  すべて揃っています"
fi

echo "=== 2/4 Python環境（pipeline/.venv） ==="
# 前回失敗して壊れたvenvが残っていると作り直せないため、一度消す
[ -x pipeline/.venv/bin/python3 ] || rm -rf pipeline/.venv
python3 -m venv pipeline/.venv
pipeline/.venv/bin/pip install -q -U pip
pipeline/.venv/bin/pip install -q -e ./pipeline pytest
echo "  ytshorts $(pipeline/.venv/bin/ytshorts --help >/dev/null 2>&1 && echo OK)"

echo "=== 3/4 ワークスペース初期化 ==="
(cd pipeline && .venv/bin/ytshorts init)

echo "=== 4/4 .env（APIキー置き場） ==="
if [ ! -f .env ]; then
  cp .env.example .env
  echo "  .env を作成しました。エディタで開いて値を埋めてください"
else
  echo "  .env は既にあります"
fi

echo ""
echo "✅ セットアップ完了。次にやること:"
echo "  1. .env にキー類を記入（値の場所は .env 内のコメント参照）"
echo "  2. make test    … 動作確認（78件以上パスすればOK）"
echo "  3. make pull    … Slackの新着動画を取り込んで処理"
echo "  4. make help    … 全コマンド一覧"
