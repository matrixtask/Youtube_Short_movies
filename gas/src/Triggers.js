/**
 * Triggers.js — 定期実行の登録（ルーティン化の心臓部）
 *
 * installTriggers() をGASエディタから1回実行すると:
 *   毎朝 SHOOT_HOUR時台  startDailyShootScript … Slackに撮影台本が届く
 *   毎週月 9時台         weeklyDigest          … 未撮影・未処理の台本をリマインド
 */

var TRIGGER_FUNCS = ['startDailyShootScript', 'weeklyDigest', 'youtubeTick', 'nightlyNotionSync', 'remindPendingVideos'];

function installTriggers() {
  deleteManagedTriggers();
  var hour = Number(getProp('SHOOT_HOUR', '8'));
  ScriptApp.newTrigger('startDailyShootScript').timeBased().atHour(hour).everyDays(1).create();
  ScriptApp.newTrigger('weeklyDigest').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(9).create();
  ScriptApp.newTrigger('youtubeTick').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('nightlyNotionSync').timeBased().atHour(22).everyDays(1).create();
  ScriptApp.newTrigger('remindPendingVideos').timeBased().everyMinutes(30).create();
  logEvent('triggers', 'トリガーを登録しました');
  return 'OK';
}

function deleteManagedTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (TRIGGER_FUNCS.indexOf(t.getHandlerFunction()) >= 0) {
      ScriptApp.deleteTrigger(t);
    }
  });
}

/** 毎週月曜: 撮影・取り込みの滞留をSlackに */
function weeklyDigest() {
  var scripts = readTable(SHEET.SCRIPTS);
  var counts = {};
  scripts.forEach(function (r) { counts[r.status] = (counts[r.status] || 0) + 1; });

  var weekAgo = fmtDateTime(new Date(nowJst().getTime() - 7 * 86400000));
  var doneThisWeek = scripts.filter(function (r) {
    return String(r.status) === SCRIPT_STATUS.DONE && String(r.processed_at) >= weekAgo;
  });

  var lines = [
    ':bar_chart: 週次サマリー（撮影台本）',
    '先週処理した台本: ' + doneThisWeek.length + '件',
    '撮影待ち: ' + (counts[SCRIPT_STATUS.OPEN] || 0) + '件 / 取り込み待ち: ' + (counts[SCRIPT_STATUS.SHOT] || 0) + '件',
  ];
  if ((counts[SCRIPT_STATUS.SHOT] || 0) > 0) {
    lines.push(':warning: 撮影済みで取り込んでいない動画があります。inbox に入れて `ytshorts run` を実行してください。');
  }
  notifySlack(lines.join('\n'));
}

/**
 * トラブルシュート用: 現在の状態をまとめて返す。
 */
function debugStatus() {
  var scripts = readTable(SHEET.SCRIPTS);
  var counts = {};
  scripts.forEach(function (r) { counts[r.status] = (counts[r.status] || 0) + 1; });
  var logs = readTable(SHEET.LOG).slice(-10);
  var report = [
    '=== Scripts: ' + scripts.length + '件 ' + JSON.stringify(counts),
    '=== 直近ログ10件:',
    logs.map(function (l) { return '  ' + l.timestamp + ' ' + l.event + ' ' + String(l.detail).slice(0, 80); }).join('\n'),
    '=== SLACK_CHANNEL_ID: ' + (getProp('SLACK_CHANNEL_ID') || '(未設定)'),
    '=== WEBAPP_URL: ' + (getProp('WEBAPP_URL') || '(未設定)'),
  ].join('\n');
  console.log(report);
  return report;
}
