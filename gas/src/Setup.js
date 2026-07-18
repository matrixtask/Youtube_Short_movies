/**
 * Setup.js — 初期化をまとめて実行する
 *
 * 使い方（setup/setup.py のウィザードを使った場合）:
 *   1. GASエディタで applyLocalProps() を実行（SetupProps.local.js はウィザードが生成）
 *   2. 続けて setupAll() を実行（初回は権限の承認ダイアログが出る）
 *   これだけ。スプレッドシートも自動で作られる。
 */

function setupAll() {
  var msgs = [];
  msgs.push(setupSpreadsheet());
  msgs.push('トリガー: ' + installTriggers());
  try {
    sendSlack(':wave: セットアップ完了！毎朝 ' + getProp('SHOOT_HOUR', '8') + '時台に撮影台本が届きます。今すぐ試すにはこのチャンネルに「台本」と書き込んでください。');
    msgs.push('Slack通知: OK');
  } catch (e) {
    msgs.push('Slack通知: 失敗 (' + e + ') — SLACK_BOT_TOKEN / SLACK_CHANNEL_ID を確認してください');
  }
  var report = msgs.join('\n');
  console.log(report);
  return report;
}
