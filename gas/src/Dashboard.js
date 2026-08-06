/**
 * Dashboard.js — ブラウザで見る運用ダッシュボード
 *
 * URL: <WebアプリURL>?token=<ADMIN_TOKEN>&page=dash （make dash で開ける）
 *
 * タブ構成:
 *   ⏳ 承認待ち   … サムネ付き一覧 + 承認/却下ボタン
 *   📅 投稿予約   … 承認済み（枠待ち）と予約済み（投稿時刻付き）
 *   📺 投稿済み   … YouTubeリンク付き
 *   🎥 動画キュー … 状態・ワーカー・編集指示。再編集の指示もここから送れる
 *
 * サムネはSlackのファイルサムネ（要Bearer認証）をGAS側で取得して
 * data URIとして埋め込む。ブラウザからSlackへ直接は取れないため。
 * ボタンは google.script.run 経由。Webアプリは「全員」公開なので
 * 各関数の先頭で必ずトークンを検証する。
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

/**
 * Slackファイルのサムネを data URI で返す（無ければ空文字）。
 * 認証付きURLのためサーバー側で取得し、6時間キャッシュする。
 */
function slackThumbDataUri(fileId) {
  if (!fileId) return '';
  var cache = CacheService.getScriptCache();
  var key = 'thumb_' + fileId;
  var hit = cache.get(key);
  if (hit === 'none') return '';
  if (hit) return hit;
  var uri = '';
  try {
    var token = requireProp('SLACK_BOT_TOKEN');
    var info = JSON.parse(UrlFetchApp.fetch(
      'https://slack.com/api/files.info?file=' + encodeURIComponent(fileId),
      { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true }
    ).getContentText());
    var f = (info && info.file) || {};
    var url = f.thumb_video || f.thumb_360 || f.thumb_480 || f.thumb_160 || '';
    if (url) {
      var res = UrlFetchApp.fetch(url, {
        headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true,
      });
      if (res.getResponseCode() === 200) {
        var blob = res.getBlob();
        uri = 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes());
      }
    }
  } catch (e) {
    uri = '';
  }
  // CacheServiceの上限（1キー100KB）に収まるものだけキャッシュする
  cache.put(key, uri && uri.length < 95000 ? uri : 'none', 21600);
  return uri;
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

/** パイプラインが送ってきたサムネの検証（壊れた値や巨大な値はセルに入れない） */
function dashSafeThumb(thumb) {
  var t = String(thumb || '');
  return t.indexOf('data:image/') === 0 && t.length < 49000 ? t : '';
}

/**
 * サムネ付きカード。body は中身のHTML（エスケープ済みで渡す）。
 * thumb（シート保存のdata URI）があれば即表示、無ければSlackサムネにフォールバック。
 */
function dashCard(fileId, body, thumb) {
  thumb = dashSafeThumb(thumb) || slackThumbDataUri(fileId);
  return '<div class="card">' +
    (thumb ? '<img class="thumb" src="' + thumb + '" alt="">' : '<div class="thumb noimg">🎬</div>') +
    '<div class="body">' + body + '</div></div>';
}

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
  var recentVideos = videos.reverse().slice(0, 15);

  var html = [];
  html.push(
    '<style>',
    'body{font-family:sans-serif;margin:0;background:#0b1f3a;color:#eee;padding:12px 12px 60px}',
    'h1{font-size:18px;margin:8px 4px}',
    '.tabs{display:flex;gap:6px;position:sticky;top:0;background:#0b1f3a;padding:8px 0;z-index:5}',
    '.tabbtn{flex:1;border:0;border-radius:8px;padding:10px 4px;font-size:13px;cursor:pointer;',
    'background:#152b4d;color:#9fb3d1}',
    '.tabbtn.active{background:#ffe600;color:#0b1f3a;font-weight:bold}',
    '.sec{display:none}.sec.active{display:block}',
    '.card{background:#152b4d;border-radius:10px;padding:10px 12px;margin-bottom:8px;display:flex;gap:12px}',
    '.thumb{width:78px;flex:none;border-radius:6px;object-fit:cover;align-self:flex-start}',
    '.noimg{height:120px;display:flex;align-items:center;justify-content:center;background:#274a80;font-size:26px}',
    '.body{flex:1;min-width:0}',
    '.title{font-weight:bold;margin-bottom:4px;word-break:break-all}',
    '.meta{font-size:12px;color:#9fb3d1;margin-bottom:6px;word-break:break-all}',
    '.badge{display:inline-block;font-size:11px;border-radius:4px;padding:1px 6px;margin-right:6px;background:#274a80}',
    '.badge.failed{background:#8a2b2b}.badge.processing{background:#8a6d1f}.badge.done{background:#2b6e3f}',
    'button{border:0;border-radius:6px;padding:8px 14px;margin-right:6px;font-size:13px;cursor:pointer}',
    '.ok{background:#2b6e3f;color:#fff}.ng{background:#8a2b2b;color:#fff}.rb{background:#274a80;color:#fff}',
    'input[type=text]{width:100%;box-sizing:border-box;padding:8px;border-radius:6px;border:0;margin:4px 0;font-size:13px}',
    'a{color:#7fc4ff}.empty{color:#9fb3d1;font-size:13px;margin:8px 4px}',
    '#toast{position:fixed;bottom:12px;left:12px;right:12px;background:#2b6e3f;color:#fff;',
    'padding:10px;border-radius:8px;display:none;font-size:13px;z-index:9}',
    '</style>',
    '<h1>🎬 Shorts ダッシュボード <button class="rb" onclick="location.reload()">更新</button></h1>',
    '<div class="tabs">',
    '<button class="tabbtn" id="tab-stock" onclick="show(\'stock\')">⏳承認待ち<br>' + stock.length + '</button>',
    '<button class="tabbtn" id="tab-queue" onclick="show(\'queue\')">📅投稿予約<br>' + (approved.length + scheduled.length) + '</button>',
    '<button class="tabbtn" id="tab-pub" onclick="show(\'pub\')">📺投稿済み<br>' + published.length + '</button>',
    '<button class="tabbtn" id="tab-vid" onclick="show(\'vid\')">🎥動画<br>' + recentVideos.length + '</button>',
    '</div>'
  );

  // ⏳ 承認待ち
  html.push('<div class="sec" id="sec-stock">');
  if (!stock.length) html.push('<div class="empty">承認待ちはありません</div>');
  stock.forEach(function (r) {
    var code = shortCode(r.short_id);
    html.push(dashCard(r.slack_file_id, 
      '<div class="title">' + escapeHtml(r.title) + '</div>' +
      '<div class="meta">コード ' + escapeHtml(code) + ' / ' + escapeHtml(r.score) + '点 / ' +
      escapeHtml(r.duration) + '秒 / ' + escapeHtml(r.created_at) + '</div>' +
      '<button class="ok" onclick="approve(\'' + escapeHtml(code) + '\',true)">承認</button>' +
      '<button class="ng" onclick="approve(\'' + escapeHtml(code) + '\',false)">却下</button>', r.thumb));
  });
  html.push('</div>');

  // 📅 投稿予約（予約済み → 承認済みの順）
  html.push('<div class="sec" id="sec-queue">');
  if (!approved.length && !scheduled.length) html.push('<div class="empty">予約はありません</div>');
  scheduled.forEach(function (r) {
    html.push(dashCard(r.slack_file_id, 
      '<div class="title">' + escapeHtml(r.title) + '</div>' +
      '<div class="meta">🕐 ' + escapeHtml(r.scheduled_at) + ' に投稿予定（' + escapeHtml(r.score) + '点）</div>', r.thumb));
  });
  approved.forEach(function (r) {
    html.push(dashCard(r.slack_file_id, 
      '<div class="title">' + escapeHtml(r.title) + '</div>' +
      '<div class="meta">承認済み・次の毎時処理で投稿枠を割当て（' + escapeHtml(r.score) + '点）</div>', r.thumb));
  });
  html.push('</div>');

  // 📺 投稿済み
  html.push('<div class="sec" id="sec-pub">');
  if (!published.length) html.push('<div class="empty">まだ投稿はありません</div>');
  published.forEach(function (r) {
    html.push(dashCard(r.slack_file_id, 
      '<div class="title">' + escapeHtml(r.title) + '</div>' +
      '<div class="meta">' + escapeHtml(r.published_at) + '</div>' +
      '<div class="meta"><a href="' + escapeHtml(r.youtube_url) + '" target="_blank">' +
      escapeHtml(r.youtube_url) + '</a></div>', r.thumb));
  });
  html.push('</div>');

  // 🎥 動画キュー + 再編集
  html.push('<div class="sec" id="sec-vid">');
  if (!recentVideos.length) html.push('<div class="empty">動画はまだありません</div>');
  recentVideos.forEach(function (r) {
    var st = String(r.status);
    html.push(dashCard(r.file_id,
      '<div class="title">' + escapeHtml(r.file_name) + '</div>' +
      '<div class="meta"><span class="badge ' + escapeHtml(st) + '">' +
      escapeHtml(DASH_VIDEO_LABEL[st] || st) + '</span>' + escapeHtml(r.created_at) +
      (r.claimed_by ? ' / ワーカー: ' + escapeHtml(r.claimed_by) : '') + '</div>' +
      (String(r.instructions || '') ? '<div class="meta">📝 指示: ' + escapeHtml(r.instructions) + '</div>' : '') +
      '<input type="text" id="ins_' + escapeHtml(r.video_id) + '" placeholder="再編集の指示（例: テロップを大きく）">' +
      '<button class="rb" onclick="reedit(\'' + escapeHtml(r.video_id) + '\')">再編集</button>'));
  });
  html.push('</div>');

  html.push(
    '<div id="toast"></div>',
    '<script>',
    'var TOKEN = ', JSON.stringify(String(token)), ';',
    'function show(id){',
    'document.querySelectorAll(".sec").forEach(function(s){s.classList.remove("active")});',
    'document.querySelectorAll(".tabbtn").forEach(function(b){b.classList.remove("active")});',
    'document.getElementById("sec-"+id).classList.add("active");',
    'document.getElementById("tab-"+id).classList.add("active");',
    'location.hash=id}',
    'show(["stock","queue","pub","vid"].indexOf(location.hash.slice(1))>=0?location.hash.slice(1):"stock");',
    'function toast(m){var t=document.getElementById("toast");t.textContent=m;t.style.display="block";',
    'setTimeout(function(){location.reload()},1500)}',
    'function fail(e){var t=document.getElementById("toast");t.textContent="エラー: "+e.message;',
    't.style.background="#8a2b2b";t.style.display="block"}',
    'function approve(code,ok){if(!ok&&!confirm("却下しますか？"))return;',
    'google.script.run.withSuccessHandler(toast).withFailureHandler(fail).dashApprove(TOKEN,code,ok)}',
    'function reedit(id){var v=document.getElementById("ins_"+id).value.trim();',
    'if(!v){alert("指示を入力してください");return}',
    'google.script.run.withSuccessHandler(toast).withFailureHandler(fail).dashReedit(TOKEN,id,v)}',
    '</script>'
  );

  return HtmlService.createHtmlOutput(html.join(''))
    .setTitle('Shorts ダッシュボード')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
