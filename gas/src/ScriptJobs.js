/**
 * ScriptJobs.js — 永続チェックポイント付きの撮影台本ワーカー。
 * 1 tick = 1生成段階（1 AI呼び出し）。1分トリガーで次段階へ進む。
 * Slack送信とSheetsの原子的な更新はできないため、不明な送信は自動再送しない。
 */
var SHOOT_JOB_LEASE_MS = 8 * 60000; // GASの1実行6分より長く取り、実行中の横取りを避ける。

function ensureShootScriptWorker() {
  if (!ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'runShootScriptJobs'; })) {
    ScriptApp.newTrigger('runShootScriptJobs').timeBased().everyMinutes(1).create();
  }
}

function withShootJobLock(action) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) throw new Error('台本ジョブの更新が競合しました。少し待って再実行してください');
  try { return action(); }
  finally { lock.releaseLock(); }
}

function readShootJobs() {
  return readTable(SHEET.SCRIPT_JOBS).map(function (row) {
    var payload = '';
    for (var i = 1; i <= 8; i++) {
      var chunk = String(row['payload_' + i] || '');
      if (chunk && chunk.indexOf('json:') !== 0) throw new Error('台本ジョブの保存形式が不正です');
      payload += chunk.slice(5);
    }
    var job = {};
    SHEET_HEADERS.ScriptJobs.slice(0, 10).forEach(function (key) { job[key] = row[key]; });
    job.data = JSON.parse(payload);
    job.attempt = Number(job.attempt) || 0;
    job.next_message = Number(job.next_message) || 0;
    return job;
  });
}

/** ロック保持中のみ。全列を1回のsetValuesで置換し、段階と結果のずれを避ける。 */
function writeShootJob(job) {
  job.updated_at = fmtDateTime(nowJst());
  // 完了後だけ大きな入力を保存対象から外す。メモリ上は保持し、保存失敗時にも再開できる。
  var storedData = job.status === 'done' ? { version: 1, kind: job.data.kind, title: job.data.title, count: job.data.count } : job.data;
  var payload = JSON.stringify(storedData);
  var chunks = [];
  while (payload.length) {
    var end = Math.min(30000, payload.length);
    if (end < payload.length && /[\uD800-\uDBFF]/.test(payload.charAt(end - 1))) end--;
    // 任意の境界で始まる文字列をシートの数式として解釈させない。
    chunks.push('json:' + payload.slice(0, end));
    payload = payload.slice(end);
  }
  if (chunks.length > 8) throw new Error('台本ジョブの保存容量を超えました');
  var row = SHEET_HEADERS.ScriptJobs.map(function (key, i) {
    return i >= 10 ? (chunks[i - 10] || '') : (job[key] === undefined ? '' : job[key]);
  });
  var sheet = getSheet(SHEET.SCRIPT_JOBS);
  var rows = readTable(SHEET.SCRIPT_JOBS);
  var existing = rows.filter(function (r) { return r.job_id === job.job_id; });
  if (existing.length > 1) throw new Error('台本ジョブのIDが重複しています');
  var rowNumber = existing.length ? existing[0]._row : sheet.getLastRow() + 1;
  if (rowNumber > sheet.getMaxRows()) {
    sheet.insertRowsAfter(sheet.getMaxRows(), rowNumber - sheet.getMaxRows());
    sheet.getRange(rowNumber, 1, 1, row.length).setNumberFormat('@');
  }
  sheet.getRange(rowNumber, 1, 1, row.length).setValues([row]);
  SpreadsheetApp.flush(); // 送信前のwrite-ahead markerも永続化してから外部APIへ進む。
}

function enqueueShootScript(kind, title, count) {
  return withShootJobLock(function () {
    ensureShootScriptWorker(); // 登録失敗時はジョブを受理しない。既存デプロイ更新後も遅延登録できる。
    var today = fmtDate(nowJst());
    var jobs = readShootJobs();
    var existing = jobs.filter(function (j) {
      return j.data.kind === kind && (kind === 'sv' ? j.job_id.indexOf(today + '_') === 0 :
        ['queued', 'running'].indexOf(j.status) >= 0);
    });
    if (existing.length) return existing[existing.length - 1];
    var job = { job_id: today + '_' + newId(kind), created_at: fmtDateTime(nowJst()),
      status: 'queued', stage: 'themes', started_ms: '', attempt: 0, thread_ts: '', next_message: 0, error: '',
      data: { version: 1, kind: kind, title: title, count: count } };
    writeShootJob(job);
    logEvent('script_job_queued', { job_id: job.job_id, stage: job.stage, count: count });
    return job;
  });
}

function shootJobLog(job, event, stage, started, detail) {
  logEvent(event, { job_id: job.job_id, stage: stage, attempt: job.attempt,
    elapsed_ms: Date.now() - started, status: job.status, next_stage: job.stage, detail: detail || '' });
}

/** 長いAPIの間はロックを解放。試行番号で遅れて戻った実行の上書きを防ぐ。 */
function checkpointShootJob(job) {
  withShootJobLock(function () {
    var current = readShootJobs().filter(function (j) { return j.job_id === job.job_id; })[0];
    if (!current || current.status !== 'running' || current.attempt !== job.attempt) {
      throw new Error('台本ジョブの実行権が失効しました');
    }
    writeShootJob(job);
  });
}

function runShootScriptJobs() {
  var interrupted = [];
  var job = withShootJobLock(function () {
    var jobs = readShootJobs();
    jobs.forEach(function (j) {
      if (j.status !== 'running' || Date.now() - Number(j.started_ms) < SHOOT_JOB_LEASE_MS) return;
      j.status = j.data.sending !== undefined ? 'needs_review' : 'failed';
      j.error = j.status === 'needs_review' ? '配信結果が不明です。重複防止のため確認待ち' : '前の実行が中断しました。保存済み段階から再開できます';
      writeShootJob(j);
      shootJobLog(j, 'script_stage_interrupted', j.stage, Number(j.started_ms), j.error);
      interrupted.push(j);
    });
    // 同じボットの台本ワーカー同士を直列化。API待ち中に次のtickが来ても呼び出さない。
    if (jobs.some(function (j) { return j.status === 'running'; })) return null;
    var next = jobs.filter(function (j) { return j.status === 'queued'; })[0];
    if (!next) return null;
    next.status = 'running';
    next.started_ms = Date.now();
    next.attempt++;
    writeShootJob(next);
    return next;
  });
  interrupted.forEach(notifyShootJobFailure);
  if (!job) return;
  var stage = job.stage;
  var started = Number(job.started_ms);
  shootJobLog(job, 'script_stage_start', stage, started);
  try {
    advanceShootJob(job);
    if (job.status === 'running') job.status = 'queued';
    job.error = '';
    checkpointShootJob(job);
    shootJobLog(job, 'script_stage_done', stage, started);
  } catch (e) {
    // 推論/HTTPの生のエラー本文をジョブやSlackに公開しない。
    job.status = job.data.sending !== undefined ? 'needs_review' : 'failed';
    job.error = job.status === 'needs_review' ? '配信結果が不明です。重複防止のため確認待ち' : 'この段階のAPI・出力検証・保存に失敗しました';
    var saved = false;
    try { checkpointShootJob(job); saved = true; }
    catch (saveError) {
      // 更新の成否も不明なら既存runningを残す。後続tickの期限検知に任せる。
      logEvent('script_job_checkpoint_error', { job_id: job.job_id, stage: stage });
    }
    shootJobLog(job, 'script_stage_failed', stage, started, job.error);
    if (saved) notifyShootJobFailure(job);
  }
}

function notifyShootJobFailure(job) {
  var action = job.status === 'needs_review' ? '配信結果が不明なため自動再送を停止しました。SlackとScriptJobsの照合が必要です。' :
    '保存済みの続きから「台本 再開 ' + job.job_id + '」で再開できます。';
  notifySlack(':warning: 台本ジョブ ' + job.job_id + ' の ' + job.stage + ' で停止しました。' + action);
}

function parseShootJobJson(text) {
  try { return parseJsonLoose(text); }
  catch (e) { throw new Error('台本ジョブのJSON形式が不正です'); }
}

function advanceShootJob(job) {
  var data = job.data;
  if (job.stage === 'themes' || job.stage === 'themes_repair') {
    var themes;
    try { themes = pickThemesForShoot(Math.min(2, data.count), true); }
    catch (e) {
      if (job.stage !== 'themes' || e.message !== 'AIテーマ選定のJSON形式が不正です') throw e;
      job.stage = 'themes_repair';
      return;
    }
    data.input = shootQuestionInput(themes, data.count, collectRecentNotes(5));
    job.stage = 'discussion';
  } else if (job.stage === 'discussion') {
    data.discussion = validateEditorialDiscussion(parseShootJobJson(askAI(editorialDiscussionSystem(),
      JSON.stringify(Object.assign({}, data.input, { pitch_count: data.count + 2 })), 2500 + (data.count + 2) * 550)),
    data.input.themes, data.count + 2);
    job.stage = 'review';
  } else if (job.stage === 'review') {
    data.review = validateEditorialReview(parseShootJobJson(askAI(editorialReviewSystem(), JSON.stringify({
      recruiting: data.input.recruiting, count: data.count, themes: data.input.themes,
      recent_questions: data.input.recent_questions, discussion: data.discussion }), 1500 + data.count * 450)),
    data.discussion, data.input.themes, data.count);
    job.stage = 'writing';
  } else if (job.stage === 'writing' || job.stage === 'writing_repair') {
    var editorial = { discussion: data.discussion, review: data.review };
    var text = askAI(shootQuestionSystem(data.input.channel),
      JSON.stringify(Object.assign({}, data.input, { editorial: editorial })) + (data.correction || ''),
      Math.max(4000, data.count * 1400));
    try {
      data.questions = validateShootQuestions(parseShootJobJson(text), data.input.themes, data.count,
        data.input.recent_questions, data.review);
    } catch (e) {
      if (job.stage === 'writing_repair') throw e;
      // 修復も次の実行で1回だけ。会議と批評は保存結果をそのまま使う。
      // JSONエラーは上で固定文に変換済み。validatorも入力を含まない項目名/条件だけを返す。
      data.correction = '\n前回は不採用です。次を修正して全問を出し直してください: ' + e.message;
      job.stage = 'writing_repair';
      return;
    }
    logShootEditorial(editorial);
    data.messages = shootQuestionMessages(data.questions);
    data.intro = shootScriptIntro(data.title, data.input.themes, data.questions.length);
    job.stage = 'parent';
  } else if (job.stage === 'parent') {
    sendShootJobMessage(job, -1, data.intro, '');
    // 親投稿後の紐付けを次の1分tickまで待たせない。途中失敗ならpersistから再開する。
    persistShootJobScript(job);
    job.stage = 'delivery';
  } else if (job.stage === 'persist') {
    persistShootJobScript(job);
    job.stage = 'delivery';
  } else if (job.stage === 'delivery') {
    var started = Date.now();
    while (job.next_message < data.messages.length && Date.now() - started < 60000) {
      sendShootJobMessage(job, job.next_message, data.messages[job.next_message], job.thread_ts);
    }
    if (job.next_message === data.messages.length) {
      job.status = 'done';
      logEvent('script_start', job.job_id + ' themes=' + JSON.stringify(data.input.themes));
      // 本文はQuestions、講評はLogへ保存済み。完了チェックポイントだけ入力を縮小する。
    }
  } else {
    throw new Error('未知の台本生成段階です');
  }
}

function sendShootJobMessage(job, index, text, threadTs) {
  job.data.sending = index;
  checkpointShootJob(job); // ここを保存できなければ送信しない。
  Utilities.sleep(1000);
  var result = sendSlack(text, threadTs || undefined);
  if (!result || !/^\d+\.\d+$/.test(String(result.ts || ''))) throw new Error('Slackの送信結果が不明です');
  if (index === -1) { job.thread_ts = String(result.ts); job.stage = 'persist'; }
  else job.next_message = index + 1;
  delete job.data.sending;
  try { checkpointShootJob(job); }
  catch (e) {
    // ACK後の保存失敗も不明扱い。再開時に同じメッセージを送らない。
    job.data.sending = index;
    throw e;
  }
}

function persistShootJobScript(job) {
  // 途中のappend成功後に実行が切れても、既存キーを読み直して重複を作らない。
  withShootJobLock(function () {
    var questions = readTable(SHEET.QUESTIONS).filter(function (q) { return q.script_id === job.job_id; });
    job.data.questions.forEach(function (q, i) {
      if (questions.some(function (r) { return Number(r.idx) === i + 1; })) return;
      appendRowObj(SHEET.QUESTIONS, Object.assign({}, q, { script_id: job.job_id, idx: i + 1 }));
    });
    if (!readTable(SHEET.SCRIPTS).some(function (s) { return s.script_id === job.job_id; })) {
      appendRowObj(SHEET.SCRIPTS, { script_id: job.job_id, created_at: job.created_at,
        thread_ts: 'ts_' + job.thread_ts, themes: job.data.input.themes.map(function (t) { return t.theme; }).join(' / '),
        status: SCRIPT_STATUS.OPEN, shot_at: '', processed_at: '', note: '' });
    }
    SpreadsheetApp.flush();
  });
}

function resumeShootScriptJob(jobId) {
  return withShootJobLock(function () {
    ensureShootScriptWorker();
    var job = readShootJobs().filter(function (j) { return j.job_id === jobId; })[0];
    if (!job) throw new Error('指定の台本ジョブがありません');
    if (job.status === 'needs_review') throw new Error('Slack配信の確認が必要です。ScriptJobsの送信位置を照合してください');
    if (job.status !== 'failed') return job;
    job.status = 'queued';
    job.error = '';
    writeShootJob(job);
    logEvent('script_job_resumed', { job_id: job.job_id, stage: job.stage });
    return job;
  });
}

/** 管理者がSlackと照合した後だけ呼ぶ。confirmedTs='not_sent'なら再送を許可する。 */
function resolveShootScriptDelivery(jobId, confirmedTs, token) {
  if (!token || token !== getProp('ADMIN_TOKEN')) throw new Error('unauthorized');
  if (confirmedTs !== 'not_sent' && !/^\d+\.\d+$/.test(String(confirmedTs))) throw new Error('確認済みSlack tsまたはnot_sentが必要です');
  return withShootJobLock(function () {
    ensureShootScriptWorker();
    var job = readShootJobs().filter(function (j) { return j.job_id === jobId; })[0];
    if (!job || job.status !== 'needs_review' || job.data.sending === undefined) throw new Error('配信確認待ちのジョブではありません');
    var index = Number(job.data.sending);
    if (confirmedTs !== 'not_sent') {
      if (index === -1) { job.thread_ts = confirmedTs; job.stage = 'persist'; }
      else job.next_message = index + 1;
    } else if (index === -1) {
      job.thread_ts = '';
      job.stage = 'parent';
    } else {
      job.next_message = index;
    }
    delete job.data.sending;
    job.status = 'queued';
    job.error = '';
    writeShootJob(job);
    logEvent('script_delivery_resolved', { job_id: jobId, index: index, result: confirmedTs === 'not_sent' ? 'retry' : 'confirmed' });
    return job;
  });
}

function handleShootJobCommand(text, threadTs) {
  var match = /^台本\s+再開\s+([A-Za-z0-9_-]+)$/.exec(text);
  if (match) {
    var job = resumeShootScriptJob(match[1]);
    sendSlack('台本ジョブ ' + job.job_id + ': ' + job.stage + ' / ' + job.status, threadTs);
    return true;
  }
  if (text !== '台本 状態') return false;
  var jobs = readShootJobs().slice(-5);
  sendSlack(jobs.length ? jobs.map(function (j) {
    return j.job_id + ': ' + j.stage + ' / ' + j.status + (j.error ? '（' + j.error + '）' : '');
  }).join('\n') : '台本ジョブはまだありません。', threadTs);
  return true;
}
