const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const themes = [{ theme: '移動の判断', category: 'evergreen', notes: '具体的な比較' },
  { theme: '乗り継ぎ', category: 'neta', notes: '' }];

function question(overrides = {}) {
  return { theme: '移動の判断', category: 'evergreen', question: '移動手段を選ぶとき、最初に何を比べますか？',
    format: 'decision', viewer_value: '所要時間を比べる基準が分かる',
    opening: '最初に比べる点を一言で', beats: ['判断基準', '具体的な比較', '使える場面'],
    closing: '冒頭の判断基準を、使える場面とともに一言で言い直す', visual: '',
    follow_up: '家を出てから到着までで考えると？', neta: '', ...overrides };
}
function valid() {
  return [question(), question({ theme: '乗り継ぎ', category: 'neta', format: 'experience',
    question: '乗り継ぎで迷った場面を一つ挙げるなら？' })];
}
function sandbox(history = []) {
  const calls = { ai: [], writes: [], slack: [], logs: [] };
  const context = vm.createContext({});
  for (const file of ['Config.js', 'Pure.js', 'ScriptQuality.js', 'ShootScript.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), context);
  }
  context.getProp = (key, fallback = '') => key === 'SHOOT_QUESTIONS' ? '2' : fallback;
  context.readTable = () => structuredClone(history);
  context.askAI = (system, user, limit) => { calls.ai.push({ system, user, limit }); return JSON.stringify(valid()); };
  context.logEvent = (...args) => calls.logs.push(args);
  context.pickThemesForShoot = () => structuredClone(themes);
  context.collectRecentNotes = () => ['移動手段の比較を話したい'];
  context.nowJst = () => new Date('2026-09-10T12:00:00Z');
  context.fmtDate = () => '2026-09-10';
  context.fmtDateTime = () => '2026-09-10 21:00:00';
  context.newId = () => 'sv_test';
  context.labelForCategory = cat => cat;
  context.sendSlack = (...args) => { calls.slack.push(args); return { ts: '123.456' }; };
  context.appendRowObj = (...args) => calls.writes.push(args);
  return { context, calls };
}

test('validated structure survives storage and appears in Slack using existing columns', () => {
  const { context, calls } = sandbox();
  context.startShootScript('sv', '今日の撮影台本');
  const questions = calls.writes.filter(([sheet]) => sheet === 'Questions').map(([, row]) => row);
  assert.equal(questions.length, 2);
  assert.deepEqual(Object.keys(questions[0]).sort(), ['script_id', 'idx', 'theme', 'category', 'question', 'neta', 'hint'].sort());
  assert.match(questions[0].hint, /見る人の持ち帰り:/);
  assert.match(questions[0].hint, /話し出し:/);
  assert.match(questions[0].hint, /話す順:/);
  assert.match(questions[0].hint, /締め（約束の回収）:/);
  assert.match(questions[0].hint, /詰まったら:/);
  assert.equal(questions[0].neta, '');
  assert.match(calls.slack[1][0], /所要時間を比べる基準/);
  assert.equal(calls.slack[1][1], '123.456');
  assert.doesNotMatch(calls.slack[1][0], /真顔|沈黙/);
});

test('latest 30 questions and both learning contexts reach generation', () => {
  const history = Array.from({ length: 40 }, (_, i) => ({ theme: '以前', question: '質問' + i, hint: '順番' }));
  const { context, calls } = sandbox(history);
  context.getProp = (key, fallback) => ({ THEME_INSIGHTS: '比較なら話せる', SCRIPT_INSIGHTS: '前置きを短く' }[key] || fallback);
  context.generateShootQuestions(themes, 2, ['実際のメモ']);
  const input = JSON.parse(calls.ai[0].user);
  assert.equal(input.recent_questions.length, 30);
  assert.equal(input.recent_questions[0].question, '質問10');
  assert.equal(input.recent_questions[29].question, '質問39');
  assert.equal(input.theme_insights, '比較なら話せる');
  assert.equal(input.script_insights, '前置きを短く');
  assert.match(calls.ai[0].system, /出典のない統計/);
  assert.match(calls.ai[0].system, /数字を一律に禁止しない/);
});

test('rejects repeated questions despite punctuation/fullwidth differences', () => {
  const { context } = sandbox();
  const raw = valid();
  raw[0].question = '移動 ＡＢＣ！？';
  assert.throws(() => context.validateShootQuestions(raw, themes, 2, [{ question: '移動abc?' }]), /重複/);
  raw[1].question = raw[0].question;
  assert.throws(() => context.validateShootQuestions(raw, themes, 2, []), /重複/);
});

test('rejects missing structure, wrong themes, uncovered themes, and wrong counts', () => {
  const { context } = sandbox();
  const variants = [[], [{}], valid().slice(0, 1),
    [question({ opening: '' }), valid()[1]],
    [question({ closing: '' }), valid()[1]],
    [question({ closing: undefined }), valid()[1]],
    [question({ visual: {} }), valid()[1]],
    [question({ beats: ['one'] }), valid()[1]],
    [question({ theme: 'invented' }), valid()[1]],
    [question({ category: 'news' }), valid()[1]],
    [question({ question: '長'.repeat(81) }), valid()[1]],
    [question({ neta: {} }), valid()[1]],
    [question(), question({ question: '別の質問？' })],
  ];
  for (const raw of variants) {
    assert.throws(() => context.validateShootQuestions(raw, themes, 2, []));
  }
});

test('three or more questions must use at least two formats', () => {
  const { context } = sandbox();
  const raw = [question(), question({ question: '次は？' }), question({ question: '最後は？' })];
  assert.throws(() => context.validateShootQuestions(raw, [themes[0]], 3, []), /単調/);
  raw[2].format = 'experience';
  assert.equal(context.validateShootQuestions(raw, [themes[0]], 3, []).length, 3);
});

test('invalid answer repairs once; repeated failure creates no partial script or notification', () => {
  const { context, calls } = sandbox();
  let attempts = 0;
  context.askAI = (system, user) => {
    attempts++;
    if (attempts === 1) return '[]';
    assert.match(user, /質問数/);
    return JSON.stringify(valid());
  };
  assert.equal(context.generateShootQuestions(themes, 2, []).length, 2);
  assert.equal(attempts, 2);
  attempts = 0;
  context.askAI = () => { attempts++; return '[]'; };
  assert.throws(() => context.startShootScript('sv', 'test'), /品質検証/);
  assert.equal(attempts, 2);
  assert.equal(calls.writes.length, 0);
  assert.equal(calls.slack.length, 0);
});

test('API errors are not treated as a bad script and retried', () => {
  const { context } = sandbox();
  let calls = 0;
  context.askAI = () => { calls++; throw new Error('HTTP 401'); };
  assert.throws(() => context.generateShootQuestions(themes, 2, []), /401/);
  assert.equal(calls, 1);
});

test('invalid question count fails before an API request', () => {
  const { context, calls } = sandbox();
  for (const count of [0, 1, NaN, 1.5, 11]) {
    assert.throws(() => context.generateShootQuestions(themes, count, []), /SHOOT_QUESTIONS/);
  }
  assert.equal(calls.ai.length, 0);
});

test('question and hint cannot insert Slack mentions', () => {
  const { context } = sandbox();
  const output = context.formatShootQuestion({ question: '<!channel> *質問*', hint: '<@U123>', neta: '' }, 0);
  assert.doesNotMatch(output, /<!channel>|<@U123>/);
  assert.match(output, /&lt;!channel&gt;/);
  assert.match(output, /^\*Q1\./);
});

test('optional visual guidance is stored only when useful; legacy hints still render', () => {
  const { context } = sandbox();
  const raw = valid();
  raw[0].visual = '家から目的地までの経路を紙に描く';
  const result = context.validateShootQuestions(raw, themes, 2, []);
  assert.match(result[0].hint, /見せるもの（任意）: 家から/);
  assert.doesNotMatch(result[1].hint, /見せるもの/);
  assert.match(context.formatShootQuestion({ question: '以前の質問', hint: '以前の自由記述' }, 0), /以前の自由記述/);
});
