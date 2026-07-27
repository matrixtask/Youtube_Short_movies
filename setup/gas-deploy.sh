#!/usr/bin/env bash
# GAS Webアプリの再デプロイ。既存デプロイを更新するのでURLは変わらない。
# （新規デプロイを作るとURLが変わり、Slack/GitHub Secretsの再設定が必要になるため）
#
# デプロイが複数ある場合に取り違えないよう、.env の GAS_DEPLOYMENT_ID を優先する。
# 未設定なら候補を一覧表示して選ばせる。
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a

# 前提チェック。ここで落としておかないと、失敗に気づかないまま
# 「デプロイしたのに反映されない」という状態になる
if [ ! -f gas/.clasp.json ]; then
  echo "✗ gas/.clasp.json がありません（claspがプロジェクトに紐づいていません）" >&2
  echo "  復旧: make gas-link  （GASのスクリプトIDを聞かれます）" >&2
  exit 1
fi
# マニフェストに webapp 定義が無いままデプロイすると「ライブラリ」種別になり、
# URLを叩いてもWebアプリとして応答しない（clasp cloneでの上書き事故が典型）
if ! grep -q '"webapp"' gas/src/appsscript.json; then
  echo "✗ gas/src/appsscript.json に webapp の定義がありません" >&2
  echo "  このままデプロイするとライブラリ扱いになり、Slackから叩けません" >&2
  echo "  復旧: git checkout gas/src/appsscript.json && make gas-push" >&2
  exit 1
fi

cd gas

# 「@HEAD」は開発用の常設枠なので更新対象から除く
mapfile -t deployments < <(clasp deployments | grep -oE 'AKfycb[A-Za-z0-9_-]+ @[0-9]+' || true)

dep_id="${GAS_DEPLOYMENT_ID:-}"

if [ -n "$dep_id" ]; then
  echo "GAS_DEPLOYMENT_ID を使用: $dep_id"
elif [ "${#deployments[@]}" -eq 1 ]; then
  dep_id=$(echo "${deployments[0]}" | awk '{print $1}')
  echo "デプロイを1件検出: $dep_id"
elif [ "${#deployments[@]}" -gt 1 ]; then
  echo "デプロイが複数あります。SlackのRequest URLと一致するものを選んでください:"
  for i in "${!deployments[@]}"; do
    echo "  [$i] https://script.google.com/macros/s/$(echo "${deployments[$i]}" | awk '{print $1}')/exec"
  done
  read -r -p "番号: " idx
  dep_id=$(echo "${deployments[$idx]}" | awk '{print $1}')
  echo ""
  echo "💡 次回から選択を省くには .env に追記してください:"
  echo "   GAS_DEPLOYMENT_ID=$dep_id"
fi

if [ -n "$dep_id" ]; then
  echo "既存デプロイ ${dep_id} を更新します（URL不変）…"
  clasp deploy -i "$dep_id" --description "deploy $(date +%Y-%m-%d_%H%M)"
else
  echo "デプロイが無いため新規作成します…"
  out=$(clasp deploy --description "initial deploy")
  echo "$out"
  dep_id=$(echo "$out" | grep -oE 'AKfycb[A-Za-z0-9_-]+' | head -1)
  echo ""
  echo "⚠ 新規デプロイのため、このURLを以下に設定してください:"
  echo "   - SlackアプリのEvent Subscriptions Request URL"
  echo "   - GASプロパティ WEBAPP_URL / GitHub Secret GAS_WEBAPP_URL / .env"
fi

echo "WebアプリURL: https://script.google.com/macros/s/${dep_id}/exec"
