/**
 * Themes.js — テーマプールと撮影日のテーマ選定
 *
 * category:
 *   evergreen … 定番（仕事観・事業の学び・失敗談など）
 *   news      … 時事ネタ
 *   neta      … ネタ（ゆるい話・あるある・自虐など）
 */

var DEFAULT_THEMES = [
  // ---- 定番（移動・スピードの持論と体験） ----
  ['渋滞・行列で一番イラッとした話', 'evergreen', 3, '共感の入口。オチまで言う'],
  ['移動が速くなると人生はどう変わるか', 'evergreen', 3, 'チャンネルの核。持論を言い切る'],
  ['通勤・移動時間の使い方', 'evergreen', 2, '時間術・ライフハック'],
  ['移動効率を上げる自分ルール', 'evergreen', 2, '空港/駅/車での具体テク'],
  ['世界で感動した移動インフラ', 'evergreen', 2, '海外の電車・空港・道路の話'],
  ['乗り物の「ここが不合理」', 'evergreen', 2, '設計・運用への物申す'],
  ['出張・旅の失敗談', 'evergreen', 2, '失敗談は強い'],
  ['空飛ぶクルマ、正直どこまで来てる？', 'evergreen', 2, '中の人の本音。専門用語は噛み砕く'],
  ['子どもの頃に夢見た未来の乗り物', 'evergreen', 1, 'ロマン枠'],
  ['事業開発で最近ぶつかった壁', 'evergreen', 1, '会社の話は低頻度で'],
  // ---- 時事 ----
  ['交通・モビリティの最新ニュースに一言', 'news', 3, '渋滞・鉄道・航空なんでも'],
  ['新しい乗り物・移動サービスをレビュー', 'news', 2, '試した/調べた感想'],
  ['自動運転・AIと移動の未来', 'news', 2, '専門を活かして解説'],
  ['海外のモビリティ事情', 'news', 2, '日本との違いで引く'],
  // ---- ネタ ----
  ['移動あるある', 'neta', 3, '電車・飛行機・車。ツッコミ向き'],
  ['「これ間に合うか？」ギリギリ移動エピソード', 'neta', 2, '緊張感ある小話'],
  ['最悪の乗り継ぎ・遅延体験', 'neta', 2, '不運話は笑いになる'],
  ['移動中にやってる変な習慣', 'neta', 2, '人間味枠'],
  ['乗り物マニアの細かすぎる話', 'neta', 1, '早口で語るほど良い'],
  ['もし信号や渋滞がこの世に無かったら', 'neta', 1, '妄想系。真顔で語る'],
];

function seedThemesIfEmpty() {
  if (readTable(SHEET.THEMES).length > 0) return;
  DEFAULT_THEMES.forEach(function (t) {
    appendRowObj(SHEET.THEMES, { theme: t[0], category: t[1], weight: t[2], last_used: '', notes: t[3] });
  });
}

/**
 * 既存シートに、まだ無いデフォルトテーマだけを追加する（何度実行しても安全）。
 * テーマを増やしたいときは DEFAULT_THEMES に足して clasp push → これを実行。
 * 出したくないテーマはシートで weight を 0 にする（削除でもOK）。
 */
function addNewThemes() {
  var existing = readTable(SHEET.THEMES).map(function (r) { return String(r.theme); });
  var added = 0;
  DEFAULT_THEMES.forEach(function (t) {
    if (existing.indexOf(t[0]) >= 0) return;
    appendRowObj(SHEET.THEMES, { theme: t[0], category: t[1], weight: t[2], last_used: '', notes: t[3] });
    added++;
  });
  logEvent('themes_added', added + '件');
  return added + '件のテーマを追加しました';
}

/**
 * 撮影日のテーマを選ぶ。定番1〜2 + (時事 or ネタ)1 が基本。
 * 直近3日で使ったテーマは重みを下げる。
 */
function pickThemesForShoot() {
  var all = readTable(SHEET.THEMES);
  if (!all.length) throw new Error('Themesシートが空です。setupSpreadsheet() を実行してください');

  var now = nowJst();
  function effectiveWeight(t) {
    var w = Number(t.weight);
    if (!isFinite(w)) w = 1;
    if (w <= 0) return 0; // weight 0 = このテーマは出さない
    if (t.last_used) {
      var last = new Date(t.last_used);
      var days = (now.getTime() - last.getTime()) / 86400000;
      if (days < 3) w *= 0.2;
    }
    return w;
  }

  function pickFrom(categories, exclude) {
    var pool = all.filter(function (t) {
      return categories.indexOf(String(t.category)) >= 0 &&
        (!exclude || exclude.indexOf(t.theme) < 0);
    });
    if (!pool.length) return null;
    return pickWeighted(pool, effectiveWeight);
  }

  var picked = [];
  var evergreen = pickFrom(['evergreen']);
  if (evergreen) picked.push(evergreen);
  var second = pickFrom(['news', 'neta'], picked.map(function (t) { return t.theme; }));
  if (second) picked.push(second);

  picked.forEach(function (t) {
    updateRowsWhere(SHEET.THEMES, 'theme', t.theme, { last_used: fmtDate(now) });
  });
  return picked.map(function (t) {
    return { theme: String(t.theme), category: String(t.category), notes: String(t.notes || '') };
  });
}

function labelForCategory(cat) {
  return { evergreen: '定番', news: '時事', neta: 'ネタ' }[cat] || cat;
}
