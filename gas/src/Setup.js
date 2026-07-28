/**
 * Setup.js — 初期化をまとめて実行する
 *
 * 使い方（setup/setup.py のウィザードを使った場合）:
 *   1. GASエディタで applyLocalProps() を実行（SetupProps.local.js はウィザードが生成）
 *   2. 続けて setupAll() を実行（初回は権限の承認ダイアログが出る）
 *   これだけ。スプレッドシートも自動で作られる。
 */

/**
 * データベース（スプレッドシート）を開く。
 *
 * このプロジェクトはスタンドアロン（シートに紐づいていない）ため、
 * エディタからシートへの導線が無い。この関数を実行すると実行ログに
 * URLが出るので、そこからワンクリックで開ける。
 * さらに、スクリプトプロパティ SPREADSHEET_URL にも保存するので、
 * プロジェクトの設定画面からも辿れる。
 */
function openSpreadsheet() {
  var spreadsheet = ss();
  var url = spreadsheet.getUrl();
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_URL', url);
  console.log('データベース: ' + spreadsheet.getName());
  console.log(url);
  return url;
}

/**
 * スプレッドシートの先頭に「Home」シートを作り、関連ページへのリンクを置く。
 * スタンドアロンのGASプロジェクトはシートのメニューに出せないため、
 * シート側からエディタや管理画面へ戻れる導線をここで用意する。
 */
function buildHomeSheet() {
  var spreadsheet = ss();
  var sheet = spreadsheet.getSheetByName('Home') || spreadsheet.insertSheet('Home', 0);
  spreadsheet.setActiveSheet(sheet);
  spreadsheet.moveActiveSheet(1);
  sheet.clear();

  var scriptUrl = 'https://script.google.com/home/projects/' + ScriptApp.getScriptId() + '/edit';
  var rows = [
    ['YouTube Shorts Studio', ''],
    ['', ''],
    ['GASエディタ（コード・設定・トリガー）', scriptUrl],
    ['Webアプリ（Slack連携の受け口）', String(getProp('WEBAPP_URL') || '(未設定)')],
    ['GitHub Actions（クラウド実行の状況）',
      getProp('GITHUB_REPO') ? 'https://github.com/' + getProp('GITHUB_REPO') + '/actions' : '(未設定)'],
    ['', ''],
    ['シートの見方', ''],
    ['Scripts / Questions', '毎朝の撮影台本と質問'],
    ['Videos', 'Slackに届いた動画の処理キュー（status列を見る）'],
    ['Shorts', '生成したショートの台帳（承認・投稿状況）'],
    ['Themes', 'トークテーマ。weightを0にすると出なくなる'],
    ['Log', '実行ログ（トラブル時はここ）'],
  ];
  sheet.getRange(1, 1, rows.length, 2).setValues(rows);
  sheet.getRange(1, 1).setFontSize(14).setFontWeight('bold');
  sheet.getRange(7, 1).setFontWeight('bold');
  sheet.setColumnWidth(1, 320);
  sheet.setColumnWidth(2, 560);
  logEvent('home_sheet', 'Homeシートを更新しました');
  return spreadsheet.getUrl();
}

function setupAll() {
  var msgs = [];
  msgs.push(setupSpreadsheet());
  msgs.push('データベース: ' + openSpreadsheet());
  try {
    buildHomeSheet();
    msgs.push('Homeシート: OK');
  } catch (e) {
    msgs.push('Homeシート: 失敗 (' + e + ')');
  }
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
