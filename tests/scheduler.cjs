const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../ui/dsm.js'), 'utf8');
const firstHash = 'a'.repeat(64);
const secondHash = 'b'.repeat(64);

function scheduler(options = {}) {
  const calls = [];
  const tasks = [];
  const location = {protocol: 'https:', origin: 'https://test-nas.invalid'};
  const window = {
    location, setTimeout, clearTimeout, SynoUsageBuild: {collectorSHA256: firstHash},
    parent: {location, SYNO: {API: {Request({method, version, params, callback}) {
      calls.push({method, version, params});
      if (options.rejectVersion === version && method === 'create') {
        callback(false, {code: 104});
        return;
      }
      switch (method) {
        case 'list':
          callback(true, {tasks: tasks.slice(params.offset, params.offset + params.limit), total: tasks.length});
          break;
        case 'get':
          callback(true, params.id === -1 ? {real_owner: 'nas-admin'} : tasks.find((task) => task.id === params.id));
          break;
        case 'create':
          tasks.push({...params, id: 41});
          callback(!options.loseResponse, options.loseResponse ? {} : {id: 41});
          break;
        case 'set': {
          const task = tasks.find((entry) => entry.id === params.id);
          Object.assign(task, params);
          callback(true, {});
          break;
        }
        case 'run':
          callback(true, {});
          break;
        default:
          throw new Error(method);
      }
    }}}},
  };
  vm.runInNewContext(source, {
    window, AbortSignal, structuredClone,
    fetch: async () => ({ok: true, json: async () => ({user: 'nas-admin'})}),
  });
  return {api: window.SynoUsageDSM, build: window.SynoUsageBuild, tasks, calls};
}

test('registers only if missing, remains inactive and can be run manually', async () => {
  const {api, tasks, calls} = scheduler({rejectVersion: 3});
  assert.equal((await api.status()).state, 'missing');
  await api.register();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].owner, 'root');
  assert.equal(tasks[0].enable, false);
  assert.match(tasks[0].extra.script, /sha256sum -c -/);
  assert.equal((await api.status()).state, 'ready');
  await assert.rejects(() => api.register(), /aktuell/);
  await api.start();
  assert.deepEqual(calls.at(-1), {
    method: 'run', version: 2, params: {tasks: [{id: 41, real_owner: 'nas-admin'}]},
  });
});

test('reconciles an ambiguous registration without a second mutation', async () => {
  const {api, calls, tasks} = scheduler({loseResponse: true});
  await api.register();
  assert.equal(tasks.length, 1);
  assert.equal(calls.filter((call) => call.method === 'create').length, 1);
  assert.equal((await api.status()).state, 'ready');
});

test('updates only the verified script and retains schedule and notification options', async () => {
  const {api, build, tasks} = scheduler();
  await api.register();
  const task = tasks[0];
  const schedule = {...task.schedule, date_type: 1, hour: 7, minute: 35, monthly_week: '[1]'};
  task.schedule = JSON.stringify(schedule);
  task.enable = true;
  task.extra = JSON.stringify({...task.extra, notify_enable: true, notify_if_error: true});
  build.collectorSHA256 = secondHash;
  assert.equal((await api.status()).state, 'outdated');
  await assert.rejects(() => api.start(), /andere[nr]? Paketversion/);
  await api.update();
  assert.equal(task.enable, true);
  assert.deepEqual(task.schedule, schedule);
  assert.equal(task.extra.notify_if_error, true);
  assert.ok(task.extra.script.includes(secondHash));
  assert.equal((await api.status()).state, 'ready');
});

test('keeps an unrelated task with the same name intact', async () => {
  const {api, calls, tasks} = scheduler();
  await api.register();
  tasks[0].extra.script += '\necho custom';
  assert.equal((await api.status()).state, 'conflict');
  for (const action of ['register', 'update', 'start']) {
    await assert.rejects(() => api[action]());
  }
  assert.equal(calls.filter((call) => ['create', 'set', 'run'].includes(call.method)).length, 1);
});
