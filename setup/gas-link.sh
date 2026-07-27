#!/usr/bin/env bash
# claspを既存のGASプロジェクトに紐づける（.clasp.json を作る）。
#
# `clasp clone` を使わないこと: サーバー側のファイルでローカルを上書きするため、
# appsscript.json の webapp 定義が消えて「ライブラリ」デプロイになる事故が起きる。
# ここでは .clasp.json だけを作り、コードはローカル（gitの内容）を正とする。
set -euo pipefail
cd "$(dirname "$0")/../gas"

script_id="${1:-}"
if [ -z "$script_id" ]; then
  echo "GASのスクリプトIDを入力してください"
  echo "（GASエディタ > プロジェクトの設定 > スクリプト ID）"
  read -r -p "スクリプトID: " script_id
fi
[ -n "$script_id" ] || { echo "スクリプトIDが空です" >&2; exit 1; }

cat > .clasp.json <<EOF
{
  "scriptId": "$script_id",
  "rootDir": "src"
}
EOF
echo "✅ gas/.clasp.json を作成しました"
echo "   次: make gas-push でローカルのコードを反映してください"
