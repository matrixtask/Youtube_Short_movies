/**
 * Pure.js — GASにもNodeテストにも依存しない純粋関数。
 */

/**
 * LLMの返答からJSONを寛容に取り出す。```json フェンスや前後の文を無視する。
 */
function parseJsonLoose(text) {
  if (text === null || text === undefined) throw new Error('empty response');
  var s = String(text).trim();
  s = s.replace(/```(?:json)?/g, '');
  var starts = [s.indexOf('['), s.indexOf('{')].filter(function (i) { return i >= 0; });
  if (!starts.length) throw new Error('no JSON found in: ' + s.slice(0, 200));
  var start = Math.min.apply(null, starts);
  var closer = s[start] === '[' ? ']' : '}';
  var end = s.lastIndexOf(closer);
  if (end <= start) throw new Error('unbalanced JSON in: ' + s.slice(0, 200));
  return JSON.parse(s.slice(start, end + 1));
}

/**
 * 重み付きランダム抽選。rand は 0-1 を返す関数（テスト時に固定可能）。
 */
function pickWeighted(items, weightFn, rand) {
  if (!items.length) return null;
  var r = (rand || Math.random)();
  var total = 0;
  var weights = items.map(function (it) {
    var w = Math.max(0, Number(weightFn(it)) || 0);
    total += w;
    return w;
  });
  if (total <= 0) return items[0];
  var target = r * total;
  var acc = 0;
  for (var i = 0; i < items.length; i++) {
    acc += weights[i];
    if (target < acc) return items[i];
  }
  return items[items.length - 1];
}

/**
 * Slackのts（例 "1784266535.690189"）まわりのヘルパー。
 * シートの数値化による精度落ちを防ぐため 'ts_' 接頭辞で保存する。
 */
function rawSlackTs(v) {
  return String(v === null || v === undefined ? '' : v).trim().replace(/^ts_/, '');
}

function normalizeSlackTs(v) {
  var s = rawSlackTs(v);
  if (/^\d+\.\d+$/.test(s)) {
    s = s.replace(/0+$/, '').replace(/\.$/, '');
  }
  return s;
}

function slackTsEqual(a, b) {
  var na = normalizeSlackTs(a);
  var nb = normalizeSlackTs(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  var fa = parseFloat(na);
  var fb = parseFloat(nb);
  return isFinite(fa) && isFinite(fb) && Math.abs(fa - fb) < 0.0001;
}

// Nodeテスト用（GASでは module は未定義なので無視される）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseJsonLoose: parseJsonLoose, pickWeighted: pickWeighted, rawSlackTs: rawSlackTs, normalizeSlackTs: normalizeSlackTs, slackTsEqual: slackTsEqual };
}
