const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../ui/dsm.js'), 'utf8');
const firstHash = 'a'.repeat(64);
const secondHash = 'b'.repeat(64);

function legacyTaskScript(tempRoot = '/var/lib') {
  const collector = '/var/packages/h5uSynoUsage/target/bin/synousage';
  return [
    '# SynoUsage Collector v1',
    'set -eu',
    'export PATH=/usr/syno/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    'umask 077',
    'work=$(mktemp -d ' + tempRoot + '/synousage.XXXXXXXXXX)',
    'trap \'rm -f -- "$work/synousage"; rmdir -- "$work"\' 0',
    "trap 'exit 1' HUP INT TERM",
    "[ -f '" + collector + "' ]",
    "head -c 16777216 '" + collector + "' > " + '"$work/synousage"',
    "printf '%s  %s\\n' '" + firstHash + "' " + '"$work/synousage" | sha256sum -c -',
    'chmod 0700 "$work/synousage"',
    '"$work/synousage" collect',
  ].join('\n');
}

const taskAPI = 'SYNO.Core.TaskScheduler';
const rootTaskAPI = 'SYNO.Core.TaskScheduler.Root';
const passwordAPI = 'SYNO.Core.User.PasswordConfirm';
const dialogClass = 'SYNO.SDS.Utils.PasswordConfirmDialog';

function scheduler(options = {}) {
  const calls = [];
  const tasks = [];
  const dialogs = [];
  const loaded = [];
  const catalogs = [];
  const location = {protocol: 'https:', origin: 'https://test-nas.invalid'};
  const catalog = {
    [rootTaskAPI]: {minVersion: 1, maxVersion: 4},
    [passwordAPI]: {minVersion: 1, maxVersion: 2},
  };
  const owner = {_S: (key) => key === 'majorversion' ? '7' : options.protectedTask ? '2' : '1'};
  class PasswordConfirmDialog {
    constructor(config) {
      this.config = config;
      this.listeners = {};
    }
    on(event, callback) {
      this.listeners[event] = callback;
    }
    open() {
      assert.equal(this.config.owner, owner);
      assert.equal(this.config.module, owner);
      dialogs.push(this);
      options.onConfirm?.(tasks);
      if (options.cancel === 'button') this.config.cancelCallback();
      this.listeners.close?.();
      this.listeners.destroy?.();
      if (!options.cancel) this.config.callback({SynoConfirmPWToken: 'confirmation-token'});
    }
  }
  const sds = {
    Session: {SynoToken: 'session-token'},
    AppMgr: {getByAppName(name) {
      assert.equal(name, 'SYNO.SDS.h5uSynoUsage.Application');
      return [{window: owner}];
    }},
    Utils: {},
    async JSLoadPromise(name) {
      loaded.push(name);
      if (options.dialogUnavailable) throw new Error('Module unavailable');
      this.Utils.PasswordConfirmDialog = PasswordConfirmDialog;
    },
  };
  const window = {
    location,
    setTimeout,
    clearTimeout,
    SynoUsageBuild: {collectorSHA256: firstHash},
    parent: {location, SYNO: {SDS: sds, API: {
      GetKnownAPI: options.catalogOnly ? undefined : (api) => catalog[api],
      Request({api, method, version, params, callback}) {
        calls.push({api, method, version, params});
        const {SynoConfirmPWToken: token, ...taskParams} = params;
        if (['create', 'set'].includes(method)) {
          if (options.protectedTask) {
            assert.equal(api, rootTaskAPI);
            assert.equal(version, 4);
            assert.equal(token, 'confirmation-token');
          } else {
            assert.equal(api, taskAPI);
            assert.equal(token, undefined);
          }
          if (options.rejectProtected && options.protectedTask) {
            callback(false, {code: 4008});
            return;
          }
          if (options.rejectVersion === version && method === 'create') {
            callback(false, {code: 104});
            return;
          }
        } else {
          assert.equal(api, taskAPI);
          assert.equal(token, undefined);
        }
        switch (method) {
          case 'list':
            callback(true, {tasks: tasks.slice(params.offset, params.offset + params.limit), total: tasks.length});
            break;
          case 'get':
            callback(true, params.id === -1 ? {real_owner: 'nas-admin'} : tasks.find((task) => task.id === params.id));
            break;
          case 'create':
            tasks.push({...taskParams, id: 41});
            callback(!options.loseResponse, options.loseResponse ? {} : {id: 41});
            break;
          case 'set': {
            const task = tasks.find((entry) => entry.id === params.id);
            Object.assign(task, taskParams);
            callback(true, {});
            break;
          }
          case 'run':
            callback(true, {});
            break;
          default:
            throw new Error(method);
        }
      },
    }}},
  };
  vm.runInNewContext(source, {
    window, AbortSignal, structuredClone, URLSearchParams, queueMicrotask,
    fetch: async (url, init) => {
      if (url.startsWith('/webapi/entry.cgi?')) {
        catalogs.push(new URL(url, location.origin).searchParams.get('query'));
        return {ok: true, json: async () => ({success: true, data: catalog})};
      }
      assert.equal(init.headers['X-SYNO-TOKEN'], 'session-token');
      assert.equal(url, './api.cgi?view=status');
      return options.response || ({ok: true, json: async () => ({user: 'nas-admin'})});
    },
  });
  return {api: window.SynoUsageDSM, build: window.SynoUsageBuild, tasks, calls, dialogs, loaded, catalogs};
}

test('reports the actual CGI failure instead of claiming a missing administrator login', async () => {
  const {api, calls} = scheduler({response: {
    ok: false, status: 409, json: async () => ({error: 'SynoUsage im Paket-Zentrum starten'}),
  }});
  await assert.rejects(() => api.register(), /HTTP 409.*SynoUsage im Paket-Zentrum starten/);
  assert.equal(calls.some((call) => call.method === 'create'), false);
});

test('registers only if missing, remains inactive and can be run manually', async () => {
  const {api, tasks, calls} = scheduler({rejectVersion: 3});
  assert.equal((await api.status()).state, 'missing');
  await api.register();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].owner, 'root');
  assert.equal(tasks[0].enable, false);
  assert.match(tasks[0].extra.script, /exec \/bin\/sh "\$launcher" collect/);
  assert.equal((await api.status()).state, 'ready');
  assert.equal((await api.status()).scheduleEnabled, false);
  await assert.rejects(() => api.register(), /aktuell/);
  await api.start();
  assert.deepEqual(calls.at(-1), {
    api: taskAPI, method: 'run', version: 2, params: {tasks: [{id: 41, real_owner: 'nas-admin'}]},
  });
});

test('reports enabled and unknown task schedule states distinctly', async () => {
  const {api, tasks} = scheduler();
  await api.register();
  tasks[0].enable = true;
  assert.equal((await api.status()).scheduleEnabled, true);
  delete tasks[0].enable;
  const status = await api.status();
  assert.equal(status.scheduleEnabled, null);
  assert.match(status.schedule, /unbekannt/);
});

test('reconciles an ambiguous registration without a second mutation', async () => {
  const {api, calls, tasks} = scheduler({loseResponse: true});
  await api.register();
  assert.equal(tasks.length, 1);
  assert.equal(calls.filter((call) => call.method === 'create').length, 1);
  assert.equal((await api.status()).state, 'ready');
});

test('updates only the verified script and retains schedule and notification options', async () => {
  const {api, tasks} = scheduler();
  await api.register();
  const task = tasks[0];
  task.extra.script = legacyTaskScript();
  const schedule = {...task.schedule, date_type: 1, hour: 7, minute: 35, monthly_week: '[1]'};
  task.schedule = JSON.stringify(schedule);
  task.enable = true;
  task.extra = JSON.stringify({...task.extra, notify_enable: true, notify_if_error: true});
  assert.equal((await api.status()).state, 'outdated');
  await assert.rejects(() => api.start(), /frühere Erfassungsskript/);
  await api.update();
  assert.equal(task.enable, true);
  assert.deepEqual(task.schedule, schedule);
  assert.equal(task.extra.notify_if_error, true);
  assert.equal(task.extra.script, api.taskScript());
  assert.equal((await api.status()).state, 'ready');
});

test('recognizes and updates the old task that used a noexec /tmp', async () => {
  const {api, tasks} = scheduler();
  await api.register();
  tasks[0].extra.script = legacyTaskScript('/tmp');
  assert.equal((await api.status()).state, 'outdated');
  await api.update();
  assert.equal(tasks[0].extra.script, api.taskScript());
  assert.equal((await api.status()).state, 'ready');
});

test('a package update retains the registered launcher command', async () => {
  const {api, build, tasks, calls} = scheduler();
  await api.register();
  const command = tasks[0].extra.script;
  build.collectorSHA256 = secondHash;
  assert.equal(api.taskScript(), command);
  assert.equal((await api.status()).state, 'ready');
  await api.start();
  assert.equal(calls.filter((call) => call.method === 'set').length, 0);
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

test('DSM 7.2 confirms root writes in its own dialog and uses the Root API v4', async () => {
  const state = scheduler({protectedTask: true, catalogOnly: true, onConfirm(tasks) {
    if (tasks[0]) tasks[0].schedule.hour = 8;
  }});
  const {api, calls, tasks, dialogs, loaded, catalogs} = state;
  await api.register();
  assert.equal(calls.find((call) => call.method === 'get' && call.params.id === -1).version, 4);
  tasks[0].enable = true;
  tasks[0].extra.script = legacyTaskScript();
  await api.update();
  assert.equal(tasks[0].schedule.hour, 8);
  assert.equal(tasks[0].enable, true);
  assert.equal(await api.status().then((status) => status.state), 'ready');
  await api.start();
  assert.equal(dialogs.length, 2);
  assert.deepEqual(loaded, [dialogClass]);
  assert.deepEqual(catalogs, [rootTaskAPI + ',' + passwordAPI, rootTaskAPI + ',' + passwordAPI]);
  assert.deepEqual(calls.filter((call) => call.api === rootTaskAPI).map((call) => call.method), ['create', 'set']);
  assert.equal(calls.at(-1).api, taskAPI);
  assert.equal(calls.at(-1).method, 'run');
});

for (const cancel of ['button', 'close']) {
  test('closing the DSM confirmation with ' + cancel + ' skips the write', async () => {
    const {api, calls, tasks} = scheduler({protectedTask: true, cancel});
    const result = await api.register();
    assert.match(result.message, /abgebrochen/);
    assert.equal(tasks.length, 0);
    assert.equal(calls.some((call) => call.api === rootTaskAPI), false);
  });
}

test('a refused protected write is reported without a legacy retry', async () => {
  const {api, calls, tasks} = scheduler({protectedTask: true, rejectProtected: true});
  await assert.rejects(() => api.register(), /DSM 4008/);
  assert.equal(tasks.length, 0);
  assert.equal(calls.filter((call) => call.method === 'create').length, 1);
});

test('a missing native password dialog leaves the manual scheduler available', async () => {
  const {api, calls} = scheduler({protectedTask: true, dialogUnavailable: true});
  await assert.rejects(() => api.register(), /Aufgabe im DSM-Aufgabenplaner speichern/);
  assert.equal(calls.some((call) => call.method === 'create'), false);
});
