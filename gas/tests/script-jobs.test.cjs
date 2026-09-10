const assert = require('node:assert/strict');
const { test } = require('node:test');
const { sandbox, themes, responseFor } = require('./editorial-fixtures.cjs');

function current(context) { return context.readShootJobs()[0]; }
function toStage(context, stage) {
  for (let i = 0; i < 12; i++) {
    const job = current(context);
    if (job.stage === stage) return job;
    assert.equal(job.status, 'queued');
    context.runShootScriptJobs();
  }
  throw new Error('Did not reach ' + stage);
}
function admin(context) {
  const original = context.getProp;
  context.getProp = (key, fallback) => key === 'ADMIN_TOKEN' ? 'test-admin' : original(key, fallback);
}

test('enqueue is quick, registers one worker, and deduplicates pending extra and daily requests', () => {
  const { context, calls } = sandbox();
  const first = context.startExtraShootScript();
  assert.equal(calls.ai.length, 0);
  assert.equal(calls.writes.length, 0);
  assert.equal(calls.slack.length, 0);
  assert.match(calls.notifications[0], /受け付けました/);
  assert.equal(context.startExtraShootScript().job_id, first.job_id);
  assert.equal(calls.tables.ScriptJobs.length, 1);
  const daily = context.startShootScript('sv', '朝');
  assert.equal(context.startShootScript('sv', '朝').job_id, daily.job_id);
  assert.equal(calls.tables.ScriptJobs.length, 2);
  assert.deepEqual(calls.triggers, ['runShootScriptJobs']);
});

test('four stages exceed four minutes and survive fresh runtimes without repeating completed work', () => {
  let runtime = sandbox();
  runtime.context.startShootScript('svx', 'test');
  const tables = runtime.calls.tables;
  let now = 1000;
  const records = [];
  for (const expected of ['themes', 'discussion', 'review', 'writing']) {
    runtime = sandbox([], tables); // no shared JavaScript memory, only persisted sheet rows
    const { context, calls } = runtime;
    context.Date = { now: () => now };
    assert.equal(current(context).stage, expected);
    let requests = 0;
    context.pickThemesForShoot = (count, singleAttempt) => {
      assert.equal(count, 2); assert.equal(singleAttempt, true);
      requests++; now += 80000; return structuredClone(themes);
    };
    context.askAI = (system, user) => {
      requests++; records.push({ system, user: JSON.parse(user) }); now += 80000;
      return JSON.stringify(responseFor(system));
    };
    context.runShootScriptJobs();
    assert.equal(requests, 1);
    assert.equal(current(context).status, 'queued');
    assert.equal(calls.slack.length, 0);
    const log = calls.logs.find(([event]) => event === 'script_stage_done')[1];
    assert.equal(log.stage, expected);
    assert.equal(log.elapsed_ms, 80000);
  }
  assert.ok(now > 240000);
  assert.equal(records.length, 3);
  assert.deepEqual(records[1].user.discussion, records[2].user.editorial.discussion);
  runtime.context.drainShootJobs();
  assert.equal(current(runtime.context).status, 'done');
  assert.equal(tables.Scripts.length, 1);
  assert.equal(tables.Questions.length, 2);
  assert.equal(runtime.calls.slack.length, 5);
});

test('overlapping ticks cannot duplicate an AI request or claim another job', () => {
  const { context, calls } = sandbox();
  context.startShootScript('svx', 'extra');
  context.startShootScript('sv', 'daily');
  context.runShootScriptJobs();
  context.askAI = system => {
    context.runShootScriptJobs();
    calls.ai.push(system);
    return JSON.stringify(responseFor(system));
  };
  context.runShootScriptJobs();
  assert.equal(calls.ai.length, 1);
  assert.equal(current(context).stage, 'review');
  assert.equal(context.readShootJobs()[1].stage, 'themes');
});

test('failed review preserves discussion and resumes only the failed stage', () => {
  const { context, calls } = sandbox();
  context.startShootScript('svx', 'test');
  const before = JSON.parse(JSON.stringify(toStage(context, 'review').data.discussion));
  const api = context.askAI;
  context.askAI = () => { throw new Error('PRIVATE_RESPONSE_BODY'); };
  context.runShootScriptJobs();
  assert.equal(current(context).status, 'failed');
  assert.equal(current(context).stage, 'review');
  assert.equal(calls.writes.length, 0);
  assert.equal(calls.slack.length, 0);
  assert.equal(calls.notifications.length, 1);
  assert.doesNotMatch(JSON.stringify(calls.logs) + JSON.stringify(current(context)) + calls.notifications[0], /PRIVATE_RESPONSE_BODY/);
  context.runShootScriptJobs();
  assert.equal(calls.notifications.length, 1);
  context.askAI = api;
  context.resumeShootScriptJob(current(context).job_id);
  context.runShootScriptJobs();
  assert.deepEqual(JSON.parse(JSON.stringify(current(context).data.discussion)), before);
  assert.equal(current(context).stage, 'writing');
  assert.equal(calls.ai.filter(c => c.system.includes('editorial_discussion')).length, 1);
});

test('writing repair happens in a later tick only once, with the same accepted pitches', () => {
  const { context, calls } = sandbox();
  context.startShootScript('svx', 'test');
  const review = JSON.stringify(toStage(context, 'writing').data.review);
  let requests = 0;
  context.askAI = () => { requests++; return '[]'; };
  context.runShootScriptJobs();
  assert.equal(requests, 1);
  assert.equal(current(context).stage, 'writing_repair');
  assert.equal(current(context).status, 'queued');
  assert.match(current(context).data.correction, /質問数/);
  assert.equal(JSON.stringify(current(context).data.review), review);
  context.runShootScriptJobs();
  assert.equal(requests, 2);
  assert.equal(current(context).status, 'failed');
  context.runShootScriptJobs();
  assert.equal(requests, 2);
  assert.equal(calls.slack.length, 0);
  assert.equal(calls.writes.length, 0);
  assert.throws(() => context.parseShootJobJson('PRIVATE_MODEL_OUTPUT'), error => !error.message.includes('PRIVATE_MODEL_OUTPUT'));
});

test('theme JSON repair uses another tick; HTTP errors do not automatically retry', () => {
  const { context } = sandbox();
  context.startShootScript('svx', 'test');
  let requests = 0;
  context.pickThemesForShoot = () => { requests++; throw new Error('AIテーマ選定のJSON形式が不正です'); };
  context.runShootScriptJobs();
  assert.equal(current(context).stage, 'themes_repair');
  assert.equal(requests, 1);
  context.runShootScriptJobs();
  assert.equal(requests, 2);
  assert.equal(current(context).status, 'failed');
  context.resumeShootScriptJob(current(context).job_id);
  context.pickThemesForShoot = () => { requests++; throw new Error('HTTP 503'); };
  context.runShootScriptJobs();
  assert.equal(current(context).status, 'failed');
  context.runShootScriptJobs();
  assert.equal(requests, 3);
});

test('hard interruption is detected after the lease and stale owners cannot overwrite resumed work', () => {
  const { context, calls } = sandbox();
  context.startShootScript('svx', 'test');
  const old = toStage(context, 'review');
  old.status = 'running'; old.started_ms = 1000; old.attempt++;
  context.withShootJobLock(() => context.writeShootJob(old));
  context.Date = { now: () => 1000 + context.SHOOT_JOB_LEASE_MS + 1 };
  context.runShootScriptJobs();
  assert.equal(current(context).status, 'failed');
  assert.equal(calls.logs.find(([event]) => event === 'script_stage_interrupted')[1].elapsed_ms, context.SHOOT_JOB_LEASE_MS + 1);
  context.resumeShootScriptJob(old.job_id);
  context.runShootScriptJobs();
  assert.equal(current(context).stage, 'writing');
  assert.throws(() => context.checkpointShootJob(old), /実行権/);
  assert.equal(current(context).stage, 'writing');
});

test('checkpoint chunking preserves large Japanese text, emoji and formula-like boundaries', () => {
  const { context, calls } = sandbox();
  const job = context.startShootScript('svx', 'test');
  job.data.large = '🚀'.repeat(20000) + '=1+1' + '深い問い'.repeat(20000);
  context.withShootJobLock(() => context.writeShootJob(job));
  assert.equal(current(context).data.large, job.data.large);
  const chunks = Object.entries(calls.tables.ScriptJobs[0]).filter(([key, value]) => key.startsWith('payload_') && value).map(([, value]) => value);
  assert.ok(chunks.length > 3);
  chunks.forEach(chunk => { assert.ok(chunk.length <= 30005); assert.ok(chunk.startsWith('json:')); assert.equal(chunk.isWellFormed(), true); });
  job.data.large = '超'.repeat(240001);
  assert.throws(() => context.withShootJobLock(() => context.writeShootJob(job)), /保存容量/);
  assert.notEqual(current(context).data.large, job.data.large);
});

test('partial question persistence resumes without duplicate rows or a second parent post', () => {
  const { context, calls } = sandbox();
  context.startShootScript('svx', 'test');
  toStage(context, 'parent');
  const append = context.appendRowObj;
  let failed = false;
  context.appendRowObj = (sheet, obj) => {
    append(sheet, obj);
    if (sheet === 'Questions' && !failed) { failed = true; throw new Error('Connection lost after append'); }
  };
  context.runShootScriptJobs();
  assert.equal(current(context).status, 'failed');
  assert.equal(calls.tables.Questions.length, 1);
  context.resumeShootScriptJob(current(context).job_id);
  context.drainShootJobs();
  assert.equal(current(context).status, 'done');
  assert.equal(calls.tables.Questions.length, 2);
  assert.equal(calls.tables.Scripts.length, 1);
  assert.equal(calls.slack.filter(([, thread]) => !thread).length, 1);
});

test('parent ACK persists the next stage even when the final stage checkpoint fails', () => {
  const { context, calls } = sandbox();
  context.startShootScript('svx', 'test');
  toStage(context, 'parent');
  const checkpoint = context.checkpointShootJob;
  let saves = 0;
  context.checkpointShootJob = job => { if (++saves === 3) throw new Error('Final save failed'); return checkpoint(job); };
  context.runShootScriptJobs();
  assert.equal(current(context).status, 'failed');
  assert.equal(current(context).stage, 'delivery');
  context.resumeShootScriptJob(current(context).job_id);
  context.drainShootJobs();
  assert.equal(calls.slack.filter(([, thread]) => !thread).length, 1);
});

test('unknown parent delivery never auto-resends; verified ACK can continue without duplication', () => {
  const { context, calls } = sandbox(); admin(context);
  context.startShootScript('svx', 'test');
  toStage(context, 'parent');
  const send = context.sendSlack;
  context.sendSlack = (...args) => { send(...args); throw new Error('Lost HTTP response'); };
  context.runShootScriptJobs();
  assert.equal(current(context).status, 'needs_review');
  assert.equal(current(context).data.sending, -1);
  context.runShootScriptJobs();
  assert.equal(calls.slack.length, 1);
  assert.throws(() => context.resumeShootScriptJob(current(context).job_id), /確認/);
  assert.throws(() => context.resolveShootScriptDelivery(current(context).job_id, '123.456', 'wrong'), /unauthorized/);
  context.resolveShootScriptDelivery(current(context).job_id, '123.456', 'test-admin');
  context.sendSlack = send;
  context.drainShootJobs();
  assert.equal(current(context).status, 'done');
  assert.equal(calls.slack.length, 5);
  assert.equal(calls.slack.filter(([, thread]) => !thread).length, 1);
});

test('an ACK followed by checkpoint failure requires confirmation before advancing or retrying', () => {
  const { context, calls } = sandbox(); admin(context);
  context.startShootScript('svx', 'test');
  toStage(context, 'delivery');
  const checkpoint = context.checkpointShootJob;
  let saves = 0;
  context.checkpointShootJob = job => { if (++saves === 2) throw new Error('Save failed after ACK'); return checkpoint(job); };
  context.runShootScriptJobs();
  assert.equal(current(context).status, 'needs_review');
  assert.equal(current(context).data.sending, 0);
  assert.equal(calls.slack.length, 2);
  context.resolveShootScriptDelivery(current(context).job_id, '123.456', 'test-admin');
  context.drainShootJobs();
  assert.equal(calls.slack.length, 5);
  assert.equal(current(context).status, 'done');
});

test('confirmed non-delivery permits explicit retry, and a lost worker with a send marker stays blocked', () => {
  const { context, calls } = sandbox(); admin(context);
  context.startShootScript('svx', 'test');
  const job = toStage(context, 'parent');
  job.status = 'running'; job.started_ms = 1000; job.data.sending = -1;
  context.withShootJobLock(() => context.writeShootJob(job));
  context.Date = { now: () => 1000 + context.SHOOT_JOB_LEASE_MS + 1 };
  context.runShootScriptJobs();
  assert.equal(current(context).status, 'needs_review');
  assert.equal(calls.slack.length, 0);
  context.resolveShootScriptDelivery(job.job_id, 'not_sent', 'test-admin');
  context.drainShootJobs();
  assert.equal(current(context).status, 'done');
  assert.equal(calls.slack.length, 5);
});

test('failed final completion checkpoint retains enough state to finish without sending again', () => {
  const { context, calls } = sandbox();
  context.startShootScript('svx', 'test');
  toStage(context, 'delivery');
  const write = context.writeShootJob;
  let failed = false;
  context.writeShootJob = job => {
    if (job.status === 'done' && !failed) { failed = true; throw new Error('Final checkpoint failed'); }
    return write(job);
  };
  context.runShootScriptJobs();
  assert.equal(current(context).status, 'failed');
  assert.equal(current(context).next_message, 4);
  assert.equal(current(context).data.messages.length, 4);
  assert.equal(calls.slack.length, 5);
  context.resumeShootScriptJob(current(context).job_id);
  context.drainShootJobs();
  assert.equal(current(context).status, 'done');
  assert.equal(current(context).data.messages, undefined);
  assert.equal(calls.slack.length, 5);
});

test('invalid editorial output stops the worker before later phases and preserves saved input', () => {
  for (const stage of ['discussion', 'review']) {
    const { context, calls } = sandbox();
    context.startShootScript('svx', 'test');
    const before = JSON.stringify(toStage(context, stage).data.input);
    let requests = 0;
    context.askAI = () => { requests++; return '{}'; };
    context.runShootScriptJobs();
    assert.equal(current(context).stage, stage);
    assert.equal(current(context).status, 'failed');
    assert.equal(JSON.stringify(current(context).data.input), before);
    context.runShootScriptJobs();
    assert.equal(requests, 1);
    assert.equal(calls.writes.length, 0);
    assert.equal(calls.slack.length, 0);
  }
});
