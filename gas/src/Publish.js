/**
 * Publish.js — 承認とYouTube自動投稿の管理
 *
 * 流れ:
 *   1. ショート生成 → registerShort() が台帳に登録し、承認依頼をSlackへ
 *      （AUTO_APPROVE=true なら承認をスキップして approved に）
 *   2. Slackで「承認 <コード>」「却下 <コード>」「承認 全部」
 *   3. 毎時 youtubeTick() が承認済みを投稿枠（YOUTUBE_SLOT_TIMES）に割当て、
 *      時刻が来たら GitHub Actions（publish.yml）を起動
 *   4. Actionsの `ytshorts publish` が action=publish_queue で対象を取得し、
 *      YouTubeへアップロード → action=published で結果を報告
 *   5. markPublished() がシートを更新してSlackに通知
 */

/** 承認コマンドで打ちやすいよう short_id の末尾4桁をコードとして使う */
function shortCode(shortId) {
  return String(shortId).slice(-4);
}

/**
 * 「承認 xxxx」「却下 xxxx」「承認 全部」を処理する。
 * 承認・却下コマンドでなければ false（他のハンドラに回す）。
 */
function handleApprovalCommand(text) {
  var m = String(text || '').trim().match(/^(承認|却下|approve|reject)\s*[:：]?\s*(\S+)$/i);
  if (!m) return false;
  var isApprove = /承認|approve/i.test(m[1]);
  var target = m[2];
  var stock = readTable(SHEET.SHORTS).filter(function (r) {
    return String(r.status) === SHORT_STATUS.STOCK;
  });

  var targets;
  if (/^(全部|すべて|all)$/i.test(target)) {
    targets = stock;
  } else {
    targets = stock.filter(function (r) {
      return String(r.short_id) === target || shortCode(r.short_id) === target;
    });
  }
  if (!targets.length) {
    sendSlack(':mag: 「' + target + '」に一致する承認待ちのショートがありません。');
    return true;
  }

  var newStatus = isApprove ? SHORT_STATUS.APPROVED : SHORT_STATUS.REJECTED;
  targets.forEach(function (r) {
    updateRowsWhere(SHEET.SHORTS, 'short_id', r.short_id, { status: newStatus });
  });
  var titles = targets.map(function (r) { return '「' + r.title + '」'; }).join(' ');
  sendSlack(isApprove
    ? ':white_check_mark: ' + targets.length + '本を承認しました: ' + titles + '\n次の投稿枠でYouTubeへ自動投稿します。'
    : ':wastebasket: ' + targets.length + '本を却下しました: ' + titles);
  logEvent('short_' + (isApprove ? 'approved' : 'rejected'), targets.map(function (r) { return r.short_id; }).join(','));
  return true;
}

/** 承認依頼をSlackに出す（registerShort から呼ばれる） */
function promptApproval(shortId, title, score, threadTs) {
  var code = shortCode(shortId);
  var msg = isAutoApprove()
    ? ':white_check_mark: 「' + title + '」（' + score + '点）を自動承認しました。次の投稿枠でYouTubeへ投稿します。'
    : [
        ':hourglass_flowing_sand: 承認待ち: 「' + title + '」（' + score + '点）',
        '投稿してよければ「承認 ' + code + '」、やめるなら「却下 ' + code + '」と返信してください。',
        '（まとめて承認は「承認 全部」）',
      ].join('\n');
  notifySlack(msg, threadTs || undefined);
}

/**
 * 毎時実行: 承認済みショートを投稿枠に割当て、時刻が来たらActionsを起動する。
 */
function youtubeTick() {
  var shorts = readTable(SHEET.SHORTS);
  var now = nowJst();

  // 1) 承認済み → 投稿枠の割当て（スコアの高い順）
  var taken = shorts
    .filter(function (r) { return String(r.scheduled_at || '').length > 0; })
    .map(function (r) { return String(r.scheduled_at); });
  var approved = shorts
    .filter(function (r) { return String(r.status) === SHORT_STATUS.APPROVED; })
    .sort(function (a, b) { return Number(b.score) - Number(a.score); });
  if (approved.length) {
    var slots = computeNextSlots(approved.length, {
      now: now,
      slotTimes: ytSlotTimes(),
      taken: taken,
      maxPerDay: maxUploadsPerDay(),
    });
    approved.slice(0, slots.length).forEach(function (r, i) {
      updateRowsWhere(SHEET.SHORTS, 'short_id', r.short_id, {
        status: SHORT_STATUS.SCHEDULED,
        scheduled_at: slots[i],
      });
      logEvent('short_scheduled', r.short_id + ' -> ' + slots[i]);
    });
  }

  // 2) 投稿時刻が来たものがあればクラウド実行を起動
  //    （GITHUB未設定でも publish.yml の毎時実行が拾う）
  var due = listPublishQueue();
  if (due.length) {
    triggerGithub('publish-requested');
  }
}

/** 投稿時刻を過ぎた scheduled ショートを返す（パイプラインが取得する） */
function listPublishQueue() {
  var nowStr = fmtDateTime(nowJst());
  var privacy = String(getProp('YOUTUBE_PRIVACY', 'public'));
  return readTable(SHEET.SHORTS)
    .filter(function (r) {
      return String(r.status) === SHORT_STATUS.SCHEDULED &&
        String(r.scheduled_at) && String(r.scheduled_at) <= nowStr &&
        String(r.url_private);
    })
    .map(function (r) {
      return {
        short_id: String(r.short_id),
        title: String(r.title),
        score: Number(r.score) || 0,
        url_private: String(r.url_private),
        privacy: privacy,
      };
    });
}

/** パイプラインからの投稿結果を記録してSlackに通知する */
function markPublished(shortId, ok, detail) {
  var rows = readTable(SHEET.SHORTS).filter(function (r) {
    return String(r.short_id) === String(shortId);
  });
  if (!rows.length) return false;
  var short = rows[rows.length - 1];
  if (ok) {
    updateRowsWhere(SHEET.SHORTS, 'short_id', shortId, {
      status: SHORT_STATUS.PUBLISHED,
      youtube_url: String(detail || ''),
      published_at: fmtDateTime(nowJst()),
    });
    notifySlack(':tv: YouTubeに投稿しました: 「' + short.title + '」\n' + String(detail || ''));
  } else {
    updateRowsWhere(SHEET.SHORTS, 'short_id', shortId, { status: SHORT_STATUS.FAILED });
    notifySlack(':warning: YouTube投稿に失敗: 「' + short.title + '」\n' + String(detail || '').slice(0, 300));
  }
  logEvent('short_' + (ok ? 'published' : 'publish_failed'), shortId + ': ' + String(detail || '').slice(0, 200));
  return true;
}
