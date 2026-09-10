/**
 * ShootScript.js — 撮影台本（Slackに届くインタビュー質問+ネタ指示）
 *
 * 流れ:
 *   1. 朝のトリガーで startDailyShootScript() が実行される
 *   2. テーマ選定 → 3者の企画会議 → 架空の広報責任者の批評 → 発話案を生成
 *      ScriptQuality.jsで直近質問との重複・構成を検証し、話す順序をhintへ保存
 *   3. Slackに台本が届く → スマホで質問に答える動画を撮る（通しでOK）
 *   4. 撮った動画をそのままスレッドに投稿 → Videos.js が編集キューに登録
 *   5. ローカル常駐の `ytshorts pull --watch` が自動でDL・編集 → 結果がスレッドに返る
 *
 * スレッド内で使える言葉:
 *   リテイク … 台本を作り直す
 *   撮った / 終了 … 撮影済みにする
 *   それ以外 … メモとして保存（次回の台本生成のヒントに使われる）
 */

function startDailyShootScript() {
  var today = fmtDate(nowJst());
  var days = String(getProp('SHOOT_DAYS', '')).trim();
  if (days) {
    var names = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
    var todayName = names[nowJst().getDay()];
    if (days.toUpperCase().split(',').map(function (s) { return s.trim(); }).indexOf(todayName) < 0) {
      return; // 撮影日ではない
    }
  }
  var existing = readTable(SHEET.SCRIPTS).filter(function (r) {
    return String(r.script_id).indexOf(today) === 0 && String(r.script_id).indexOf('_svx_') < 0;
  });
  if (existing.length) {
    logEvent('script_skip', '本日分は作成済み: ' + today);
    return;
  }
  expireOldScripts();
  startShootScript('sv', ':movie_camera: 今日の撮影台本');
}

/** 追加台本。Slackのチャンネルに「台本」と書き込むと開始される */
function startExtraShootScript() {
  try {
    var job = startShootScript('svx', ':movie_camera: 追加の撮影台本');
    notifySlack('台本を受け付けました（' + job.job_id + '）。段階ごとに保存して生成します。進行状況は「台本 状態」で確認できます。');
    return job;
  } catch (e) {
    // モデル出力やAPIエラー本文は通知しない。投稿済みの部分があっても成功とは伝えない。
    notifySlack(':warning: 台本の作成・送信を完了できませんでした。品質基準を満たす材料不足、応答形式、接続または時間制限を確認してください。具体的な開発判断・比較対象・確かめたいことを台本スレッドのメモに追加すると企画材料になります。記録はLogを確認してください。');
    throw e;
  }
}

function startShootScript(kind, title) {
  var count = Number(getProp('SHOOT_QUESTIONS', '5'));
  if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error('SHOOT_QUESTIONSは1〜10の整数にしてください');
  return enqueueShootScript(kind, title, count);
}

function shootScriptIntro(title, themes, count) {
  return [
    title + '（' + count + '問）',
    'テーマ: ' + themes.map(function (t) { return t.theme + '（' + labelForCategory(t.category) + '）'; }).join(' / '),
    '',
    '撮り方: 横向きで、1問ずつ撮影してください。1本の動画で通しでOK。',
    '【読む】【戻って読む】の引用部分だけ読めば完成です。見出しと※の案内は読みません。',
    '自分の考えは任意。支持・反論・保留・別案を追加しても、省略してもOK。実話や意見の穴埋めは不要です。',
    '制作メモは全カードの後にまとめています。深く考えたいときだけ参照してください。',
    '言い直しや間は後で編集できます。各回答の前後には短い間を空けてください。',
    '撮り終わったら *このスレッドに動画をそのまま投稿* してください。あとは全部自動です。',
  ].join('\n');
}

function shootQuestionInput(themes, count, recentNotes) {
  return { themes: themes, count: count, channel: getProp('CHANNEL_CONCEPT', '中井佑の、とにかく早く移動したい！'),
    recent_notes: recentNotes, recent_questions: collectRecentQuestions(30),
    theme_insights: getProp('THEME_INSIGHTS', ''), script_insights: getProp('SCRIPT_INSIGHTS', ''), recruiting: recruitingContext() };
}

function logShootEditorial(editorial) {
  logEvent('script_editorial', JSON.stringify({ version: 'speaking-card-v2', perspectives: editorial.discussion.perspectives,
    resolution: editorial.discussion.resolution, critique: editorial.review.critique,
    selected: editorial.review.selected.map(function (s) { return { id: s.pitch.id, title: s.pitch.title,
      novelty: s.novelty, specificity: s.specificity, recruiting: s.recruiting,
      depth: s.depth, speakability: s.speakability, clarity: s.clarity, reason: s.reason, revision: s.revision }; }),
    rejected: editorial.review.rejected }));
}

/** 旧同期呼び出しの互換ヘルパー。通常のSlack/日次生成はScriptJobsで段階実行する。 */
function generateShootQuestions(themes, count, recentNotes, deadline) {
  if (!Number.isInteger(count) || count < 1 || count > 10 || !themes.length || themes.length > count) {
    throw new Error('SHOOT_QUESTIONSはテーマ数以上、1〜10の整数にしてください');
  }
  var concept = getProp('CHANNEL_CONCEPT', '中井佑の、とにかく早く移動したい！');
  var recent = collectRecentQuestions(30);
  deadline = deadline || Date.now() + 240000;
  var input = { themes: themes, count: count, channel: concept, recent_notes: recentNotes,
    recent_questions: recent, theme_insights: getProp('THEME_INSIGHTS', ''),
    script_insights: getProp('SCRIPT_INSIGHTS', ''), recruiting: recruitingContext() };
  var editorial = runEditorialRoom(input, deadline);
  var user = JSON.stringify(Object.assign({}, input, { editorial: editorial }));
  var correction = '';
  // JSON形式と構成の修復は1回だけ。APIエラーは再生成で握り潰さない。
  for (var attempt = 0; attempt < 2; attempt++) {
    checkEditorialTime(deadline, 30000);
    var text = askAI(shootQuestionSystem(concept), user + correction, Math.max(4000, count * 1400));
    checkEditorialTime(deadline, 0);
    try {
      var questions = validateShootQuestions(parseJsonLoose(text), themes, count, recent, editorial.review);
      logShootEditorial(editorial);
      logEvent('script_quality', 'questions=' + questions.length + ' repair=' + attempt + ' recent=' + recent.length);
      return questions;
    } catch (e) {
      if (attempt === 1) throw new Error('台本の品質検証に失敗: ' + e.message);
      correction = '\n前回の出力は不採用です。次を修正して全問を出し直すこと: ' + e.message;
    }
  }
}

/** 直近の台本スレッドに書かれたメモを集める（次回生成のヒント） */
function collectRecentNotes(limit) {
  var notes = [];
  readTable(SHEET.SCRIPTS).reverse().forEach(function (r) {
    if (notes.length >= limit) return;
    var n = String(r.note || '').trim();
    if (n) notes.push(n.slice(0, 200));
  });
  return notes;
}

/**
 * Slackスレッドへの返信を処理する（doPost から呼ばれる）。
 */
function handleScriptReply(threadTs, text) {
  var trimmed = String(text || '').trim();
  if (handleShootJobCommand(trimmed, threadTs)) return true;

  // コマンドは台本の有無に関係なく効かせる（フリートーク動画のスレッドなど）
  if (handleApprovalCommand(trimmed)) return true;
  if (handleReeditCommand(threadTs, trimmed)) return true;

  var rows = readTable(SHEET.SCRIPTS).filter(function (r) {
    return slackTsEqual(r.thread_ts, threadTs);
  });
  if (!rows.length) {
    logEvent('script_no_match', 'thread_ts=' + threadTs + ' に一致する台本なし');
    return false;
  }
  var script = rows[rows.length - 1];
  var scriptId = String(script.script_id);

  if (/^(リテイク|作り直し|retake)$/i.test(trimmed)) {
    updateRowsWhere(SHEET.SCRIPTS, 'script_id', scriptId, { status: SCRIPT_STATUS.EXPIRED });
    sendSlack(':arrows_counterclockwise: 台本を作り直します…', threadTs);
    startExtraShootScript();
    return true;
  }

  if (/^(撮った|撮影した|終了|以上|done)/.test(trimmed)) {
    updateRowsWhere(SHEET.SCRIPTS, 'script_id', scriptId, {
      status: SCRIPT_STATUS.SHOT,
      shot_at: fmtDateTime(nowJst()),
    });
    sendSlack(
      ':clapper: 撮影おつかれさまです！動画をこのスレッドにそのまま投稿してください。\n' +
      '受け取り次第、編集キューに入れて自動処理します（文字起こし→間カット→字幕・挿絵→ショート量産）。',
      threadTs
    );
    return true;
  }

  // それ以外はメモとして保存（次回の台本生成のヒントに使う）
  var merged = (String(script.note || '') + ' ' + trimmed).trim().slice(0, 500);
  updateRowsWhere(SHEET.SCRIPTS, 'script_id', scriptId, { note: merged });
  sendSlack(':memo: メモしました。次の台本づくりのヒントに使います。', threadTs);
  return true;
}

/**
 * スレッド外（チャンネル直下）に書かれたメッセージの処理。
 */
function handleChannelMessage(text) {
  var trimmed = String(text || '').trim();
  if (handleShootJobCommand(trimmed)) return true;
  if (handleApprovalCommand(trimmed)) return true;
  if (/^(台本|撮影|インタビュー|script)$/i.test(trimmed)) {
    startExtraShootScript();
    return true;
  }
  // 「まとめて」でクラウド上のまとめ動画生成を起動する
  if (/^(まとめ|まとめて|compile)$/i.test(trimmed)) {
    var ok = triggerGithub('compile-requested');
    sendSlack(ok
      ? ':clapper: まとめ動画の作成を開始しました。できあがったらこのチャンネルに届きます。'
      : ':warning: GITHUB_REPO / GITHUB_TOKEN が未設定です。GitHubのActionsタブから compile を手動実行してください。');
    return true;
  }
  var open = readTable(SHEET.SCRIPTS).filter(function (r) {
    return String(r.status) === SCRIPT_STATUS.OPEN && r.thread_ts;
  });
  if (!open.length) return false;
  var threadTs = rawSlackTs(open[open.length - 1].thread_ts);
  return handleScriptReply(threadTs, text);
}

/** 前日以前の未撮影台本を期限切れにする */
function expireOldScripts() {
  var today = fmtDate(nowJst());
  readTable(SHEET.SCRIPTS).forEach(function (r) {
    if (String(r.status) === SCRIPT_STATUS.OPEN && String(r.script_id).indexOf(today) !== 0) {
      updateRowsWhere(SHEET.SCRIPTS, 'script_id', r.script_id, { status: SCRIPT_STATUS.EXPIRED });
    }
  });
}
