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

/**
 * ダッシュボードからのショート操作（個別 = short_id / 一括 = 'all'）。
 *   approve     承認待ち → 承認済み（次の投稿枠で自動投稿）
 *   reject      承認待ち・承認済み・予約済み → 却下（予約は取り下げ）
 *   publish_now 即時投稿（承認を兼ねる。予約時刻を今にしてActionsを起動）
 */
function dashShortAction(token, action, target) {
  requireDashToken(token);
  var ALLOWED = {
    approve: [SHORT_STATUS.STOCK],
    reject: [SHORT_STATUS.STOCK, SHORT_STATUS.APPROVED, SHORT_STATUS.SCHEDULED],
    publish_now: [SHORT_STATUS.STOCK, SHORT_STATUS.APPROVED, SHORT_STATUS.SCHEDULED],
  };
  var statuses = ALLOWED[action];
  if (!statuses) return '不明な操作です: ' + action;
  var rows = readTable(SHEET.SHORTS).filter(function (r) {
    return String(r.kind || 'short') !== 'wide' && statuses.indexOf(String(r.status)) >= 0;
  });
  var targets = target === 'all' ? rows : rows.filter(function (r) {
    return String(r.short_id) === String(target);
  });
  if (!targets.length) return '対象のショートがありません';

  var now = fmtDateTime(nowJst());
  targets.forEach(function (r) {
    if (action === 'approve') {
      updateRowsWhere(SHEET.SHORTS, 'short_id', r.short_id, { status: SHORT_STATUS.APPROVED });
    } else if (action === 'reject') {
      updateRowsWhere(SHEET.SHORTS, 'short_id', r.short_id,
        { status: SHORT_STATUS.REJECTED, scheduled_at: '' });
    } else {
      updateRowsWhere(SHEET.SHORTS, 'short_id', r.short_id,
        { status: SHORT_STATUS.SCHEDULED, scheduled_at: now });
    }
  });
  var titles = targets.map(function (r) { return '「' + r.title + '」'; }).join(' ');
  logEvent('dash_' + action, targets.map(function (r) { return r.short_id; }).join(','));

  if (action === 'approve') {
    notifySlack(':white_check_mark: ' + targets.length + '本を承認しました（ダッシュボードから）: ' + titles +
      '\n次の投稿枠でYouTubeへ自動投稿します。');
    return targets.length + '本を承認しました';
  }
  if (action === 'reject') {
    notifySlack(':wastebasket: ' + targets.length + '本を却下しました（ダッシュボードから）: ' + titles);
    return targets.length + '本を却下しました';
  }
  var dispatched = triggerGithub('publish-requested');
  notifySlack(':rocket: ' + targets.length + '本を今すぐ投稿します（ダッシュボードから）: ' + titles +
    (dispatched ? '' : '\n（Actions未設定のため次の毎時実行で投稿されます）'));
  return targets.length + '本を投稿キューに入れました' +
    (dispatched ? '。数分でYouTubeへアップロードされます' : '。次の毎時実行で投稿されます');
}

/** ダッシュボードからの再生数更新 */
function dashSyncStats(token) {
  requireDashToken(token);
  return syncYoutubeStats();
}

/** ダッシュボードからの自己分析実行 */
function dashRunReview(token) {
  requireDashToken(token);
  return runSelfReview();
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
    '<button class="tabbtn" id="tab-ana" onclick="show(\'ana\')">📊分析<br>&nbsp;</button>',
    '</div>'
  );

  // ⏳ 承認待ち
  html.push('<div class="sec" id="sec-stock">');
  if (stock.length) {
    html.push('<div class="card"><div class="body">',
      '<button class="ok" onclick="sact(\'approve\',\'all\',\'承認待ちを全部承認しますか？\')">✔ 全部承認</button>',
      '<button class="ng" onclick="sact(\'reject\',\'all\',\'承認待ちを全部却下しますか？\')">✖ 全部却下</button>',
      '</div></div>');
  } else {
    html.push('<div class="empty">承認待ちはありません</div>');
  }
  stock.forEach(function (r) {
    var code = shortCode(r.short_id);
    html.push(dashCard(r.slack_file_id,
      '<div class="title">' + escapeHtml(r.title) + '</div>' +
      '<div class="meta">コード ' + escapeHtml(code) + ' / ' + escapeHtml(r.score) + '点' +
      (String(r.visual_score || '') ? ' / 見た目' + escapeHtml(r.visual_score) + '点' : '') + ' / ' +
      escapeHtml(r.duration) + '秒 / ' + escapeHtml(r.created_at) + '</div>' +
      '<button class="ok" onclick="sact(\'approve\',\'' + escapeHtml(r.short_id) + '\')">承認</button>' +
      '<button class="rb" onclick="sact(\'publish_now\',\'' + escapeHtml(r.short_id) +
      '\',\'今すぐYouTubeに投稿しますか？（承認を兼ねます）\')">🚀 今すぐ投稿</button>' +
      '<button class="ng" onclick="sact(\'reject\',\'' + escapeHtml(r.short_id) + '\',\'却下しますか？\')">却下</button>',
      r.thumb));
  });
  html.push('</div>');

  // 📅 投稿予約（予約済み → 承認済みの順）
  html.push('<div class="sec" id="sec-queue">');
  if (approved.length || scheduled.length) {
    html.push('<div class="card"><div class="body">',
      '<button class="rb" onclick="sact(\'publish_now\',\'all\',',
      '\'予約中を全部今すぐ投稿しますか？（YouTube APIの上限 約6本/日に注意）\')">🚀 全部今すぐ投稿</button>',
      '</div></div>');
  } else {
    html.push('<div class="empty">予約はありません</div>');
  }
  scheduled.forEach(function (r) {
    html.push(dashCard(r.slack_file_id,
      '<div class="title">' + escapeHtml(r.title) + '</div>' +
      '<div class="meta">🕐 ' + escapeHtml(r.scheduled_at) + ' に投稿予定（' + escapeHtml(r.score) + '点）</div>' +
      '<button class="rb" onclick="sact(\'publish_now\',\'' + escapeHtml(r.short_id) +
      '\',\'今すぐYouTubeに投稿しますか？\')">🚀 今すぐ投稿</button>' +
      '<button class="ng" onclick="sact(\'reject\',\'' + escapeHtml(r.short_id) +
      '\',\'予約を取り下げて却下しますか？\')">取り下げ</button>', r.thumb));
  });
  approved.forEach(function (r) {
    html.push(dashCard(r.slack_file_id,
      '<div class="title">' + escapeHtml(r.title) + '</div>' +
      '<div class="meta">承認済み・次の毎時処理で投稿枠を割当て（' + escapeHtml(r.score) + '点）</div>' +
      '<button class="rb" onclick="sact(\'publish_now\',\'' + escapeHtml(r.short_id) +
      '\',\'今すぐYouTubeに投稿しますか？\')">🚀 今すぐ投稿</button>' +
      '<button class="ng" onclick="sact(\'reject\',\'' + escapeHtml(r.short_id) +
      '\',\'承認を取り消して却下しますか？\')">取り下げ</button>', r.thumb));
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

  // 📊 分析（再生ランキング・修正の方向性・テーマ成績）
  var insightRows = readTable(SHEET.INSIGHTS).reverse().slice(0, 12);
  var ranked = notWide.filter(function (r) { return String(r.status) === SHORT_STATUS.PUBLISHED; })
    .sort(function (a, b) { return (Number(b.views) || 0) - (Number(a.views) || 0); })
    .slice(0, 10);
  var themes = readTable(SHEET.THEMES)
    .sort(function (a, b) { return (Number(b.weight) || 0) - (Number(a.weight) || 0); });
  var INSIGHT_LABEL = { insight: '所見', fix_question: '質問の修正', fix_neta: 'ネタの修正', fix_structure: '構成の修正' };

  html.push('<div class="sec" id="sec-ana">');
  html.push(
    '<div class="card"><div class="body">',
    '<button class="rb" onclick="runjob(\'dashSyncStats\')">▶ 再生数を更新</button>',
    '<button class="rb" onclick="runjob(\'dashRunReview\')">▶ 自己分析を実行</button>',
    '<div class="meta" style="margin-top:6px">毎週月曜にも自動実行されます。分析結果は次回の台本の質問・ネタと、編集プランの構成に自動反映されます。</div>',
    '</div></div>'
  );

  html.push('<h2 style="font-size:15px;margin:16px 4px 8px;color:#ffe600">🧭 修正の方向性（自己分析の履歴）</h2>');
  if (!insightRows.length) html.push('<div class="empty">まだ分析がありません。「自己分析を実行」を押してください</div>');
  insightRows.forEach(function (r) {
    var kind = String(r.kind);
    html.push('<div class="card"><div class="body">',
      '<div class="meta"><span class="badge', kind === 'insight' ? '' : ' done', '">',
      escapeHtml(INSIGHT_LABEL[kind] || kind), '</span>', escapeHtml(r.created_at), '</div>',
      '<div>', escapeHtml(r.text), '</div></div></div>');
  });

  html.push('<h2 style="font-size:15px;margin:16px 4px 8px;color:#ffe600">📈 再生ランキング</h2>');
  if (!ranked.length) html.push('<div class="empty">再生データがまだありません（投稿後「再生数を更新」で取得）</div>');
  ranked.forEach(function (r, i) {
    html.push(dashCard(r.slack_file_id,
      '<div class="title">' + (i + 1) + '位 ' + escapeHtml(r.title) + '</div>' +
      '<div class="meta">▶ ' + escapeHtml(r.views || '0') + '回 / 👍 ' + escapeHtml(r.likes || '0') +
      ' / スコア' + escapeHtml(r.score) + '点 / ' + escapeHtml(r.published_at) + '</div>', r.thumb));
  });

  html.push('<h2 style="font-size:15px;margin:16px 4px 8px;color:#ffe600">🎯 テーマ成績（重み順）</h2>');
  themes.slice(0, 10).forEach(function (t) {
    html.push('<div class="card"><div class="body"><div class="title">', escapeHtml(t.theme), '</div>',
      '<div class="meta">重み ', escapeHtml(t.weight), ' / 喋れた ', escapeHtml(t.hits || 0),
      ' / 飛ばした ', escapeHtml(t.misses || 0), '</div></div></div>');
  });
  var suspended = themes.filter(function (t) { return !(Number(t.weight) > 0); });
  if (suspended.length) {
    html.push('<div class="empty">休止中（重み0）: ' +
      suspended.map(function (t) { return escapeHtml(t.theme); }).join(' / ') + '</div>');
  }
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
    'show(["stock","queue","pub","vid","ana"].indexOf(location.hash.slice(1))>=0?location.hash.slice(1):"stock");',
    'function say(m){var t=document.getElementById("toast");t.style.background="#2b6e3f";',
    't.textContent=m;t.style.display="block";return t}',
    'function toast(m){say(m);setTimeout(function(){location.reload()},1500)}',
    'function runjob(fn){say("実行中…（分析は1分ほどかかることがあります）");',
    'google.script.run.withSuccessHandler(function(m){say(m);',
    'setTimeout(function(){location.reload()},4000)}).withFailureHandler(fail)[fn](TOKEN)}',
    'function fail(e){var t=document.getElementById("toast");t.textContent="エラー: "+e.message;',
    't.style.background="#8a2b2b";t.style.display="block"}',
    'function sact(action,id,msg){if(msg&&!confirm(msg))return;',
    'say("実行中…");',
    'google.script.run.withSuccessHandler(toast).withFailureHandler(fail).dashShortAction(TOKEN,action,id)}',
    'function reedit(id){var v=document.getElementById("ins_"+id).value.trim();',
    'if(!v){alert("指示を入力してください");return}',
    'google.script.run.withSuccessHandler(toast).withFailureHandler(fail).dashReedit(TOKEN,id,v)}',
    '</script>'
  );

  return HtmlService.createHtmlOutput(html.join(''))
    .setTitle('Shorts ダッシュボード')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
