/**
 * Dashboard.js — ブラウザで見る運用ダッシュボード
 *
 * URL: <WebアプリURL>?token=<ADMIN_TOKEN>&page=dash （make dash で開ける）
 *
 * 見えるもの:
 *   - 承認待ちショート（承認・却下ボタン付き）
 *   - 投稿予約（承認済みの枠待ち + 予約時刻）と投稿済み（YouTubeリンク）
 *   - 動画キュー（状態・処理ワーカー・編集指示。再編集の指示もここから送れる）
 *
 * ボタンは google.script.run 経由でこのプロジェクトの関数を呼ぶ。
 * Webアプリは「全員」公開なので、各関数の先頭で必ずトークンを検証する。
 */

function requireDashToken(token) {
  if (!token || token !== getProp('ADMIN_TOKEN')) throw new Error('unauthorized');
}

/** ダッシュボードからの承認・却下（Slackの「承認 xxxx」と同じ処理・同じ通知） */
function dashApprove(token, code, approve) {
  requireDashToken(token);
  handleApprovalCommand((approve ? '承認 ' : '却下 ') + String(code || ''));
  return approve ? '承認しました' : '却下しました';
}

/** ダッシュボードからの再編集指示（Slackの「再編集 <指示>」と同じ処理） */
function dashReedit(token, videoId, body) {
  requireDashToken(token);
  body = String(body || '').trim();
  if (!body) return '指示が空です';
  var rows = readTable(SHEET.VIDEOS).filter(function (r) {
    return String(r.video_id) === String(videoId);
  });
  if (!rows.length) return '動画が見つかりません';
  var v = rows[rows.length - 1];
  updateRowsWhere(SHEET.VIDEOS, 'video_id', v.video_id, {
    instructions: body.slice(0, 500),
    status: VIDEO_STATUS.PENDING,
    claimed_at: '',
    claimed_by: '',
  });
  var dispatched = triggerGithub('video-uploaded');
  notifySlack(
    ':repeat: ' + String(v.file_name) + ' を新しい指示で編集し直します（ダッシュボードから）:\n> ' + body +
    (dispatched ? '' : '\n次の処理タイミング（毎時 or make pull）で実行されます。'),
    rawSlackTs(v.thread_ts) || undefined
  );
  logEvent('video_reedit', v.video_id + ' (dash): ' + body.slice(0, 100));
  return '「' + v.file_name + '」を再編集キューに入れました';
}

function escapeHtml(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

var DASH_VIDEO_LABEL = {
  pending: '処理待ち',
  processing: '処理中',
  done: '完了',
  failed: '失敗',
};

function renderDashboard(token) {
  var shorts = readTable(SHEET.SHORTS);
  var videos = readTable(SHEET.VIDEOS);
  var notWide = shorts.filter(function (r) { return String(r.kind || 'short') !== 'wide'; });

  var stock = notWide.filter(function (r) { return String(r.status) === SHORT_STATUS.STOCK; }).reverse();
  var approved = notWide.filter(function (r) { return String(r.status) === SHORT_STATUS.APPROVED; });
  var scheduled = notWide.filter(function (r) { return String(r.status) === SHORT_STATUS.SCHEDULED; })
    .sort(function (a, b) { return String(a.scheduled_at) < String(b.scheduled_at) ? -1 : 1; });
  var published = notWide.filter(function (r) { return String(r.status) === SHORT_STATUS.PUBLISHED; })
    .reverse().slice(0, 15);

  var html = [];
  html.push(
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Shorts ダッシュボード</title>',
    '<style>',
    'body{font-family:sans-serif;margin:0;background:#0b1f3a;color:#eee;padding:12px 12px 60px}',
    'h1{font-size:18px;margin:8px 4px}h2{font-size:15px;margin:20px 4px 8px;color:#ffe600}',
    '.card{background:#152b4d;border-radius:10px;padding:10px 12px;margin-bottom:8px}',
    '.title{font-weight:bold;margin-bottom:4px}',
    '.meta{font-size:12px;color:#9fb3d1;margin-bottom:6px}',
    '.badge{display:inline-block;font-size:11px;border-radius:4px;padding:1px 6px;margin-right:6px;background:#274a80}',
    '.badge.failed{background:#8a2b2b}.badge.processing{background:#8a6d1f}.badge.done{background:#2b6e3f}',
    'button{border:0;border-radius:6px;padding:8px 14px;margin-right:6px;font-size:13px;cursor:pointer}',
    '.ok{background:#2b6e3f;color:#fff}.ng{background:#8a2b2b;color:#fff}.rb{background:#274a80;color:#fff}',
    'input[type=text]{width:100%;box-sizing:border-box;padding:8px;border-radius:6px;border:0;margin:4px 0;font-size:13px}',
    'a{color:#7fc4ff}.empty{color:#9fb3d1;font-size:13px;margin:4px}',
    '#toast{position:fixed;bottom:12px;left:12px;right:12px;background:#2b6e3f;color:#fff;',
    'padding:10px;border-radius:8px;display:none;font-size:13px;z-index:9}',
    '</style></head><body>',
    '<h1>🎬 Shorts ダッシュボード <button class="rb" onclick="location.reload()">更新</button></h1>'
  );

  // 承認待ち
  html.push('<h2>⏳ 承認待ち（' + stock.length + '本）</h2>');
  if (!stock.length) html.push('<div class="empty">承認待ちはありません</div>');
  stock.forEach(function (r) {
    var code = shortCode(r.short_id);
    html.push(
      '<div class="card"><div class="title">', escapeHtml(r.title), '</div>',
      '<div class="meta">コード ', escapeHtml(code), ' / ', escapeHtml(r.score), '点 / ',
      escapeHtml(r.duration), '秒 / ', escapeHtml(r.created_at), '</div>',
      '<button class="ok" onclick="approve(\'', escapeHtml(code), '\',true)">承認</button>',
      '<button class="ng" onclick="approve(\'', escapeHtml(code), '\',false)">却下</button></div>'
    );
  });

  // 投稿予約
  html.push('<h2>📅 投稿予約（枠待ち' + approved.length + ' / 予約済み' + scheduled.length + '）</h2>');
  if (!approved.length && !scheduled.length) html.push('<div class="empty">予約はありません</div>');
  scheduled.forEach(function (r) {
    html.push('<div class="card"><div class="title">', escapeHtml(r.title), '</div>',
      '<div class="meta">🕐 ', escapeHtml(r.scheduled_at), ' に投稿予定（', escapeHtml(r.score), '点）</div></div>');
  });
  approved.forEach(function (r) {
    html.push('<div class="card"><div class="title">', escapeHtml(r.title), '</div>',
      '<div class="meta">承認済み・次の毎時処理で投稿枠を割当て（', escapeHtml(r.score), '点）</div></div>');
  });

  // 投稿済み
  html.push('<h2>📺 投稿済み（直近' + published.length + '本）</h2>');
  if (!published.length) html.push('<div class="empty">まだ投稿はありません</div>');
  published.forEach(function (r) {
    html.push('<div class="card"><div class="title">', escapeHtml(r.title), '</div>',
      '<div class="meta">', escapeHtml(r.published_at), ' / ',
      '<a href="', escapeHtml(r.youtube_url), '" target="_blank">', escapeHtml(r.youtube_url), '</a></div></div>');
  });

  // 動画キュー + 再編集
  var recentVideos = videos.reverse().slice(0, 15);
  html.push('<h2>🎥 動画キューと編集指示（直近' + recentVideos.length + '本）</h2>');
  if (!recentVideos.length) html.push('<div class="empty">動画はまだありません</div>');
  recentVideos.forEach(function (r) {
    var st = String(r.status);
    html.push(
      '<div class="card"><div class="title">', escapeHtml(r.file_name), '</div>',
      '<div class="meta"><span class="badge ', escapeHtml(st), '">', escapeHtml(DASH_VIDEO_LABEL[st] || st), '</span>',
      escapeHtml(r.created_at),
      r.claimed_by ? ' / ワーカー: ' + escapeHtml(r.claimed_by) : '',
      '</div>'
    );
    if (String(r.instructions || '')) {
      html.push('<div class="meta">📝 指示: ', escapeHtml(r.instructions), '</div>');
    }
    html.push(
      '<input type="text" id="ins_', escapeHtml(r.video_id), '" placeholder="再編集の指示（例: テロップを大きく）">',
      '<button class="rb" onclick="reedit(\'', escapeHtml(r.video_id), '\')">再編集</button></div>'
    );
  });

  html.push(
    '<div id="toast"></div>',
    '<script>',
    'var TOKEN = ', JSON.stringify(String(token)), ';',
    'function toast(m){var t=document.getElementById("toast");t.textContent=m;t.style.display="block";',
    'setTimeout(function(){location.reload()},1500)}',
    'function fail(e){var t=document.getElementById("toast");t.textContent="エラー: "+e.message;',
    't.style.background="#8a2b2b";t.style.display="block"}',
    'function approve(code,ok){if(!ok&&!confirm("却下しますか？"))return;',
    'google.script.run.withSuccessHandler(toast).withFailureHandler(fail).dashApprove(TOKEN,code,ok)}',
    'function reedit(id){var v=document.getElementById("ins_"+id).value.trim();',
    'if(!v){alert("指示を入力してください");return}',
    'google.script.run.withSuccessHandler(toast).withFailureHandler(fail).dashReedit(TOKEN,id,v)}',
    '</script></body></html>'
  );

  return HtmlService.createHtmlOutput(html.join(''))
    .setTitle('Shorts ダッシュボード')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
