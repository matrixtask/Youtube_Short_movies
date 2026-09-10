const assert = require('node:assert/strict');
const { test } = require('node:test');
const { themes, valid, discussion, review, sandbox, responseFor } = require('./editorial-fixtures.cjs');

function checkedDiscussion(context) {
  return context.validateEditorialDiscussion(discussion(), themes, 4);
}

test('discussion, PR review and writing run in order with validated decisions passed forward', () => {
  const { context, calls } = sandbox();
  context.generateShootQuestions(themes, 2, ['確認する材料']);
  assert.equal(calls.ai.length, 3);
  const inputs = calls.ai.map(call => JSON.parse(call.user));
  assert.equal(inputs[0].pitch_count, 4);
  assert.equal(inputs[0].editorial, undefined);
  assert.equal(inputs[1].discussion.pitches.length, 4);
  assert.deepEqual(inputs[1].discussion.perspectives.map(p => p.role), ['rei', 'sebastian', 'hannibal']);
  assert.deepEqual(inputs[2].editorial.review.selected.map(s => s.pitch.id), ['p1', 'p2']);
  assert.equal(inputs[2].editorial.review.selected[0].revision, review().selected[0].revision);
  const audit = JSON.parse(calls.logs.find(([event]) => event === 'script_editorial')[1]);
  assert.deepEqual(audit.selected.map(s => s.id), ['p1', 'p2']);
  assert.deepEqual(audit.rejected.map(s => s.pitch_id), ['p3', 'p4']);
  assert.equal(audit.version, 'speaking-card-v2');
  assert.equal(audit.selected[0].depth, 5);
  assert.equal(audit.selected[0].speakability, 4);
  assert.equal(audit.selected[0].clarity, 4);
});

for (const failureStage of [0, 1]) {
  for (const failure of ['json', 'validation', 'api']) {
    test(`stage ${failureStage + 1} ${failure} failure stops subsequent stages and all delivery`, () => {
      const { context, calls } = sandbox();
      let requests = 0;
      context.askAI = system => {
        const current = requests++;
        if (current !== failureStage) return JSON.stringify(responseFor(system));
        if (failure === 'api') throw new Error('HTTP 429');
        return failure === 'json' ? 'not JSON' : '{}';
      };
      assert.throws(() => context.generateShootQuestions(themes, 2, []), failure === 'api' ? /429/ : /編集会議|広報批評/);
      assert.equal(requests, failureStage + 1);
      assert.equal(calls.writes.length, 0);
      assert.equal(calls.slack.length, 0);
    });
  }
}

test('discussion requires the three distinct known perspectives', () => {
  const { context } = sandbox();
  for (const roles of [['rei', 'sebastian'], ['rei', 'rei', 'hannibal'], ['rei', 'sebastian', 'legacy_persona'], ['rei', 'sebastian', 'unknown']]) {
    const raw = discussion();
    raw.perspectives = roles.map(role => ({ role, objection: '異論', revision: '修正' }));
    assert.throws(() => context.validateEditorialDiscussion(raw, themes, 4), /視点/);
  }
  const raw = discussion();
  raw.perspectives[0].objection = '';
  assert.throws(() => context.validateEditorialDiscussion(raw, themes, 4), /objection/);
});

test('discussion rejects malformed or duplicate pitch IDs and duplicate normalized titles', () => {
  const { context } = sandbox();
  for (const id of ['p1', 'unknown', 'p0', 'p1.5']) {
    const raw = discussion();
    raw.pitches[1].id = id;
    assert.throws(() => context.validateEditorialDiscussion(raw, themes, 4), /企画ID/);
  }
  const raw = discussion();
  raw.pitches[0].title = '開発 ＡＢＣ！？';
  raw.pitches[1].title = '開発abc?';
  assert.throws(() => context.validateEditorialDiscussion(raw, themes, 4), /企画名/);
});

test('discussion rejects wrong counts, unknown themes/categories and uncovered themes', () => {
  const { context } = sandbox();
  const variants = [
    raw => raw.pitches.pop(),
    raw => { raw.pitches[0].theme = '選定されていない'; },
    raw => { raw.pitches[0].category = 'news'; },
    raw => raw.pitches.forEach(p => Object.assign(p, themes[0])),
  ];
  for (const mutate of variants) {
    const raw = discussion(); mutate(raw);
    assert.throws(() => context.validateEditorialDiscussion(raw, themes, 4), /企画数|テーマ/);
  }
});

test('review requires every candidate to be selected or rejected exactly once', () => {
  const { context } = sandbox();
  const room = checkedDiscussion(context);
  const mutations = [
    raw => { raw.selected[0].pitch_id = 'p999'; },
    raw => { raw.selected[1].pitch_id = 'p1'; },
    raw => { raw.rejected[0].pitch_id = 'p999'; },
    raw => { raw.rejected[0].pitch_id = 'p1'; },
    raw => { raw.rejected[1].pitch_id = 'p3'; },
    raw => { raw.rejected.pop(); },
  ];
  for (const mutate of mutations) {
    const raw = review(); mutate(raw);
    assert.throws(() => context.validateEditorialReview(raw, room, themes, 2), /企画ID|未評価/);
  }
  assert.equal(context.validateEditorialReview(review(), room, themes, 2).rejected.length, 2);
});

test('review rejects insufficient quantity, missing themes and incomplete evaluation grounds', () => {
  const { context } = sandbox();
  const room = checkedDiscussion(context);
  const short = review(); short.selected.pop();
  assert.throws(() => context.validateEditorialReview(short, room, themes, 2), /不足/);
  const uncovered = review();
  uncovered.selected[1].pitch_id = 'p3';
  uncovered.rejected[0].pitch_id = 'p2';
  assert.throws(() => context.validateEditorialReview(uncovered, room, themes, 2), /含まれないテーマ/);
  for (const field of ['reason', 'revision']) {
    const raw = review(); raw.selected[0][field] = '';
    assert.throws(() => context.validateEditorialReview(raw, room, themes, 2), new RegExp(field));
  }
});

test('each quality axis must be an integer from four through five', () => {
  const { context } = sandbox();
  const room = checkedDiscussion(context);
  for (const axis of ['novelty', 'specificity', 'recruiting', 'depth', 'speakability', 'clarity']) {
    for (const value of [0, 3, 3.9, 4.5, 6, '4', null, undefined]) {
      const raw = review(); raw.selected[0][axis] = value;
      assert.throws(() => context.validateEditorialReview(raw, room, themes, 2), /品質基準/);
    }
  }
});

test('writer must use each approved pitch once without changing its theme', () => {
  const { context } = sandbox();
  const approved = context.validateEditorialReview(review(), checkedDiscussion(context), themes, 2);
  for (const id of ['p3', 'p999', undefined]) {
    const raw = valid(); raw[0].pitch_id = id;
    assert.throws(() => context.validateShootQuestions(raw, themes, 2, [], approved), /採用企画/);
  }
  const duplicate = valid(); duplicate[1].pitch_id = 'p1';
  Object.assign(duplicate[1], themes[0]);
  assert.throws(() => context.validateShootQuestions(duplicate, themes, 2, [], approved), /採用企画/);
  const swapped = valid(); Object.assign(swapped[0], themes[1]);
  assert.throws(() => context.validateShootQuestions(swapped, themes, 2, [], approved), /採用企画/);
  const result = context.validateShootQuestions(valid(), themes, 2, [], approved);
  assert.match(result[0].hint, /新しい発見:/);
  assert.match(result[0].hint, /仕事への接続:/);
  assert.match(result[0].hint, /本人確認/);
});

test('writer API failure is not retried and creates no partial delivery', () => {
  const { context, calls } = sandbox();
  let requests = 0;
  context.askAI = system => {
    requests++;
    if (requests === 3) throw new Error('HTTP 503');
    return JSON.stringify(responseFor(system));
  };
  assert.throws(() => context.generateShootQuestions(themes, 2, []), /503/);
  assert.equal(requests, 3);
  assert.equal(calls.writes.length, 0);
  assert.equal(calls.slack.length, 0);
});

test('writer repair preserves the accepted editorial decisions without rerunning the meeting', () => {
  const { context } = sandbox();
  const requests = [];
  context.askAI = (system, user) => {
    requests.push({ system, user });
    return JSON.stringify(requests.length === 3 ? [] : responseFor(system));
  };
  assert.equal(context.generateShootQuestions(themes, 2, []).length, 2);
  assert.equal(requests.length, 4);
  assert.equal(requests[3].system, requests[2].system);
  assert.ok(requests[3].user.startsWith(requests[2].user));
  assert.match(requests[3].user.slice(requests[2].user.length), /質問数/);
});

test('expired deadline prevents the first request', () => {
  const { context, calls } = sandbox();
  context.Date = { now: () => 1000 };
  assert.throws(() => context.generateShootQuestions(themes, 2, [], 999), /時間予算/);
  assert.equal(calls.ai.length, 0);
});

for (const expireAfter of [1, 2, 3]) {
  test(`deadline after request ${expireAfter} prevents the next stage or repair`, () => {
    const { context, calls } = sandbox();
    let now = 1000;
    let requests = 0;
    context.Date = { now: () => now };
    context.askAI = system => {
      requests++;
      if (requests === expireAfter) now = 241001;
      return JSON.stringify(requests === 3 ? [] : responseFor(system));
    };
    assert.throws(() => context.generateShootQuestions(themes, 2, []), /時間予算/);
    assert.equal(requests, expireAfter);
    assert.equal(calls.writes.length, 0);
    assert.equal(calls.slack.length, 0);
  });
}

for (const completedCalls of [0, 1, 2, 3]) {
  test(`less than thirty seconds remaining after ${completedCalls} calls prevents a new request`, () => {
    const { context, calls } = sandbox();
    let now = completedCalls === 0 ? 211001 : 1000;
    let requests = 0;
    context.Date = { now: () => now };
    context.askAI = system => {
      requests++;
      if (requests === completedCalls) now = 211001;
      return JSON.stringify(requests === 3 ? [] : responseFor(system));
    };
    assert.throws(() => context.generateShootQuestions(themes, 2, [], 241000), /時間予算/);
    assert.equal(requests, completedCalls);
    assert.equal(calls.writes.length, 0);
    assert.equal(calls.slack.length, 0);
  });
}

test('a successful writer response arriving past the deadline is never saved or delivered', () => {
  const { context, calls } = sandbox();
  let now = 1000;
  let requests = 0;
  context.Date = { now: () => now };
  context.askAI = system => {
    requests++;
    if (requests === 3) now = 241001;
    return JSON.stringify(responseFor(system));
  };
  assert.throws(() => context.generateShootQuestions(themes, 2, []), /時間予算/);
  assert.equal(requests, 3);
  assert.equal(calls.writes.length, 0);
  assert.equal(calls.slack.length, 0);
  assert.equal(calls.notifications.length, 0);
});
