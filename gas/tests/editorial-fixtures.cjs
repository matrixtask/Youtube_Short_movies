const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const themes = [{ theme: '移動の判断', category: 'evergreen', notes: '具体的な比較' },
  { theme: '乗り継ぎ', category: 'neta', notes: '' }];

function question(overrides = {}) {
  return { pitch_id: 'p1', theme: themes[0].theme, category: themes[0].category,
    question: '所要時間が短い案を選ばないのは、どんな条件ですか？',
    format: 'decision', viewer_value: '所要時間を比べる基準が分かる',
    opening: '所要時間だけでは、移動の良し悪しは決められるでしょうか。',
    beats: ['短い案と、余裕を持たせる案を比べます。', 'もし遅れが次の工程に伝わるなら、比較する条件が変わります。',
      '[本人確認: 実際の判断条件]を確かめるには、何を測るでしょうか。'],
    closing: '次の工程まで含めて比べる。そのために必要な測定は何でしょうか。', visual: '',
    follow_up: '予定外の遅れがあると、どこへの影響を見ますか？', neta: '', ...overrides };
}

function valid() {
  return [question(), question({ pitch_id: 'p2', theme: themes[1].theme, category: themes[1].category,
    format: 'experience', question: '乗り継ぎの余裕を設計するなら、何を測りますか？' })];
}

function discussion() {
  return { perspectives: ['rei', 'sebastian', 'scipio'].map(role => ({ role,
    objection: '速さだけを評価すると後工程への影響を見落とす。', revision: '遅れの伝わり方を比較する。' })),
    resolution: '比較と確認事項を具体化する。逆転は必須にしない。',
    pitches: Array.from({ length: 4 }, (_, i) => ({ id: 'p' + (i + 1), ...themes[i % 2],
      title: ['後工程を含めた移動の速さ', '乗り継ぎの余裕をどう測るか', '遅れの伝播を図で比べる', '予定変更の判断条件'][i],
      audience: '工程を設計する技術者', discovery: '区間の速さと全体の速さは、遅れの伝わり方で変わる。',
      conflict: '区間の所要時間と次の工程への影響を比較する。',
      development: '速い案と余裕のある案を図で比べ、遅れを仮定して判断条件を変える。',
      evidence_needed: '[本人確認: 実際に比較した条件と計測できる値]',
      recruiting_connection: '工程の遅れをどこで測り、どこに余裕を置くかを設計する仕事。' })) };
}

function review() {
  return { critique: '逆転を演出せず、判断条件と必要な計測を見せる。',
    selected: ['p1', 'p2'].map(pitch_id => ({ pitch_id, novelty: 4, specificity: 5, recruiting: 4,
      reason: '全体の速さという発見、二案の比較、測定の仕事への接続がある。',
      revision: '同じ図で二案を比べ、最後に次に測る項目を問う。' })),
    rejected: ['p3', 'p4'].map(pitch_id => ({ pitch_id, reason: '採用案と比較の論点が重複する。' })) };
}

function responseFor(system) {
  if (system.includes('STAGE: editorial_discussion')) return discussion();
  if (system.includes('STAGE: editorial_pr_review')) return review();
  if (system.includes('STAGE: script_writing')) return valid();
  throw new Error('Unexpected AI stage');
}

function sandbox(history = []) {
  const calls = { ai: [], writes: [], slack: [], notifications: [], logs: [] };
  const context = vm.createContext({});
  for (const file of ['Config.js', 'Pure.js', 'EditorialRoom.js', 'ScriptQuality.js', 'ShootScript.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), context);
  }
  context.getProp = (key, fallback = '') => key === 'SHOOT_QUESTIONS' ? '2' : fallback;
  context.readTable = () => structuredClone(history);
  context.askAI = (system, user, limit) => {
    calls.ai.push({ system, user, limit });
    return JSON.stringify(responseFor(system));
  };
  context.logEvent = (...args) => calls.logs.push(args);
  context.pickThemesForShoot = () => structuredClone(themes);
  context.collectRecentNotes = () => ['工程の遅れの比較を話したい'];
  context.nowJst = () => new Date('2026-09-11T12:00:00Z');
  context.fmtDate = () => '2026-09-11';
  context.fmtDateTime = () => '2026-09-11 21:00:00';
  context.newId = () => 'sv_test';
  context.labelForCategory = cat => cat;
  context.sendSlack = (...args) => { calls.slack.push(args); return { ts: '123.456' }; };
  context.notifySlack = message => calls.notifications.push(message);
  context.appendRowObj = (...args) => calls.writes.push(args);
  return { context, calls };
}

module.exports = { themes, question, valid, discussion, review, sandbox, responseFor };
