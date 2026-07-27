#!/usr/bin/env bash
# GAS Webアプリの再デプロイ。既存デプロイを更新するのでURLは変わらない。
# （新規デプロイを作るとURLが変わり、Slack/GitHub Secretsの再設定が必要になるため）
set -euo pipefail
cd "$(dirname "$0")/../gas"

dep_id=$(clasp deployments | awk '/@[0-9]+/{print $2; exit}' || true)

if [ -n "${dep_id:-}" ]; then
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
