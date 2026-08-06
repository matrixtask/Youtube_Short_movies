/**
 * Videos.js — Slackに投げられた撮影動画の受付と処理キュー
 *
 * 流れ:
 *   1. 撮影台本のスレッドに動画をアップロード（チャンネル直下でもOK）
 *   2. doPost → handleVideoUpload() が Videos シートに pending で登録
 *      台本スレッドへの返信なら台本と自動で紐づく
 *   3. ローカルの `ytshorts pull --watch` が pending を取得して
 *      ダウンロード → 編集 → video_done を報告
 *   4. markVideoDone() が結果を元のスレッドに返す
 */

var VIDEO_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing', // どこかのワーカーが処理中（二重処理を防ぐ）
  DONE: 'done',
  FAILED: 'failed',
};

var VIDEO_EXTS = ['.mp4', '.mov', '.m4v', '.mkv', '.webm'];

function isVideoFile(f) {
  if (!f) return false;
  if (String(f.mimetype || '').indexOf('video/') === 0) return true;
  var name = String(f.name || '').toLowerCase();
  return VIDEO_EXTS.some(function (ext) { return name.slice(-ext.length) === ext; });
}

/** Slackのメッセージイベントに含まれる動画ファイルを受け付ける */
function handleVideoUpload(event) {
  var files = (event.files || []).filter(isVideoFile);
  if (!files.length) return false;
  var threadTs = event.thread_ts || event.ts;
  // 「フリートーク」等を添えて投稿された動画は台本と紐づけない
  // （編集プランに無関係な質問リストが渡るのを防ぐ。話のまとまりだけで切り出される）
  var isFreeTalk = /フリートーク|雑談|freetalk|free talk/i.test(String(event.text || ''));
  var script = isFreeTalk ? null : findScriptForVideo(event.thread_ts);
  var existing = readTable(SHEET.VIDEOS);
  var added = 0;
  var codes = [];

  files.forEach(function (f) {
    // Slackはイベントを再送することがあるため file_id で重複排除する
    if (existing.some(function (r) { return String(r.file_id) === String(f.id); })) return;
    var vid = newId('vid');
    codes.push(vid.slice(-4));
    appendRowObj(SHEET.VIDEOS, {
      video_id: vid,
      created_at: fmtDateTime(nowJst()),
      script_id: script ? String(script.script_id) : '',
      thread_ts: 'ts_' + threadTs,
      file_id: String(f.id),
      file_name: String(f.name || 'video.mp4'),
      url_private: String(f.url_private_download || f.url_private || ''),
      size: String(f.size || ''),
      status: VIDEO_STATUS.PENDING,
      processed_at: '',
      // 動画に添えたメッセージはそのまま編集指示として使う
      // （例:「フリートーク。テロップ多め、ツッコミ辛口で」）
      instructions: String(event.text || '').slice(0, 500),
    });
    added++;
  });
  if (!added) return true; // 再送イベント

  if (script && String(script.status) === SCRIPT_STATUS.OPEN) {
    updateRowsWhere(SHEET.SCRIPTS, 'script_id', script.script_id, {
      status: SCRIPT_STATUS.SHOT,
      shot_at: fmtDateTime(nowJst()),
    });
  }
  var dispatched = triggerGithub('video-uploaded');
  sendSlack(
    ':inbox_tray: 動画を' + added + '本受け取りました（コード: ' + codes.join(', ') + '）。' +
    (script ? '\n台本: ' + script.script_id : '') +
    (dispatched ? '\nクラウドで編集を開始します。終わったらこのスレッドにショートを返します。'
                : '\n編集が終わったらこのスレッドに結果を返します。') +
    '\n指示を変えて編集し直すときは「再編集 <指示>」と返信（複数本あるときは「再編集 コード <指示>」）。',
    threadTs
  );
  logEvent('video_received', added + '本 script=' + (script ? script.script_id : 'なし'));
  return true;
}

/**
 * 動画スレッドでの「再編集 <指示>」を処理する（レベル2の進化版）。
 * 対象はそのスレッドの最新動画。複数本あるときは受付時のコード
 * （video_id末尾4桁）を先頭に付けて特定できる。
 * 例:「再編集 テロップ多めで」「再編集 3841 挿絵なしで」
 */
function handleReeditCommand(threadTs, text) {
  var m = String(text || '').trim().match(/^(再編集|編集し直し|reedit)\s*[:：]?\s*([\s\S]+)$/i);
  if (!m) return false;
  var body = m[2].trim();
  var videos = readTable(SHEET.VIDEOS).filter(function (r) {
    return slackTsEqual(r.thread_ts, threadTs);
  });
  if (!videos.length) {
    // 無反応だと「通ってるのか分からない」ので、対象がない場合も必ず返事する
    sendSlack(':warning: このスレッドで受け取った動画が見つかりません。動画を投稿したスレッドで「再編集 <指示>」と返信してください。', threadTs);
    return true;
  }

  var target = videos[videos.length - 1];
  var token = body.split(/\s+/)[0];
  var byCode = videos.filter(function (r) { return String(r.video_id).slice(-4) === token; });
  if (byCode.length) {
    target = byCode[byCode.length - 1];
    body = body.slice(token.length).trim();
  }
  if (!body) {
    sendSlack(':warning: 指示の内容が空です。例:「再編集 テロップ多めで」', threadTs);
    return true;
  }

  updateRowsWhere(SHEET.VIDEOS, 'video_id', target.video_id, {
    instructions: body.slice(0, 500),
    status: VIDEO_STATUS.PENDING,
    claimed_at: '',
    claimed_by: '',
  });
  var dispatched = triggerGithub('video-uploaded');
  sendSlack(
    ':repeat: ' + String(target.file_name) + ' を新しい指示で編集し直します:\n> ' + body +
    '\n（前に生成したショートはそのまま残ります。不要なら「却下 <コード>」で）' +
    (dispatched ? '' : '\n次の処理タイミング（毎時 or make pull）で実行されます。'),
    threadTs
  );
  logEvent('video_reedit', target.video_id + ': ' + body.slice(0, 100));
  return true;
}

/**
 * 動画に対応する台本を探す。スレッドへの返信ならそのスレッドの台本、
 * チャンネル直下なら最新の撮影待ち・撮影済み台本。
 */
function findScriptForVideo(threadTs) {
  var scripts = readTable(SHEET.SCRIPTS);
  if (threadTs) {
    var hit = scripts.filter(function (r) { return slackTsEqual(r.thread_ts, threadTs); });
    if (hit.length) return hit[hit.length - 1];
  }
  var candidates = scripts.filter(function (r) {
    var st = String(r.status);
    return st === SCRIPT_STATUS.OPEN || st === SCRIPT_STATUS.SHOT;
  });
  return candidates.length ? candidates[candidates.length - 1] : null;
}

/**
 * 未処理の動画が残っていることをSlackで知らせる（毎時のトリガーから呼ばれる）。
 * GPU機での手動処理（make pull）を忘れないためのリマインド。
 * 同じ内容を何度も送らないよう、前回通知した内容を記録して変化時のみ送る。
 */
function remindPendingVideos() {
  releaseStaleClaims(); // 落ちたワーカーの後始末もここで
  if (String(getProp('PENDING_REMINDER', 'true')).toLowerCase() !== 'true') return;
  var pending = readTable(SHEET.VIDEOS).filter(function (r) {
    return String(r.status) === VIDEO_STATUS.PENDING;
  });

  var cache = CacheService.getScriptCache();
  var key = 'pending_reminded';
  if (!pending.length) {
    cache.remove(key); // 片付いたら次に溜まったとき即通知できるようにする
    return;
  }

  // 直後の通知は不要（クラウドや常駐pullが数分で片付ける場合がある）
  var oldest = pending[0];
  var waitedMin = (nowJst().getTime() - new Date(String(oldest.created_at)).getTime()) / 60000;
  if (!(waitedMin >= Number(getProp('PENDING_REMIND_AFTER_MIN', '20')))) return;

  var signature = pending.map(function (r) { return r.video_id; }).sort().join(',');
  if (cache.get(key) === signature) return; // 同じ顔ぶれには再通知しない
  cache.put(key, signature, 21600); // 6時間

  notifySlack([
    ':desktop_computer: 未処理の動画が' + pending.length + '本あります（最古 ' + Math.round(waitedMin) + '分待ち）',
    pending.map(function (r) { return '• ' + r.file_name; }).join('\n'),
    '',
    'GPU機で処理する場合: `make pull`',
  ].join('\n'));
  logEvent('pending_reminder', pending.length + '本');
}

/**
 * 処理待ちの動画を「確保」して返す（二重処理の防止）。
 *
 * ローカルのGPU機とGitHub Actionsが同時に走っても、同じ動画を両方が
 * 処理しないよう、取得と同時に processing へ落とす。スクリプトロックで
 * 直列化しているため、同時アクセスでも片方だけが確保できる。
 */
function claimPendingVideos(worker) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    logEvent('claim_busy', '他のワーカーが取得中');
    return [];
  }
  try {
    releaseStaleClaims();
    var claimed = listPendingVideos();
    var now = fmtDateTime(nowJst());
    claimed.forEach(function (v) {
      updateRowsWhere(SHEET.VIDEOS, 'video_id', v.video_id, {
        status: VIDEO_STATUS.PROCESSING,
        claimed_at: now,
        claimed_by: String(worker || 'unknown').slice(0, 60),
      });
    });
    if (claimed.length) {
      logEvent('claim', claimed.length + '本 by ' + (worker || 'unknown'));
      notifyClaimStart(claimed, worker);
    }
    return claimed;
  } finally {
    lock.releaseLock();
  }
}

/**
 * 確保した動画のスレッドに「編集を開始した」ことを知らせる。
 * 再編集の指示が拾われたか・どのマシンが処理中かを見えるようにする。
 */
function notifyClaimStart(claimed, worker) {
  var byThread = {};
  claimed.forEach(function (v) {
    if (!v.thread_ts) return;
    (byThread[v.thread_ts] = byThread[v.thread_ts] || []).push(v);
  });
  Object.keys(byThread).forEach(function (ts) {
    var lines = byThread[ts].map(function (v) {
      return '• ' + v.file_name + (v.reprocess ? '（再編集: ' + (v.instructions || '指示なし') + '）' : '');
    });
    notifySlack(
      ':gear: 編集を開始しました（' + String(worker || 'unknown') + '）\n' + lines.join('\n') +
      '\n終わったらこのスレッドに結果を返します。',
      ts
    );
  });
}

/**
 * 処理中のまま放置された動画をpendingへ戻す。
 * ワーカーが落ちた・ネットワークが切れた場合の救済。
 */
function releaseStaleClaims() {
  var limitMin = Number(getProp('CLAIM_TIMEOUT_MIN', '90'));
  var now = nowJst().getTime();
  var released = 0;
  readTable(SHEET.VIDEOS).forEach(function (r) {
    if (String(r.status) !== VIDEO_STATUS.PROCESSING) return;
    var claimedAt = new Date(String(r.claimed_at || r.created_at)).getTime();
    if (!isFinite(claimedAt) || (now - claimedAt) / 60000 < limitMin) return;
    updateRowsWhere(SHEET.VIDEOS, 'video_id', r.video_id, {
      status: VIDEO_STATUS.PENDING,
      claimed_at: '',
      claimed_by: '',
    });
    released++;
  });
  if (released) logEvent('claim_released', released + '本をpendingへ戻しました');
  return released;
}

/** 処理待ちの動画を、紐づく台本の質問ごと返す（確保はしない） */
function listPendingVideos() {
  var questions = readTable(SHEET.QUESTIONS);
  return readTable(SHEET.VIDEOS)
    .filter(function (r) { return String(r.status) === VIDEO_STATUS.PENDING; })
    .map(function (r) {
      var scriptId = String(r.script_id || '');
      return {
        video_id: String(r.video_id),
        script_id: scriptId,
        thread_ts: rawSlackTs(r.thread_ts),
        file_id: String(r.file_id),
        file_name: String(r.file_name),
        url_private: String(r.url_private),
        size: Number(r.size) || 0,
        instructions: String(r.instructions || ''),
        // 一度処理済み → 再編集。ローカルの古いプランを捨てて作り直す合図
        reprocess: !!String(r.processed_at || ''),
        questions: questions
          .filter(function (q) { return scriptId && String(q.script_id) === scriptId; })
          .sort(function (a, b) { return Number(a.idx) - Number(b.idx); })
          .map(function (q) {
            return {
              idx: Number(q.idx),
              theme: String(q.theme),
              category: String(q.category),
              question: String(q.question),
              neta: String(q.neta || ''),
              hint: String(q.hint || ''),
            };
          }),
      };
    });
}

/** パイプラインからの処理結果を記録し、元のスレッドに結果を返す */
function markVideoDone(videoId, ok, summary) {
  var rows = readTable(SHEET.VIDEOS).filter(function (r) {
    return String(r.video_id) === String(videoId);
  });
  if (!rows.length) return false;
  var video = rows[rows.length - 1];
  updateRowsWhere(SHEET.VIDEOS, 'video_id', videoId, {
    status: ok ? VIDEO_STATUS.DONE : VIDEO_STATUS.FAILED,
    processed_at: fmtDateTime(nowJst()),
  });
  if (ok && String(video.script_id)) {
    updateRowsWhere(SHEET.SCRIPTS, 'script_id', video.script_id, {
      status: SCRIPT_STATUS.DONE,
      processed_at: fmtDateTime(nowJst()),
    });
  }
  var prefix = ok ? ':sparkles: 編集が完了しました\n' : ':warning: 編集パイプラインでエラー\n';
  notifySlack(prefix + String(summary || '(詳細なし)'), rawSlackTs(video.thread_ts) || undefined);
  logEvent('video_' + (ok ? 'done' : 'failed'), videoId + ': ' + String(summary || '').slice(0, 300));
  return true;
}

/** 生成済みショートを台帳に登録し、承認依頼をSlackへ出す（パイプラインから呼ばれる） */
function registerShort(payload) {
  var shortId = newId('sh');
  var kind = String(payload.kind || 'short'); // 'wide' = 16:9版（まとめ・ロング用素材）
  appendRowObj(SHEET.SHORTS, {
    short_id: shortId,
    created_at: fmtDateTime(nowJst()),
    video_id: String(payload.video_id || ''),
    script_id: String(payload.script_id || ''),
    title: String(payload.title || ''),
    score: String(payload.score || ''),
    duration: String(payload.duration || ''),
    slack_file_id: String(payload.slack_file_id || ''),
    url_private: String(payload.url_private || ''),
    status: kind === 'wide' ? SHORT_STATUS.STOCK : (isAutoApprove() ? SHORT_STATUS.APPROVED : SHORT_STATUS.STOCK),
    scheduled_at: '',
    youtube_url: '',
    published_at: '',
    kind: kind,
    question_idx: String(payload.question_idx || 0),
  });
  // 承認依頼（YouTubeショート投稿）は縦版のみ。ワイド版はまとめ用の素材
  if (kind !== 'wide') {
    var threadTs = '';
    var videos = readTable(SHEET.VIDEOS).filter(function (r) {
      return String(r.video_id) === String(payload.video_id || '');
    });
    if (videos.length) threadTs = rawSlackTs(videos[videos.length - 1].thread_ts);
    promptApproval(shortId, String(payload.title || ''), Number(payload.score) || 0, threadTs);
  }
  return true;
}

/** ショートの台帳を返す（まとめ動画の材料。実体はSlackからダウンロードする） */
function listShorts() {
  return readTable(SHEET.SHORTS).map(function (r) {
    return {
      short_id: String(r.short_id),
      created_at: String(r.created_at),
      video_id: String(r.video_id || ''),
      script_id: String(r.script_id || ''),
      title: String(r.title),
      score: Number(r.score) || 0,
      duration: Number(r.duration) || 0,
      slack_file_id: String(r.slack_file_id || ''),
      url_private: String(r.url_private || ''),
      status: String(r.status || 'stock'),
      kind: String(r.kind || 'short'),
    };
  });
}
