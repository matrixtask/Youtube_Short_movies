const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// GAS services are stubbed: these tests never publish or send Slack messages.
function dashboard() {
  const rows = ['stock', 'approved', 'scheduled', 'published', 'rejected', 'failed']
    .flatMap(status => ['short', 'wide'].map(kind => ({
      short_id: status + '-' + kind,
      title: status + '-' + kind,
      status,
      kind,
      scheduled_at: status === 'scheduled' ? '2026-09-11 19:00:00' : '',
    })));
  rows.push({ short_id: 'legacy', title: 'legacy', status: 'stock', scheduled_at: '' });
  const before = structuredClone(rows);
  const calls = { reads: 0, writes: [], notifications: [], dispatches: [], logs: [] };
  const context = vm.createContext({
    readTable: () => { calls.reads++; return structuredClone(rows); },
    updateRowsWhere: (sheet, key, id, changes) => {
      calls.writes.push(id);
      rows.filter(row => row[key] === id).forEach(row => Object.assign(row, changes));
    },
    notifySlack: message => calls.notifications.push(message),
    triggerGithub: event => { calls.dispatches.push(event); return true; },
    logEvent: (...args) => calls.logs.push(args),
  });
  for (const file of ['Config.js', 'Dashboard.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), context);
  }
  // Replace Config.js service helpers after loading the real status definitions.
  context.getProp = key => key === 'ADMIN_TOKEN' ? 'test-token' : '';
  context.nowJst = () => new Date('2026-09-10T03:00:00Z');
  context.fmtDateTime = () => '2026-09-10 12:00:00';
  return { context, rows, before, calls };
}

function assertAction(action, target, expectedIds, newStatus) {
  const { context, rows, before, calls } = dashboard();
  context.dashShortAction('test-token', action, target);
  assert.deepEqual(calls.writes.slice().sort(), expectedIds.slice().sort());
  for (let i = 0; i < rows.length; i++) {
    const expected = { ...before[i] };
    if (expectedIds.includes(expected.short_id)) {
      expected.status = newStatus;
      if (action === 'reject') expected.scheduled_at = '';
      if (action === 'publish_now') expected.scheduled_at = '2026-09-10 12:00:00';
    }
    assert.deepEqual(rows[i], expected);
  }
  assert.equal(calls.notifications.length, expectedIds.length ? 1 : 0);
  assert.equal(calls.logs.length, expectedIds.length ? 1 : 0);
  assert.deepEqual(calls.dispatches,
    action === 'publish_now' && expectedIds.length ? ['publish-requested'] : []);
}

test('bulk rejection only rejects approval-waiting shorts', () => {
  assertAction('reject', 'all', ['stock-short', 'legacy'], 'rejected');
});

test('bulk immediate publishing only schedules the approved/reserved queue', () => {
  assertAction('publish_now', 'all', ['approved-short', 'scheduled-short'], 'scheduled');
});

test('bulk approval still supports legacy rows without kind', () => {
  assertAction('approve', 'all', ['stock-short', 'legacy'], 'approved');
});

for (const status of ['stock', 'approved', 'scheduled']) {
  test('individual rejection still supports ' + status, () => {
    assertAction('reject', status + '-short', [status + '-short'], 'rejected');
  });
  test('individual immediate publishing still supports ' + status, () => {
    assertAction('publish_now', status + '-short', [status + '-short'], 'scheduled');
  });
}

test('individual approval still approves stock', () => {
  assertAction('approve', 'stock-short', ['stock-short'], 'approved');
});

test('ineligible, wide and missing individual targets have no side effects', () => {
  for (const action of ['approve', 'reject', 'publish_now']) {
    for (const target of ['published-short', 'rejected-short', 'failed-short', 'stock-wide', 'missing']) {
      assertAction(action, target, [], '');
    }
  }
  assertAction('approve', 'scheduled-short', [], '');
});

test('an empty queue does not auto-approve stock or dispatch publishing', () => {
  const { context, rows, calls } = dashboard();
  rows.splice(0, rows.length, { short_id: 'only-stock', status: 'stock' });
  const before = structuredClone(rows);
  assert.equal(context.dashShortAction('test-token', 'publish_now', 'all'), '対象のショートがありません');
  assert.deepEqual(rows, before);
  assert.deepEqual(calls.writes, []);
  assert.deepEqual(calls.notifications, []);
  assert.deepEqual(calls.dispatches, []);
});

test('invalid tokens are rejected before reading or changing data', () => {
  for (const token of ['', 'wrong', undefined]) {
    const { context, rows, before, calls } = dashboard();
    assert.throws(() => context.dashShortAction(token, 'publish_now', 'all'), /unauthorized/);
    assert.deepEqual(rows, before);
    assert.deepEqual(calls, { reads: 0, writes: [], notifications: [], dispatches: [], logs: [] });
  }
});

test('unknown actions have no side effects', () => {
  assertAction('unknown', 'all', [], '');
});
