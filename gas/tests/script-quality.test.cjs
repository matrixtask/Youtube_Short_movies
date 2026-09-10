const assert = require('node:assert/strict');
const { test } = require('node:test');
const { themes, question, valid, sandbox, responseFor } = require('./editorial-fixtures.cjs');

test('validated structure survives storage and appears in Slack using existing columns', () => {
  const { context, calls } = sandbox();
  context.startShootScript('sv', '今日の撮影台本');
  context.drainShootJobs();
  const questions = calls.writes.filter(([sheet]) => sheet === 'Questions').map(([, row]) => row);
  assert.equal(questions.length, 2);
  assert.deepEqual(Object.keys(questions[0]).sort(), ['script_id', 'idx', 'theme', 'category', 'question', 'neta', 'hint'].sort());
  assert.match(questions[0].hint, /見る人の持ち帰り:/);
  assert.match(questions[0].hint, /【読む】/);
  assert.match(questions[0].hint, /【ここから自分の考え・任意】/);
  assert.match(questions[0].hint, /【戻って読む】/);
  assert.match(questions[0].hint, /さらに考えたいときだけ（回答不要）:/);
  assert.equal(questions[0].neta, '');
  assert.match(calls.slack[1][0], /区間の所要時間を短くする案/);
  assert.equal(calls.slack.length, 5); // parent, two cards, two production memos
  assert.match(calls.slack[2][0], /^\*Q2\./);
  assert.match(calls.slack[3][0], /Q1\. 制作メモ/);
  assert.match(calls.slack[3][0], /所要時間を比べる基準/);
  assert.doesNotMatch(calls.slack[1][0], /持ち帰り:|対象:|本人確認|制作メモ|演出（任意）/);
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
  const writerInput = JSON.parse(calls.ai[2].user);
  assert.deepEqual(writerInput.recent_questions, input.recent_questions);
  assert.equal(writerInput.theme_insights, input.theme_insights);
  assert.equal(writerInput.script_insights, input.script_insights);
  assert.equal(writerInput.editorial.review.selected.length, 2);
});

test('stored cards keep complete spoken hypotheses separate from optional production guidance', () => {
  const { context } = sandbox();
  const raw = valid();
  raw[0].visual = '紙に図を描く';
  raw[0].neta = '<!channel> 演出は任意';
  // Simulate the existing sheet/API round trip with no additional columns.
  const rows = JSON.parse(JSON.stringify(context.validateShootQuestions(raw, themes, 2, [])));
  const messages = Array.from(context.shootQuestionMessages(rows));
  assert.equal(messages.length, 4);
  for (let i = 0; i < 2; i++) {
    const readLines = messages[i].split('\n').filter(line => line.startsWith('> ')).map(line => line.slice(2));
    const expected = [raw[i].opening, raw[i].premise,
      ...raw[i].hypotheses.flatMap(h => [h.statement, h.reason, h.weakness, h.reconsider]), raw[i].closing];
    assert.deepEqual(readLines, expected);
    assert.match(messages[i], /支持・反論・保留・別案/);
    assert.match(messages[i], /追加せず次へ進んでも完成/);
    assert.doesNotMatch(readLines.join('\n'), /※|本人確認|回答不要|紙に図|演出/);
    assert.ok(messages[i].length <= 3500);
    assert.match(messages[i + 2], /制作メモ（読み上げない）/);
    assert.ok(messages[i + 2].includes(raw[i].alternative));
  }
  assert.match(messages[2], /紙に図を描く/);
  assert.match(messages[2], /&lt;!channel&gt;/);
  assert.doesNotMatch(messages.join(''), /<!channel>/);
});

test('unfinished speech, missing reasoning, duplicate hypotheses and unmarked fiction are rejected', () => {
  const { context } = sandbox();
  for (const placeholder of ['[本人確認: 数値]', 'TBD', '____', '〇〇', '【読む】混入', '{回答}']) {
    for (const name of ['opening', 'premise', 'closing']) {
      const raw = valid(); raw[0][name] = placeholder;
      assert.throws(() => context.validateShootQuestions(raw, themes, 2, []), /穴埋め/);
    }
    for (const name of ['statement', 'reason', 'weakness', 'reconsider']) {
      const raw = valid(); raw[0].hypotheses[1][name] = placeholder;
      assert.throws(() => context.validateShootQuestions(raw, themes, 2, []), /穴埋め/);
    }
  }
  for (const name of ['statement', 'reason', 'weakness', 'reconsider']) {
    const raw = valid(); delete raw[0].hypotheses[0][name];
    assert.throws(() => context.validateShootQuestions(raw, themes, 2, []), new RegExp(name));
  }
  const duplicate = valid(); duplicate[0].hypotheses[1].statement = duplicate[0].hypotheses[0].statement;
  assert.throws(() => context.validateShootQuestions(duplicate, themes, 2, []), /仮説が重複/);
  const unmarked = valid(); unmarked[0].premise = '実際の会社の三拠点です。';
  assert.throws(() => context.validateShootQuestions(unmarked, themes, 2, []), /仮想設定/);
});

test('overlong speech fails and retries before any script is delivered', () => {
  const { context, calls } = sandbox();
  let attempts = 0;
  context.askAI = system => {
    if (!system.includes('STAGE: script_writing')) return JSON.stringify(responseFor(system));
    attempts++;
    const raw = valid();
    raw[0].hypotheses.forEach(h => { for (const k of Object.keys(h)) h[k] += '長'.repeat(65); });
    return JSON.stringify(raw);
  };
  assert.throws(() => context.generateShootQuestions(themes, 2, []), /650字/);
  assert.equal(attempts, 2);
  assert.equal(calls.writes.length, 0);
  assert.equal(calls.slack.length, 0);
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
    [question({ hypotheses: ['one'] }), valid()[1]],
    [question({ hypotheses: [null, null] }), valid()[1]],
    [question({ premise: '' }), valid()[1]],
    [question({ alternative: '' }), valid()[1]],
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
    if (!system.includes('STAGE: script_writing')) return JSON.stringify(responseFor(system));
    attempts++;
    if (attempts === 1) return '[]';
    assert.match(user, /質問数/);
    return JSON.stringify(valid());
  };
  assert.equal(context.generateShootQuestions(themes, 2, []).length, 2);
  assert.equal(attempts, 2);
  attempts = 0;
  context.askAI = system => {
    if (!system.includes('STAGE: script_writing')) return JSON.stringify(responseFor(system));
    attempts++; return '[]';
  };
  assert.throws(() => context.generateShootQuestions(themes, 2, []), /品質検証/);
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

test('Slack message splitting respects question boundaries and escaped character limits', () => {
  const { context } = sandbox();
  const questions = [
    { question: '比較する条件は？', hint: '&'.repeat(400) },
    { question: '次は何を測る？', hint: '<'.repeat(500) },
  ];
  const messages = context.shootQuestionMessages(questions);
  assert.equal(messages.length, 2);
  messages.forEach(message => assert.ok(message.length <= 3500));
  assert.equal(messages[0], context.formatShootQuestion(questions[0], 0));
  assert.equal(messages[1], context.formatShootQuestion(questions[1], 1));
  const short = [{ question: '一問目', hint: '短い補足' }, { question: '二問目', hint: '次の補足' }];
  assert.deepEqual(Array.from(context.shootQuestionMessages(short)), short.map(context.formatShootQuestion));
});

test('a long escaped question splits without losing text, HTML entities or emoji', () => {
  const { context } = sandbox();
  const question = { question: '長い比較の例', hint: 'A&🚀<>'.repeat(1500) };
  const messages = context.shootQuestionMessages([question]);
  assert.ok(messages.length > 2);
  assert.equal(messages.join(''), context.formatShootQuestion(question, 0));
  for (const message of messages) {
    assert.ok(message.length <= 3500);
    assert.equal(message.isWellFormed(), true);
    assert.doesNotMatch(message, /&(?!(?:amp|lt|gt);)/);
  }
});

test('all split script messages are sent to the same parent thread', () => {
  const { context, calls } = sandbox();
  const generated = valid().map(q => ({ ...q, hint: '比較&🚀'.repeat(600) }));
  const job = context.startShootScript('sv', '今日の台本');
  job.stage = 'parent';
  Object.assign(job.data, { questions: generated, input: { themes }, intro: '今日の台本', messages: context.shootQuestionMessages(generated) });
  context.withShootJobLock(() => context.writeShootJob(job));
  context.drainShootJobs();
  const expected = Array.from(context.shootQuestionMessages(generated));
  assert.ok(expected.length > 1);
  assert.equal(calls.slack.length, expected.length + 1);
  assert.deepEqual(calls.slack.slice(1).map(([message]) => message), expected);
  assert.ok(calls.slack.slice(1).every(([message, thread]) => message.length <= 3500 && thread === '123.456'));
  assert.deepEqual(calls.delivery, Array.from({ length: expected.length + 1 }).flatMap(() => [['sleep', 1000], ['send']]));
  assert.equal(calls.writes.filter(([sheet]) => sheet === 'Questions').length, 2);
});

test('enqueue failure reports a fixed notice once without exposing error content or storing questions', () => {
  const notices = [];
  for (const detail of ['HTTP 401 PRIVATE_API_BODY', 'MODEL_OUTPUT_DO_NOT_PUBLISH']) {
    const { context, calls } = sandbox();
    const failure = new Error(detail);
    context.enqueueShootScript = () => { throw failure; };
    assert.throws(() => context.startExtraShootScript(), error => error === failure);
    assert.equal(calls.notifications.length, 1);
    assert.doesNotMatch(calls.notifications[0], /PRIVATE_API_BODY|MODEL_OUTPUT_DO_NOT_PUBLISH|401/);
    assert.match(calls.notifications[0], /台本の作成・送信を完了できませんでした/);
    assert.equal(calls.writes.length, 0);
    assert.equal(calls.slack.length, 0);
    notices.push(calls.notifications[0]);
  }
  assert.equal(notices[0], notices[1]);
});

test('one requested question selects only one theme and reaches generation with that count', () => {
  const { context } = sandbox();
  let pickedCount;
  context.getProp = (key, fallback) => key === 'SHOOT_QUESTIONS' ? '1' : fallback;
  context.pickThemesForShoot = count => { pickedCount = count; return [themes[0]]; };
  context.startShootScript('sv', '一問');
  context.runShootScriptJobs();
  const input = context.readShootJobs()[0].data.input;
  assert.equal(input.count, 1);
  assert.deepEqual(Array.from(input.themes, t => ({ ...t })), [themes[0]]);
  assert.equal(pickedCount, 1);
});

test('invalid configured question counts stop before theme selection or AI', () => {
  for (const count of ['0', '-1', '1.5', '11', 'invalid', '']) {
    const { context, calls } = sandbox();
    let selections = 0;
    context.getProp = (key, fallback) => key === 'SHOOT_QUESTIONS' ? count : fallback;
    context.pickThemesForShoot = () => { selections++; return themes; };
    assert.throws(() => context.startShootScript('sv', 'test'), /SHOOT_QUESTIONS/);
    assert.equal(selections, 0);
    assert.equal(calls.ai.length, 0);
    assert.equal(calls.writes.length, 0);
    assert.equal(calls.slack.length, 0);
  }
});
