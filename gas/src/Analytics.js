/**
 * Analytics.js — 再生数の取得と自己反省的な改善ループ
 *
 * 1. syncYoutubeStats(): 投稿済みショートの再生数・高評価をYouTube APIから
 *    取得してShortsシートに保存する（views / likes / stats_at 列）
 * 2. runSelfReview(): 実績（再生数・スコア・却下・飛ばされた質問・メモ）を
 *    Claudeに渡し、「質問・ネタ・構成をどう直すか」を言語化させる。
 *    結果は Insights シートに履歴として残り、
 *    スクリプトプロパティ SCRIPT_INSIGHTS が最新の修正方針として
 *      - 台本の質問生成（generateShootQuestions）
 *      - 編集プラン生成（パイプラインの planner。claim時に配布）
 *    の両方へ自動反映される。
 *
 * どちらも weeklyDigest（毎週月曜）から自動実行され、
 * ダッシュボードの📊分析タブから手動でも実行できる。
 */

/** YouTube Data API 用のアクセストークン（アップロードと同じ資格情報を使う） */
function ytAccessToken() {
  var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    payload: {
      client_id: requireProp('YT_CLIENT_ID'),
      client_secret: requireProp('YT_CLIENT_SECRET'),
      refresh_token: requireProp('YT_REFRESH_TOKEN'),
      grant_type: 'refresh_token',
    },
    muteHttpExceptions: true,
  });
  var json = JSON.parse(res.getContentText());
  if (!json.access_token) {
    throw new Error('YouTubeトークン取得に失敗: ' + res.getContentText().slice(0, 200));
  }
  return json.access_token;
}

function extractYoutubeId(url) {
  var m = String(url || '').match(/(?:shorts\/|v=|youtu\.be\/)([\w-]{6,})/);
  return m ? m[1] : '';
}

/** 投稿済みショートの再生数をシートへ同期する */
function syncYoutubeStats() {
  var published = readTable(SHEET.SHORTS).filter(function (r) {
    return String(r.status) === SHORT_STATUS.PUBLISHED && extractYoutubeId(r.youtube_url);
  });
  if (!published.length) return '投稿済みショートがまだありません';

  var token = ytAccessToken();
  var ids = [];
  published.forEach(function (r) {
    var id = extractYoutubeId(r.youtube_url);
    if (id && ids.indexOf(id) < 0) ids.push(id);
  });

  var stats = {};
  for (var i = 0; i < ids.length; i += 50) {
    var res = UrlFetchApp.fetch(
      'https://www.googleapis.com/youtube/v3/videos?part=statistics&id=' + ids.slice(i, i + 50).join(','),
      { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true }
    );
    var json = JSON.parse(res.getContentText());
    (json.items || []).forEach(function (it) { stats[it.id] = it.statistics || {}; });
  }

  var now = fmtDateTime(nowJst());
  var updated = 0;
  published.forEach(function (r) {
    var s = stats[extractYoutubeId(r.youtube_url)];
    if (!s) return;
    updateRowsWhere(SHEET.SHORTS, 'short_id', r.short_id, {
      views: String(s.viewCount || 0),
      likes: String(s.likeCount || 0),
      stats_at: now,
    });
    updated++;
  });
  logEvent('yt_stats', updated + '本の再生数を更新');
  return '再生数を更新しました（' + updated + '本）';
}

/** 台本・動画・再生の実績を自己分析の材料にまとめる */
function collectReviewMaterial() {
  var questions = readTable(SHEET.QUESTIONS);
  var qByKey = {};
  questions.forEach(function (q) { qByKey[String(q.script_id) + ':' + String(q.idx)] = q; });

  var shorts = readTable(SHEET.SHORTS).filter(function (r) {
    return String(r.kind || 'short') !== 'wide';
  });
  var answered = {}; // script_id:idx → true（ショートになった質問）
  var lines = { published: [], rejected: [], skipped: [] };

  shorts.forEach(function (r) {
    var q = qByKey[String(r.script_id) + ':' + String(r.question_idx)];
    if (q) answered[String(r.script_id) + ':' + String(r.question_idx)] = true;
    var theme = q ? String(q.theme) : '(台本なし)';
    if (String(r.status) === SHORT_STATUS.PUBLISHED) {
      lines.published.push('「' + r.title + '」 テーマ:' + theme +
        ' スコア:' + r.score + ' 再生:' + (r.views || '?') + ' 高評価:' + (r.likes || '?'));
    } else if (String(r.status) === SHORT_STATUS.REJECTED) {
      lines.rejected.push('「' + r.title + '」 テーマ:' + theme + ' スコア:' + r.score);
    }
  });

  // 処理済みの台本なのにショートにならなかった質問 = 飛ばされた質問
  readTable(SHEET.SCRIPTS).forEach(function (s) {
    if (String(s.status) !== SCRIPT_STATUS.DONE) return;
    questions.forEach(function (q) {
      if (String(q.script_id) !== String(s.script_id)) return;
      if (answered[String(q.script_id) + ':' + String(q.idx)]) return;
      lines.skipped.push('テーマ:' + q.theme + ' Q:' + String(q.question).slice(0, 60));
    });
  });

  var notes = [];
  readTable(SHEET.SCRIPTS).reverse().forEach(function (r) {
    var n = String(r.note || '').trim();
    if (n && notes.length < 5) notes.push(n.slice(0, 150));
  });

  return {
    published: lines.published.slice(-20),
    rejected: lines.rejected.slice(-10),
    skipped: lines.skipped.slice(-15),
    notes: notes,
  };
}

/**
 * 自己反省的な分析を実行し、質問・ネタ・構成の修正方針を更新する。
 * 分析所見と修正方針は Insights シートに履歴として残る。
 */
function runSelfReview() {
  var m = collectReviewMaterial();
  if (!m.published.length && !m.rejected.length && !m.skipped.length) {
    return '分析できる実績がまだありません（投稿・却下・飛ばしのデータが必要）';
  }

  var previous = String(getProp('SCRIPT_INSIGHTS', ''));
  var system = [
    'あなたはYouTubeチャンネル「' + String(getProp('CHANNEL_CONCEPT', '')) + '」の',
    '番組プロデューサー兼データアナリストです。',
    '撮影・投稿の実績から自己反省的に振り返り、次の撮影台本の',
    '「質問」「ネタ」「構成」をどう修正すべきかを具体的に言語化します。',
    '',
    '判断材料の見方:',
    '- 再生数が高いものは伸びる型。低いものとの差分（テーマ・タイトル・切り口）を見る',
    '- 却下されたものは本人が出したくなかった内容。同じ型の質問を減らす',
    '- 飛ばされた質問は喋れなかった質問。聞き方を変えるか捨てる',
    '',
    'JSONで出力:',
    '{"analysis": ["実績から言える所見。最大5個"],',
    ' "fixes": [{"target": "question|neta|structure", "advice": "次回からの具体的な修正。1文"}]}',
    'fixesは合計最大6個。前回と同じ内容の繰り返しは避け、新しい発見を優先する。',
  ].join('\n');

  var user = [
    '# 投稿済み（再生数つき）',
    m.published.join('\n') || '(なし)',
    '',
    '# 却下されたショート',
    m.rejected.join('\n') || '(なし)',
    '',
    '# 飛ばされた質問（撮影されたが話されなかった）',
    m.skipped.join('\n') || '(なし)',
    '',
    '# 撮影者本人のメモ',
    m.notes.join('\n') || '(なし)',
    '',
    '# 前回までの修正方針',
    previous || '(初回)',
  ].join('\n');

  var result = askClaudeJson(system, user, 2500);
  var analysis = (result.analysis || []).map(String).slice(0, 5);
  var fixes = (result.fixes || []).slice(0, 6);

  var now = fmtDateTime(nowJst());
  analysis.forEach(function (a) {
    appendRowObj(SHEET.INSIGHTS, { created_at: now, kind: 'insight', text: a.slice(0, 300) });
  });
  var label = { question: '質問', neta: 'ネタ', structure: '構成' };
  var fixLines = fixes.map(function (f) {
    var kind = label[String(f.target)] ? String(f.target) : 'structure';
    var line = '【' + (label[kind] || '構成') + '】' + String(f.advice).slice(0, 200);
    appendRowObj(SHEET.INSIGHTS, { created_at: now, kind: 'fix_' + kind, text: String(f.advice).slice(0, 300) });
    return line;
  });

  // 最新の方針として保存（台本生成と編集プランの両方が読む）
  var merged = (previous ? previous + '\n' : '') + fixLines.join('\n');
  PropertiesService.getScriptProperties()
    .setProperty('SCRIPT_INSIGHTS', merged.split('\n').slice(-12).join('\n'));

  logEvent('self_review', 'analysis=' + analysis.length + ' fixes=' + fixes.length);
  return '自己分析を実行しました:\n' + analysis.map(function (a) { return '- ' + a; }).join('\n') +
    '\n修正方針:\n' + fixLines.map(function (f) { return '- ' + f; }).join('\n');
}
