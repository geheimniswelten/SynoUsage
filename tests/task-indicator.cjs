const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function makeIndicator(status) {
  const source = fs.readFileSync(path.join(__dirname, '../ui/app.js'), 'utf8');
  const start = source.indexOf('  async function taskStatus() {');
  const end = source.indexOf('  async function taskAction(', start);
  assert.ok(start >= 0 && end > start);
  const nodes = new Map();
  const $ = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, {hidden: true, disabled: false, dataset: {}, textContent: '', value: ''});
    return nodes.get(selector);
  };
  const sandbox = {$, isPreview: false, window: {SynoUsageDSM: {status, taskScript: () => 'script'}}};
  vm.runInNewContext('let taskStatusRequest = 0;\n' + source.slice(start, end) + '\nthis.check = taskStatus;', sandbox);
  return {check: sandbox.check, nodes, $};
}

test('outdated task is indicated in the header and cleared when current', async () => {
  let state = 'outdated';
  const ui = makeIndicator(async () => ({state, message: state}));
  await ui.check();
  assert.equal(ui.$('#task-update-hint').hidden, false);
  assert.equal(ui.$('#task-update').hidden, false);
  state = 'ready';
  await ui.check();
  assert.equal(ui.$('#task-update-hint').hidden, true);
  assert.equal(ui.$('#task-update').hidden, true);
});

test('a stale background response cannot overwrite a newer task check', async () => {
  let finish;
  let count = 0;
  const ui = makeIndicator(() => ++count === 1
    ? new Promise(resolve => { finish = resolve; })
    : Promise.resolve({state: 'ready', message: 'ready'}));
  const first = ui.check();
  await ui.check();
  finish({state: 'outdated', message: 'old response'});
  await first;
  assert.equal(ui.$('#task-update-hint').hidden, true);
  assert.equal(ui.$('#task-status').textContent, 'ready');
});
