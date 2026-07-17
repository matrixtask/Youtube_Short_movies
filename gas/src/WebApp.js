/**
 * WebApp.js — Webアプリのエンドポイント
 *
 * doGet  : ローカル編集パイプライン用のJSON API（?token=ADMIN_TOKEN&action=scripts）
 * doPost : Slack Events APIの受け口 + パイプラインからの処理結果レポート
 *
 * デプロイ: GASエディタ > デプロイ > 新しいデプロイ > ウェブアプリ
 *   実行ユーザー: 自分 / アクセス: 全員
 * デプロイURLを Script Properties の WEBAPP_URL に保存し、
 * SlackアプリのEvent SubscriptionsのRequest URLにも設定する。
 * ローカルの pipeline/config.yaml の gas_webapp_url にも同じURLを設定する。
 */

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (!p.token || p.token !== getProp('ADMIN_TOKEN')) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'unauthorized' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // 処理待ちの動画を返す（`ytshorts pull` が取得してダウンロード・編集する）
  if (p.action === 'videos') {
    return ContentService.createTextOutput(JSON.stringify({ ok: true, videos: listPendingVideos() }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // 最近の台本と質問を返す（パイプラインが編集プランの文脈に使う）
  if (p.action === 'scripts') {
    var limit = Number(p.limit || 3);
    var questions = readTable(SHEET.QUESTIONS);
    var scripts = readTable(SHEET.SCRIPTS)
      .filter(function (r) { return String(r.status) !== SCRIPT_STATUS.EXPIRED; })
      .slice(-limit)
      .map(function (r) {
        return {
          script_id: String(r.script_id),
          created_at: String(r.created_at),
          themes: String(r.themes),
          status: String(r.status),
          questions: questions
            .filter(function (q) { return String(q.script_id) === String(r.script_id); })
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
    return ContentService.createTextOutput(JSON.stringify({ ok: true, scripts: scripts }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'unknown action' }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var payload;
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (err) {
    return ContentService.createTextOutput('bad request');
  }

  // SlackのURL検証
  if (payload.type === 'url_verification') {
    return ContentService.createTextOutput(payload.challenge);
  }

  // パイプラインからの動画単位の処理結果（元のスレッドに結果が返る）
  // 例: POST {"action":"video_done","token":"...","video_id":"...","ok":true,"summary":"..."}
  if (payload.action === 'video_done') {
    if (!payload.token || payload.token !== getProp('ADMIN_TOKEN')) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'unauthorized' }));
    }
    var found = markVideoDone(String(payload.video_id || ''), payload.ok !== false, String(payload.summary || ''));
    return ContentService.createTextOutput(JSON.stringify({ ok: found }));
  }

  // パイプラインからの処理結果レポート
  // 例: POST {"action":"report","token":"...","script_id":"...","summary":"3本のショートを生成..."}
  if (payload.action === 'report') {
    if (!payload.token || payload.token !== getProp('ADMIN_TOKEN')) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'unauthorized' }));
    }
    if (payload.script_id) {
      updateRowsWhere(SHEET.SCRIPTS, 'script_id', payload.script_id, {
        status: SCRIPT_STATUS.DONE,
        processed_at: fmtDateTime(nowJst()),
      });
    }
    notifySlack(':sparkles: 編集パイプラインの結果\n' + String(payload.summary || '(詳細なし)'));
    logEvent('pipeline_report', String(payload.script_id || '') + ': ' + String(payload.summary || '').slice(0, 300));
    return ContentService.createTextOutput(JSON.stringify({ ok: true }));
  }

  if (payload.type === 'event_callback') {
    // GASはリクエストヘッダを読めないため署名検証ができない。
    // 代わりにチャンネルIDの一致を確認し、event_idで重複排除する。
    var event = payload.event || {};
    var eventId = payload.event_id;
    var cache = CacheService.getScriptCache();
    if (eventId) {
      if (cache.get('ev_' + eventId)) return ContentService.createTextOutput('dup');
      cache.put('ev_' + eventId, '1', 3600);
    }
    var subtype = String(event.subtype || '');
    if (
      event.type === 'message' &&
      !event.bot_id &&
      (subtype === '' || subtype === 'file_share') && // 動画アップロードは file_share で届く
      String(event.channel).trim() === String(getProp('SLACK_CHANNEL_ID') || '').trim()
    ) {
      try {
        if (event.files && event.files.length) {
          handleVideoUpload(event);
        } else if (event.thread_ts) {
          handleScriptReply(event.thread_ts, event.text);
        } else {
          handleChannelMessage(event.text);
        }
      } catch (err) {
        logEvent('slack_event_error', String(err));
      }
    } else if (event.type === 'message' && !event.bot_id) {
      logEvent('slack_event_ignored', 'channel=' + event.channel + ' subtype=' + (event.subtype || '') + ' expected=' + getProp('SLACK_CHANNEL_ID'));
    }
  }
  return ContentService.createTextOutput('ok');
}
