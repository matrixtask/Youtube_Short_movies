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
  // ---- 上位フォーマット（再生数狙い。ランキング・金額公開・対決・衝撃数字） ----
  ['世界最速の乗り物ランキングTOP5', 'neta', 3, 'ランキング型。数字で引く'],
  ['新幹線 vs 飛行機、東京-大阪どっちが本当に速い？', 'neta', 3, '対決型。ドアtoドアで検証'],
  ['空飛ぶクルマの値段、正直に公開します', 'evergreen', 3, '金額公開型。当事者しか言えない'],
  ['「1時間の通勤」を時給換算したら衝撃だった', 'neta', 2, '衝撃数字型。チャンネルの核に直結'],
  ['知らないと損する移動の裏ワザ3選', 'neta', 2, '〇選型。実用で保存されやすい'],
  ['飛行機のチケット代、何にいくら払ってるのか', 'neta', 2, '内訳公開型'],
  ['世界一渋滞がヤバい都市TOP3', 'neta', 2, 'ランキング型×共感'],
  ['パイロット免許、取るのに本当にかかった金額', 'evergreen', 2, '金額公開型×自分史'],
  ['スタートアップCEOの1日ルーティン', 'evergreen', 2, 'ルーティン型。飛行試験日が強い'],
  ['10年後に消える移動手段、残る移動手段', 'evergreen', 2, '未来予測断言型。コメントが伸びる'],
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

/**
 * 撮影実績からテーマの重みを自動調整する（テーマの自己調整システム）。
 * weeklyDigest から毎週実行される。手動実行も可。
 *
 * 実績の判定:
 *   - 台本が期限切れ（動画が来なかった）→ その台本の全テーマに miss
 *   - 動画は来たが、その質問からショートが生まれなかった → そのテーマに miss
 *     （喋りにくくて飛ばした・話が弱くて品質ゲート落ち、のどちらも「合わない」signal）
 *   - ショートが生まれた → そのテーマに hit
 *
 * 調整ルール（前回実行以降の実績で判定）:
 *   - miss 2回以上 & hit 0回 → 重みを半減。0.5未満になったら 0（=出さなくなる）
 *   - hit 2回以上 & miss 0回 → 重みを +0.5（上限3）
 * 累計の hits / misses はThemesシートに記録され、判断の根拠が残る。
 */
function tuneThemeWeights() {
  var props = PropertiesService.getScriptProperties();
  var since = getProp('THEME_TUNED_AT', fmtDateTime(new Date(nowJst().getTime() - 7 * 86400000)));

  var scripts = readTable(SHEET.SCRIPTS).filter(function (r) {
    return String(r.created_at) >= since &&
      (String(r.status) === SCRIPT_STATUS.EXPIRED || String(r.status) === SCRIPT_STATUS.DONE);
  });
  if (!scripts.length) return '対象期間（' + since + '以降）に完了・期限切れの台本がありません';

  var questions = readTable(SHEET.QUESTIONS);
  var shorts = readTable(SHEET.SHORTS).filter(function (r) {
    return String(r.kind || 'short') !== 'wide';
  });

  var stats = {}; // theme -> {hit, miss}
  scripts.forEach(function (s) {
    var sid = String(s.script_id);
    var answered = {};
    shorts.forEach(function (sh) {
      if (String(sh.script_id) === sid && Number(sh.question_idx) > 0) {
        answered[Number(sh.question_idx)] = true;
      }
    });
    var expired = String(s.status) === SCRIPT_STATUS.EXPIRED;
    questions.forEach(function (q) {
      if (String(q.script_id) !== sid) return;
      var t = String(q.theme);
      stats[t] = stats[t] || { hit: 0, miss: 0 };
      if (!expired && answered[Number(q.idx)]) stats[t].hit++;
      else stats[t].miss++;
    });
  });

  var changed = [];
  readTable(SHEET.THEMES).forEach(function (r) {
    var st = stats[String(r.theme)];
    if (!st) return;
    var w = Number(r.weight);
    if (!isFinite(w)) w = 1;
    var newW = w;
    if (st.miss >= 2 && st.hit === 0 && w > 0) {
      newW = Math.round(w * 0.5 * 10) / 10;
      if (newW < 0.5) newW = 0;
    } else if (st.hit >= 2 && st.miss === 0 && w > 0) {
      newW = Math.min(3, w + 0.5);
    }
    updateRowsWhere(SHEET.THEMES, 'theme', r.theme, {
      hits: (Number(r.hits) || 0) + st.hit,
      misses: (Number(r.misses) || 0) + st.miss,
      weight: newW,
    });
    if (newW !== w) {
      changed.push('・「' + r.theme + '」 ' + w + ' → ' + newW +
        (newW === 0 ? '（今後出しません。復活はシートでweightを戻す）' : ''));
    }
  });

  props.setProperty('THEME_TUNED_AT', fmtDateTime(nowJst()));
  var msg = changed.length
    ? '撮影実績によるテーマ調整:\n' + changed.join('\n')
    : 'テーマの重み変更はありません（実績: ' + Object.keys(stats).length + 'テーマ分を集計）';
  logEvent('theme_tuning', msg);
  return msg;
}
