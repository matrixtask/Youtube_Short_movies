/**
 * Notion.js — トークテーマとショート台帳をNotionのWikiへ同期（任意機能）
 *
 * セットアップ:
 *   1. https://www.notion.so/my-integrations でインテグレーションを作成し、
 *      シークレット(ntn_... / secret_...)をスクリプトプロパティ NOTION_TOKEN に設定
 *   2. Wikiにする親ページをNotionで開き、右上「…」→「コネクト」で
 *      作成したインテグレーションを追加（これをしないと403になる）
 *   3. 親ページのID（URL末尾の32桁英数字）を NOTION_PARENT_PAGE_ID に設定
 *   4. GASエディタで setupNotionDatabases() を実行
 *      →「トークテーマ」「ショート台帳」の2つのデータベースが自動作成される
 *
 * 同期は毎晩22時台（installTriggers）+ 手動実行。方向はシート→Notionの一方向。
 * テーマの追加・編集はスプレッドシートのThemesシートで行ってください。
 */

function notionEnabled() {
  return !!(getProp('NOTION_TOKEN') && getProp('NOTION_PARENT_PAGE_ID'));
}

function notionApi(method, path, payload) {
  var res = UrlFetchApp.fetch('https://api.notion.com/v1' + path, {
    method: method,
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + requireProp('NOTION_TOKEN'),
      'Notion-Version': '2022-06-28',
    },
    payload: payload ? JSON.stringify(payload) : undefined,
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  var body = res.getContentText();
  if (code >= 300) throw new Error('Notion API error ' + code + ': ' + body.slice(0, 300));
  return JSON.parse(body);
}

/** 親ページ配下にデータベース2つを作成する（作成済みならスキップ） */
function setupNotionDatabases() {
  if (!notionEnabled()) return 'NOTION_TOKEN / NOTION_PARENT_PAGE_ID を設定してください';
  var props = PropertiesService.getScriptProperties();
  var parent = { type: 'page_id', page_id: requireProp('NOTION_PARENT_PAGE_ID') };

  if (!getProp('NOTION_THEMES_DB_ID')) {
    var themesDb = notionApi('post', '/databases', {
      parent: parent,
      title: [{ text: { content: 'トークテーマ' } }],
      properties: {
        Name: { title: {} },
        'カテゴリ': { select: { options: [{ name: '定番' }, { name: '時事' }, { name: 'ネタ' }] } },
        '重み': { number: {} },
        '最終使用': { date: {} },
        'メモ': { rich_text: {} },
        '出典': { rich_text: {} },
      },
    });
    props.setProperty('NOTION_THEMES_DB_ID', themesDb.id);
    logEvent('notion_setup', 'トークテーマDB: ' + themesDb.id);
  }

  if (!getProp('NOTION_SHORTS_DB_ID')) {
    var shortsDb = notionApi('post', '/databases', {
      parent: parent,
      title: [{ text: { content: 'ショート台帳' } }],
      properties: {
        Name: { title: {} },
        'ID': { rich_text: {} },
        'スコア': { number: {} },
        '状態': { select: { options: [
          { name: 'stock' }, { name: 'approved' }, { name: 'scheduled' },
          { name: 'published' }, { name: 'rejected' }, { name: 'failed' },
        ] } },
        '種別': { select: { options: [{ name: 'short' }, { name: 'wide' }] } },
        '長さ秒': { number: {} },
        '予約枠': { date: {} },
        'YouTube': { url: {} },
        '作成日': { date: {} },
      },
    });
    props.setProperty('NOTION_SHORTS_DB_ID', shortsDb.id);
    logEvent('notion_setup', 'ショート台帳DB: ' + shortsDb.id);
  }
  return 'OK: トークテーマ / ショート台帳 のデータベースを用意しました';
}

function notionQueryAll(dbId) {
  var results = [];
  var cursor = null;
  do {
    var payload = { page_size: 100 };
    if (cursor) payload.start_cursor = cursor;
    var res = notionApi('post', '/databases/' + dbId + '/query', payload);
    results = results.concat(res.results || []);
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return results;
}

function notionPlainText(prop) {
  var arr = (prop && (prop.title || prop.rich_text)) || [];
  return arr.map(function (t) { return t.plain_text; }).join('');
}

function toIsoJst(ymdhm) {
  var s = String(ymdhm).trim();
  if (s.length <= 10) return s; // 'yyyy-MM-dd'
  return s.replace(' ', 'T') + ':00+09:00';
}

/** Themesシート → Notion「トークテーマ」DB（テーマ名で突き合わせ） */
function syncThemesToNotion() {
  if (!notionEnabled()) return 'Notion未設定のためスキップ';
  setupNotionDatabases();
  var dbId = requireProp('NOTION_THEMES_DB_ID');
  var existing = {};
  notionQueryAll(dbId).forEach(function (p) {
    existing[notionPlainText(p.properties.Name)] = p.id;
  });
  var count = 0;
  readTable(SHEET.THEMES).forEach(function (r) {
    var name = String(r.theme);
    var properties = {
      Name: { title: [{ text: { content: name } }] },
      'カテゴリ': { select: { name: labelForCategory(String(r.category)) } },
      '重み': { number: Number(r.weight) || 0 },
      'メモ': { rich_text: [{ text: { content: String(r.notes || '').slice(0, 1900) } }] },
    };
    if (r.last_used) properties['最終使用'] = { date: { start: String(r.last_used).slice(0, 10) } };
    try {
      if (existing[name]) {
        notionApi('patch', '/pages/' + existing[name], { properties: properties });
      } else {
        notionApi('post', '/pages', { parent: { database_id: dbId }, properties: properties });
      }
      count++;
    } catch (e) {
      logEvent('notion_error', name + ': ' + e);
    }
  });
  return count + '件のテーマを同期しました';
}

/** Shortsシート → Notion「ショート台帳」DB（short_idで突き合わせ） */
function syncShortsToNotion() {
  if (!notionEnabled()) return 'Notion未設定のためスキップ';
  setupNotionDatabases();
  var dbId = requireProp('NOTION_SHORTS_DB_ID');
  var existing = {};
  notionQueryAll(dbId).forEach(function (p) {
    existing[notionPlainText(p.properties['ID'])] = p.id;
  });
  var count = 0;
  readTable(SHEET.SHORTS).forEach(function (r) {
    var id = String(r.short_id);
    var properties = {
      Name: { title: [{ text: { content: String(r.title || '(無題)').slice(0, 100) } }] },
      'ID': { rich_text: [{ text: { content: id } }] },
      'スコア': { number: Number(r.score) || 0 },
      '状態': { select: { name: String(r.status || 'stock') } },
      '種別': { select: { name: String(r.kind || 'short') } },
      '長さ秒': { number: Number(r.duration) || 0 },
      '作成日': { date: { start: toIsoJst(String(r.created_at)) } },
    };
    if (r.scheduled_at) properties['予約枠'] = { date: { start: toIsoJst(String(r.scheduled_at)) } };
    if (r.youtube_url) properties['YouTube'] = { url: String(r.youtube_url) };
    try {
      if (existing[id]) {
        notionApi('patch', '/pages/' + existing[id], { properties: properties });
      } else {
        notionApi('post', '/pages', { parent: { database_id: dbId }, properties: properties });
      }
      count++;
    } catch (e) {
      logEvent('notion_error', id + ': ' + e);
    }
  });
  return count + '件のショートを同期しました';
}

/** 毎晩の同期（installTriggersで登録） */
function nightlyNotionSync() {
  if (!notionEnabled()) return;
  try {
    logEvent('notion_sync', syncThemesToNotion() + ' / ' + syncShortsToNotion());
  } catch (e) {
    logEvent('notion_error', String(e));
  }
}
