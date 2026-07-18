/**
 * Config.js — スクリプトプロパティと定数
 *
 * 必須プロパティ（GASエディタ > プロジェクトの設定 > スクリプト プロパティ）:
 *   SPREADSHEET_ID      データ管理用スプレッドシートのID
 *   ANTHROPIC_API_KEY   Claude APIキー
 *   SLACK_BOT_TOKEN     Slackボットトークン (xoxb-...)
 *   SLACK_CHANNEL_ID    撮影台本・通知先チャンネルID
 *   ADMIN_TOKEN         ローカル編集パイプライン連携用の長いランダム文字列
 *
 * 任意:
 *   CHANNEL_CONCEPT     チャンネルコンセプト（台本生成の文脈に使う）
 *   CLAUDE_MODEL        既定: claude-sonnet-5
 *   SHOOT_QUESTIONS     1回の台本の質問数（既定: 5）
 *   SHOOT_DAYS          台本を届ける曜日 "MON,WED,FRI" など（既定: 毎日）
 *   SHOOT_HOUR          台本を届ける時刻（既定: 8）
 *   GITHUB_REPO         クラウド実行用 "owner/repo"（GitHub Actionsを即時起動）
 *   GITHUB_TOKEN        repository_dispatch を送れる fine-grained PAT
 *
 * YouTube自動投稿:
 *   AUTO_APPROVE        "true" で承認なしに自動で投稿枠へ（既定: false）
 *   YOUTUBE_SLOT_TIMES  1日の投稿枠 "08:00,19:00"（既定）
 *   MAX_UPLOADS_PER_DAY 1日の最大投稿数（既定: 2）
 *   YOUTUBE_PRIVACY     public | unlisted | private（既定: public）
 */

var SHEET = {
  SCRIPTS: 'Scripts', // 撮影台本（セッション単位）
  QUESTIONS: 'Questions', // 台本内の質問（1行=1問）
  VIDEOS: 'Videos', // Slackに投げられた撮影動画の処理キュー
  SHORTS: 'Shorts', // 生成済みショートの台帳（実体はSlack上のファイル）
  THEMES: 'Themes',
  LOG: 'Log',
};

var SCRIPT_STATUS = {
  OPEN: 'open', // 撮影待ち
  SHOT: 'shot', // 撮影済み（取り込み待ち）
  DONE: 'done', // パイプラインで処理済み
  EXPIRED: 'expired',
};

var SHORT_STATUS = {
  STOCK: 'stock', // 生成済み・承認待ち
  APPROVED: 'approved', // 承認済み・投稿枠待ち
  SCHEDULED: 'scheduled', // 投稿枠割当済み
  PUBLISHED: 'published', // YouTube投稿済み
  REJECTED: 'rejected',
  FAILED: 'failed',
};

function props() {
  return PropertiesService.getScriptProperties().getProperties();
}

function getProp(key, fallback) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  return v === null || v === '' ? (fallback === undefined ? null : fallback) : v;
}

function requireProp(key) {
  var v = getProp(key);
  if (!v) throw new Error('スクリプトプロパティ ' + key + ' が未設定です');
  return v;
}

function isAutoApprove() {
  return String(getProp('AUTO_APPROVE', 'false')).toLowerCase() === 'true';
}

function ytSlotTimes() {
  return String(getProp('YOUTUBE_SLOT_TIMES', '08:00,19:00'))
    .split(',')
    .map(function (s) { return s.trim(); })
    .filter(Boolean);
}

function maxUploadsPerDay() {
  return Number(getProp('MAX_UPLOADS_PER_DAY', '2'));
}

function nowJst() {
  return new Date();
}

function fmtDate(d) {
  return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd');
}

function fmtDateTime(d) {
  return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
}

function newId(prefix) {
  return prefix + '_' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMddHHmmss') + '_' + Math.floor(Math.random() * 10000);
}
