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
    premise: '仮に同じ需要と到着期限で、区間の速さと遅れへの余裕を比べます。',
    hypotheses: [
      { statement: '一つは、区間の所要時間を短くする案。', reason: '遅れなければ早く着けます。',
        weakness: 'ただし後工程への遅れが伝わりやすくなります。', reconsider: '遅れが繰り返し伝わるなら、余裕を増やします。' },
      { statement: 'もう一つは、途中に余裕を置く案。', reason: '遅れを途中で吸収できます。',
        weakness: 'ただし順調なときも待ち時間が増えます。', reconsider: '余裕を使わない日が続くなら、短縮を検討します。' },
    ],
    closing: '区間の速さと遅れの伝わり方。どんな観測なら見直すかまで含めた設計です。', visual: '',
    alternative: '全区間を一律にせず、遅れの伝わりやすい部分だけ余裕を置く案もある。',
    follow_up: '予定外の遅れがあると、どこへの影響を見ますか？', neta: '', ...overrides };
}

function valid() {
  return [question(), question({ pitch_id: 'p2', theme: themes[1].theme, category: themes[1].category,
    format: 'experience', question: '乗り継ぎの余裕を設計するなら、何を測りますか？' })];
}

function discussion() {
  return { perspectives: ['rei', 'sebastian', 'hannibal'].map(role => ({ role,
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
      depth: 5, speakability: 4, clarity: 4,
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

function sandbox(history = [], sharedTables) {
  const calls = { ai: [], writes: [], slack: [], notifications: [], logs: [], delivery: [] };
  const tables = sharedTables || { Questions: structuredClone(history), Scripts: [], ScriptJobs: [] };
  calls.tables = tables;
  const context = vm.createContext({});
  for (const file of ['Config.js', 'Pure.js', 'Sheets.js', 'EditorialRoom.js', 'ScriptQuality.js', 'ShootScript.js', 'ScriptJobs.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), context);
  }
  context.getProp = (key, fallback = '') => key === 'SHOOT_QUESTIONS' ? '2' : fallback;
  context.readTable = sheet => structuredClone(tables[sheet] || []).map((r, i) => ({ ...r, _row: i + 2 }));
  context.getSheet = sheet => ({
    getLastRow: () => (tables[sheet] || []).length + 1,
    getMaxRows: () => 1000,
    insertRowsAfter() {},
    getRange: row => ({ setValues: values => {
      const obj = Object.fromEntries(Array.from(context.SHEET_HEADERS[sheet]).map((h, i) => [h, values[0][i]]));
      (tables[sheet] ||= [])[row - 2] = structuredClone(obj);
    } }),
  });
  context.SpreadsheetApp = { flush() {} };
  let locked = false;
  context.LockService = { getScriptLock: () => ({
    tryLock: () => { if (locked) return false; locked = true; return true; },
    releaseLock: () => { locked = false; },
  }) };
  calls.triggers = [];
  context.ScriptApp = {
    getProjectTriggers: () => calls.triggers.map(name => ({ getHandlerFunction: () => name })),
    newTrigger: name => ({ timeBased: () => ({ everyMinutes: minutes => ({ create: () => {
      if (minutes !== 1) throw new Error('Expected minute worker');
      calls.triggers.push(name);
    } }) }) }),
  };
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
  context.newId = kind => kind + '_test_' + (tables.ScriptJobs.length + 1);
  context.labelForCategory = cat => cat;
  context.Utilities = { sleep: ms => calls.delivery.push(['sleep', ms]) };
  context.sendSlack = (...args) => { calls.slack.push(args); calls.delivery.push(['send']); return { ts: '123.456' }; };
  context.notifySlack = message => calls.notifications.push(message);
  context.appendRowObj = (sheet, obj) => {
    calls.writes.push([sheet, obj]);
    (tables[sheet] ||= []).push(structuredClone(obj));
  };
  context.drainShootJobs = () => {
    for (let i = 0; i < 20; i++) {
      if (!context.readShootJobs().some(j => j.status === 'queued')) return;
      context.runShootScriptJobs();
    }
    throw new Error('Worker did not finish');
  };
  return { context, calls };
}

module.exports = { themes, question, valid, discussion, review, sandbox, responseFor };
