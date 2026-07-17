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

var VIDEO_STATUS = { PENDING: 'pending', DONE: 'done', FAILED: 'failed' };

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
  var script = findScriptForVideo(event.thread_ts);
  var existing = readTable(SHEET.VIDEOS);
  var added = 0;

  files.forEach(function (f) {
    // Slackはイベントを再送することがあるため file_id で重複排除する
    if (existing.some(function (r) { return String(r.file_id) === String(f.id); })) return;
    appendRowObj(SHEET.VIDEOS, {
      video_id: newId('vid'),
      created_at: fmtDateTime(nowJst()),
      script_id: script ? String(script.script_id) : '',
      thread_ts: 'ts_' + threadTs,
      file_id: String(f.id),
      file_name: String(f.name || 'video.mp4'),
      url_private: String(f.url_private_download || f.url_private || ''),
      size: String(f.size || ''),
      status: VIDEO_STATUS.PENDING,
      processed_at: '',
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
    ':inbox_tray: 動画を' + added + '本受け取りました。編集キューに入れました。' +
    (script ? '\n台本: ' + script.script_id : '') +
    (dispatched ? '\nクラウドで編集を開始します。終わったらこのスレッドにショートを返します。'
                : '\n編集が終わったらこのスレッドに結果を返します。'),
    threadTs
  );
  logEvent('video_received', added + '本 script=' + (script ? script.script_id : 'なし'));
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

/** 処理待ちの動画を、紐づく台本の質問ごと返す（パイプラインが取得する） */
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

/** 生成済みショートを台帳に登録する（パイプラインから呼ばれる） */
function registerShort(payload) {
  appendRowObj(SHEET.SHORTS, {
    short_id: newId('sh'),
    created_at: fmtDateTime(nowJst()),
    video_id: String(payload.video_id || ''),
    script_id: String(payload.script_id || ''),
    title: String(payload.title || ''),
    score: String(payload.score || ''),
    duration: String(payload.duration || ''),
    slack_file_id: String(payload.slack_file_id || ''),
    url_private: String(payload.url_private || ''),
    status: 'stock',
  });
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
    };
  });
}
