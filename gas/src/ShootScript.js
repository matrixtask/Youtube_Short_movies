/**
 * ShootScript.js — 撮影台本（Slackに届くインタビュー質問+ネタ指示）
 *
 * 流れ:
 *   1. 朝のトリガーで startDailyShootScript() が実行される
 *   2. テーマ選定 → Claudeが「カメラに向かって答える用」の質問+ネタ指示を生成
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
  startShootScript('svx', ':movie_camera: 追加の撮影台本');
}

function startShootScript(kind, title) {
  var themes = pickThemesForShoot();
  var count = Number(getProp('SHOOT_QUESTIONS', '5'));
  var recentNotes = collectRecentNotes(5);
  var questions = generateShootQuestions(themes, count, recentNotes);

  var scriptId = fmtDate(nowJst()) + '_' + newId(kind);
  var intro = [
    title + '（' + questions.length + '問）',
    'テーマ: ' + themes.map(function (t) { return t.theme + '（' + labelForCategory(t.category) + '）'; }).join(' / '),
    '',
    '撮り方: スマホを縦にして、1問ずつカメラに向かって答えるだけ。1本の動画で通しでOK。',
    '言い直し・変な間・噛みは気にしない（編集で全部消えます）。',
    '撮り終わったら *このスレッドに動画をそのまま投稿* してください。あとは全部自動です。',
  ].join('\n');
  var parent = sendSlack(intro);
  var threadTs = parent.ts;

  appendRowObj(SHEET.SCRIPTS, {
    script_id: scriptId,
    created_at: fmtDateTime(nowJst()),
    thread_ts: 'ts_' + threadTs, // 'ts_'接頭辞でシートの数値化（精度落ち）を防ぐ
    themes: themes.map(function (t) { return t.theme; }).join(' / '),
    status: SCRIPT_STATUS.OPEN,
    shot_at: '',
    processed_at: '',
    note: '',
  });

  var lines = [];
  questions.forEach(function (q, idx) {
    appendRowObj(SHEET.QUESTIONS, {
      script_id: scriptId,
      idx: idx + 1,
      theme: q.theme,
      category: q.category,
      question: q.question,
      neta: q.neta || '',
      hint: q.hint || '',
    });
    var block = ['*Q' + (idx + 1) + '. ' + q.question + '*'];
    if (q.hint) block.push('　:bulb: ' + q.hint);
    if (q.neta) block.push('　:performing_arts: ネタ指示: ' + q.neta);
    lines.push(block.join('\n'));
  });

  sendSlack(lines.join('\n\n'), threadTs);
  logEvent('script_start', scriptId + ' themes=' + JSON.stringify(themes));
}

function generateShootQuestions(themes, count, recentNotes) {
  var concept = getProp('CHANNEL_CONCEPT', '中井佑の、とにかく早く移動したい！');
  var system = [
    'あなたはYouTubeチャンネル「' + concept + '」の放送作家です。',
    'チャンネルの文脈に合う、カメラの前で答えてもらう質問を作ります。',
    '視聴者が最後まで見てしまう「1問=1ショート」の質問を作ります。',
    '質問のルール:',
    '- 1問1トピック、話し言葉で短く（40字以内目安）',
    '- 「はい/いいえ」で終わらない、具体的なエピソードや本音が出る聞き方',
    '- 冒頭3秒のフックになる質問（意外性・数字・失敗談・ぶっちゃけ系）',
    '- 各質問に hint（答え方のコツ、30字以内）を付ける',
    '- 各質問に neta（答えの途中に挟む小ネタの指示。例: 「ここで一回真顔で沈黙」「あるあるを1個入れる」）を付ける。全問でなくてよい（半分程度）',
    '- ネタカテゴリの質問はゆるく、笑える話や人間味が出る話を引き出す',
  ].join('\n');
  // 撮影実績から学習した「喋りやすさの傾向」を聞き方に反映する
  // （tuneThemeWeights → analyzeThemeDifferences が毎週更新）
  var insights = getProp('THEME_INSIGHTS');
  if (insights) {
    system += '\n\n話し手の傾向（撮影実績からの学習。最重要）:\n' + insights +
      '\n喋りにくい傾向に当たる質問は、喋りやすい傾向側の切り口に言い換えて出題する。';
  }
  var user = [
    '今日のテーマ:',
    themes.map(function (t) { return '- ' + t.theme + '（カテゴリ: ' + t.category + (t.notes ? ' / メモ: ' + t.notes : '') + '）'; }).join('\n'),
    '',
    recentNotes.length ? '本人からの最近のメモ（ヒントに使う）:\n' + recentNotes.map(function (n) { return '- ' + n; }).join('\n') : '',
    '',
    '合計' + count + '問。各テーマから最低1問。',
    'JSON配列で出力: [{"theme": "...", "category": "evergreen|news|neta", "question": "...", "hint": "...", "neta": "..."}]',
  ].join('\n');
  var questions = askClaudeJson(system, user, 2500);
  if (!Array.isArray(questions) || !questions.length) throw new Error('質問生成に失敗しました');
  return questions.slice(0, count);
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
