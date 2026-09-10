const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function sandbox(properties = {}) {
  const calls = { http: [], legacy: 0, writes: [], logs: [] };
  const context = vm.createContext({});
  for (const file of ['Config.js', 'Pure.js', 'AI.js', 'Themes.js', 'EditorialRoom.js', 'ScriptQuality.js', 'ShootScript.js', 'WebApp.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), context);
  }
  context.getProp = (name, fallback = '') => properties[name] || fallback;
  context.requireProp = name => {
    if (!properties[name]) throw new Error(name + ' is missing');
    return properties[name];
  };
  context.askClaude = () => { calls.legacy++; return '{"legacy":true}'; };
  context.nowJst = () => new Date('2026-09-10T03:00:00Z');
  context.fmtDate = () => '2026-09-10';
  context.collectRecentNotes = () => ['出張の乗り継ぎで失敗した'];
  context.logEvent = (...args) => calls.logs.push(args);
  context.updateRowsWhere = (...args) => calls.writes.push(args);
  context.UrlFetchApp = { fetch: (url, options) => {
    calls.http.push({ url, options });
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify({
      status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }],
    }) };
  } };
  context.ContentService = {
    MimeType: { JSON: 'application/json' },
    createTextOutput: text => ({ text, setMimeType() { return this; } }),
  };
  return { context, calls };
}

test('auto preserves legacy without OpenAI key, and switches when registered', () => {
  let { context, calls } = sandbox();
  assert.equal(context.askAIJson('s', 'u', 1000).legacy, true);
  assert.equal(calls.legacy, 1);
  assert.equal(calls.http.length, 0);
  ({ context, calls } = sandbox({ OPENAI_API_KEY: 'test-key' }));
  assert.equal(context.askAIJson('s', 'u', 1000).ok, true);
  assert.equal(calls.legacy, 0);
  const { url, options } = calls.http[0];
  const payload = JSON.parse(options.payload);
  assert.equal(url, 'https://api.openai.com/v1/responses');
  assert.equal(options.headers.Authorization, 'Bearer test-key');
  assert.equal(payload.model, 'gpt-6-astra');
  assert.equal(payload.store, false);
  assert.equal(payload.reasoning.effort, 'medium');
  assert.equal(payload.max_output_tokens, 12000);
  assert.equal(payload.instructions, 's');
  assert.equal(payload.input[0].content[0].type, 'input_text');
  assert.equal('temperature' in payload, false);
});

test('explicit provider requires its key and respects legacy choice', () => {
  let { context, calls } = sandbox({ LLM_PROVIDER: 'openai' });
  assert.throws(() => context.askAI('s', 'u'), /OPENAI_API_KEY/);
  assert.equal(calls.legacy, 0);
  assert.equal(calls.http.length, 0);
  ({ context, calls } = sandbox({ LLM_PROVIDER: 'anthropic', OPENAI_API_KEY: 'test-key' }));
  assert.equal(context.askAIJson('s', 'u').legacy, true);
  assert.equal(calls.http.length, 0);
});

test('API failure neither leaks response text nor switches provider', () => {
  const { context, calls } = sandbox({ OPENAI_API_KEY: 'test-key' });
  context.UrlFetchApp.fetch = () => ({ getResponseCode: () => 401, getContentText: () => 'test-key' });
  assert.throws(() => context.askAI('s', 'u'), /^Error: OpenAI API error HTTP 401$/);
  assert.equal(calls.legacy, 0);
  assert.equal(JSON.stringify(calls.logs).includes('test-key'), false);
});

test('incomplete, refused and empty responses cannot become a plan', () => {
  for (const body of [
    { status: 'incomplete', output: [] },
    { status: 'completed', output: [] },
    { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal' }] }] },
  ]) {
    const { context } = sandbox({ OPENAI_API_KEY: 'test-key' });
    context.UrlFetchApp.fetch = () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify(body) });
    assert.throws(() => context.askAIJson('s', 'u'), /OpenAI/);
  }
});

test('JSON parsing retries once and unknown settings stop before fetch', () => {
  const { context } = sandbox();
  let attempts = 0;
  context.askAI = () => { attempts++; return 'invalid'; };
  assert.throws(() => context.askAIJson('s', 'u'), /JSON/);
  assert.equal(attempts, 2);
  for (const properties of [
    { LLM_PROVIDER: 'typo' },
    { OPENAI_API_KEY: 'test-key', OPENAI_REASONING_EFFORT: 'none' },
  ]) {
    const isolated = sandbox(properties);
    assert.throws(() => isolated.context.askAI('s', 'u'), /不正/);
    assert.equal(isolated.calls.http.length, 0);
  }
});

const themes = [
  { theme: '通勤', category: 'evergreen', weight: 2, hits: 3, misses: 1 },
  { theme: '休止中', category: 'evergreen', weight: 0 },
  { theme: '乗り継ぎ', category: 'neta', weight: 1, last_used: '2026-09-09', notes: '体験談' },
];
const valid = { themes: [
  { theme: '通勤', angle: '朝の時短を体験から聞く', reason: '具体的に話せる' },
  { theme: '乗り継ぎ', angle: '失敗と対策を聞く', reason: '本人メモとの一致' },
] };

test('Astra selects active candidates with history and sends angles to script generation', () => {
  const { context, calls } = sandbox({ OPENAI_API_KEY: 'test-key', SCRIPT_INSIGHTS: '冒頭を短く' });
  context.readTable = () => structuredClone(themes);
  let input;
  context.askAIJson = (system, user) => { input = JSON.parse(user); return structuredClone(valid); };
  const picked = context.pickThemesForShoot();
  assert.equal(picked.length, 2);
  assert.equal(JSON.stringify(input).includes('休止中'), false);
  assert.equal(input.candidates[0].hits, 3);
  assert.equal(input.script_insights, '冒頭を短く');
  assert.equal(input.notes[0], '出張の乗り継ぎで失敗した');
  assert.deepEqual(calls.writes.map(call => call[2]), ['通勤', '乗り継ぎ']);
  assert.equal(picked[1].category, 'neta');
  assert.match(picked[1].notes, /失敗と対策/);
  assert.equal(calls.logs[0][0], 'theme_ai_selection');
  let scriptPrompt;
  context.runEditorialRoom = () => ({ discussion: { perspectives: [], resolution: '会議済み' }, review: {
    critique: '批評済み', rejected: [], selected: picked.map((t, i) => ({ pitch: {
      id: 'p' + (i + 1), ...t, title: '企画' + i, audience: '開発者', discovery: '比較の条件',
      recruiting_connection: 'この比較を検証する仕事', evidence_needed: '[本人確認:比較例]',
    }, reason: '具体的な比較', revision: '条件を見せる', novelty: 4, specificity: 4, recruiting: 4 })),
  } });
  context.askAI = (system, user) => {
    scriptPrompt = user;
    return JSON.stringify(picked.map((theme, i) => ({
      pitch_id: 'p' + (i + 1), theme: theme.theme, category: theme.category, question: '何を変えた？' + i,
      format: 'decision', viewer_value: '判断基準が分かる', opening: '選択を一言で',
      beats: ['選択', '理由', '次に使う場面'], follow_up: '何と比べた？', neta: '',
      closing: '冒頭の判断基準を一言で回収する', visual: '',
    })));
  };
  context.generateShootQuestions(picked, 2, []);
  assert.match(scriptPrompt, /朝の時短を体験から聞く/);
});

test('hallucinated, suspended, duplicate and incomplete theme selections do not write', () => {
  for (const selections of [
    [valid.themes[0]],
    [{ ...valid.themes[0], theme: '捏造テーマ' }, valid.themes[1]],
    [{ ...valid.themes[0], theme: '休止中' }, valid.themes[1]],
    [valid.themes[0], valid.themes[0]],
    [{ ...valid.themes[0], angle: '' }, valid.themes[1]],
  ]) {
    const { context, calls } = sandbox({ OPENAI_API_KEY: 'test-key' });
    context.readTable = () => structuredClone(themes);
    context.askAIJson = () => ({ themes: selections });
    assert.throws(() => context.pickThemesForShoot(), /AIテーマ選定/);
    assert.equal(calls.writes.length, 0);
  }
});

test('recruiting selection can choose two evergreen themes without forcing a neta slot', () => {
  const { context } = sandbox({ OPENAI_API_KEY: 'test-key', SCRIPT_AUDIENCE: '制御エンジニア', RECRUITING_CONTEXT: '公開可能な制御の検証課題' });
  context.readTable = () => [...structuredClone(themes), { theme: '制御の検証', category: 'evergreen', weight: 1 }];
  context.askAIJson = (system, user) => {
    const input = JSON.parse(user);
    assert.equal(input.count, 2);
    assert.equal(input.recruiting.audience, '制御エンジニア');
    assert.equal(input.recruiting.context, '公開可能な制御の検証課題');
    assert.equal(input.candidates.some(t => t.theme === '休止中'), false);
    return { themes: [valid.themes[0], { theme: '制御の検証', angle: 'モデルと実機で判断が変わる条件', reason: '対象職種の課題' }] };
  };
  const selected = context.pickThemesForShoot();
  assert.equal(selected.every(t => t.category === 'evergreen'), true);
});

test('all suspended themes fail without an API request', () => {
  const { context, calls } = sandbox({ OPENAI_API_KEY: 'test-key' });
  context.readTable = () => [{ theme: '休止中', category: 'evergreen', weight: 0 }];
  assert.throws(() => context.pickThemesForShoot(), /選定可能/);
  assert.equal(calls.http.length, 0);
  assert.equal(calls.writes.length, 0);
});

test('a one-question session selects one theme even with several active candidates', () => {
  const { context } = sandbox({ OPENAI_API_KEY: 'test-key' });
  context.readTable = () => structuredClone(themes);
  context.askAIJson = (system, user) => {
    assert.equal(JSON.parse(user).count, 1);
    return { themes: [valid.themes[0]] };
  };
  assert.equal(context.pickThemesForShoot(1).length, 1);
});

test('OpenAI key export still requires both admin token and explicit export permission', () => {
  const properties = { OPENAI_API_KEY: 'test-key', ADMIN_TOKEN: 'test-admin', OPENAI_MODEL: 'gpt-6-astra' };
  const { context } = sandbox(properties);
  const get = token => JSON.parse(context.doGet({ parameter: { action: 'env', token } }).text);
  assert.equal(get('wrong').error, 'unauthorized');
  assert.equal(get('test-admin').ok, false);
  assert.equal(JSON.stringify(get('test-admin')).includes('test-key'), false);
  properties.ALLOW_ENV_EXPORT = 'true';
  const exported = get('test-admin');
  assert.equal(exported.env.OPENAI_API_KEY, 'test-key');
  assert.equal(exported.env.OPENAI_MODEL, 'gpt-6-astra');
  assert.equal('ADMIN_TOKEN' in exported.env, false);
  assert.equal('ALLOW_ENV_EXPORT' in exported.env, false);
});
