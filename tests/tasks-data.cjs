const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const window = {};
const context = vm.createContext({window});
for (const file of ['task-time.js', 'task-sources.js', 'task-data.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../ui', file), 'utf8'), context);
}
const {clock} = window.SynoUsageTaskTime;
const {load, addMeasurements} = window.SynoUsageTaskData;
const json = (value) => JSON.parse(JSON.stringify(value));
const at = (value) => Date.parse(value) / 1000;
const now = at('2026-11-11T18:09:00+01:00');
const taskName = 'SynoUsage Erfassung';
const tasks = [
  {id: 27, name: taskName, owner: 'root', type: 'script', enable: true, next_trigger_time: '2026-11-16 3:00'},
  {id: 6, name: 'Datensicherung', type: 'script', enable: false, next_trigger_time: '2026-11-12 7:00'},
  {id: 9, name: 'Startprotokoll', type: 'event', enable: true, next_trigger_time: 'bootup'},
];

test('interprets DSM wall times in the NAS zone across daylight saving changes', () => {
  const berlin = clock('Europe/Berlin');
  assert.equal(berlin.parse('2026-11-11 4:00'), at('2026-11-11T04:00:00+01:00'));
  assert.equal(berlin.parse('2026-03-29 02:30'), null);
  const first = at('2026-10-25T02:30:00+02:00');
  assert.equal(berlin.parse('2026-10-25 02:30'), first);
  assert.equal(berlin.parse('2026-10-25 02:30', {after: first + 1}), first + 3600);
  assert.equal(berlin.parse('2026-02-30 09:15'), null);
});

test('reads real scheduler result fields and skips running tasks and disabled future starts', async () => {
  const start = '2026-11-11 06:00:00';
  const stop = '2026-11-11 08:15:00';
  const timeline = await load({
    taskName,
    listTasks: async () => tasks,
    cgiRequest: async () => ({ok: true, json: async () => ({now, timeZone: 'Europe/Berlin', utcOffset: 3600})}),
    call: async (method, versions, params, api) => {
      if (method === 'get_history_status_list') return params.id === 27 ? [
        {start_time: start, stop_time: stop, exit_type: 'normal', exit_code: 0},
        {start_time: start, stop_time: stop, exit_type: 'normal', exit_code: 0},
        {start_time: '2026-11-11 09:00:00', exit_type: 'running'},
      ] : [];
      if (method === 'result_list') {
        assert.equal(api, 'SYNO.Core.EventScheduler');
        assert.equal(params.task_name, 'Startprotokoll');
        return [{start_time: start, stop_time: stop, exit_info: {exit_type: 'by_signal', exit_code: 1}}];
      }
      throw Object.assign(new Error('Optional package API absent'), {code: 102});
    },
  });
  assert.equal(timeline.now, now);
  assert.deepEqual(json(timeline.plans), [
    {id: 'synousage', name: taskName, start: at('2026-11-16T03:00:00+01:00'), detail: 'DSM-Aufgabenplaner'},
  ]);
  assert.deepEqual(json(timeline.runs.map(run => [run.id, run.status, run.end - run.start])), [
    ['synousage', 'Abgeschlossen', 8100], ['scheduler:9', 'Unterbrochen', 8100],
  ]);
  assert.equal(timeline.notes.length, 0);

  addMeasurements(timeline, [
    {at: '2026-11-11T07:14:59Z', durationSeconds: 8097},
    {at: '2026-11-11T16:30:00Z', durationSeconds: 600},
  ], {});
  assert.equal(timeline.runs.length, 3);
  assert.equal(timeline.runs[2].end - timeline.runs[2].start, 600);
});

test('keeps scheduled starts and independent sources when scheduler history is unavailable', async () => {
  const timeline = await load({
    taskName,
    listTasks: async () => tasks,
    cgiRequest: async () => ({ok: true, json: async () => ({now, utcOffset: 3600})}),
    call: async (method, versions, params, api) => {
      switch (api) {
        case 'SYNO.Core.Region.NTP': return {timezone: 'Europe/Berlin'};
        case 'SYNO.AntiVirus.Schedule': return {scheduleScanJobs: [
          {activated: true, scanType: 'fullScan', triggerTime: '0:04:00'},
        ]};
        case 'SYNO.AntiVirus.Log': return {reportArray: [
          {module: 'scanner', date: '2026-11-08 10:35:00', eventContent: 'Full Scan was complete.'},
          {module: 'scanner', date: '2026-11-08 04:00:00', eventContent: 'Full Scan started.'},
        ]};
        case 'SYNO.Storage.CGI.Storage':
          return method === 'get_schedule_plan'
            ? {schedule: {schedule_enabled: true, next_start_time: now + 86400}}
            : {storagePools: [{num_id: 1, last_done_time: now - 86400}]};
        default: throw Object.assign(new Error('Result API not supported'), {code: 103});
      }
    },
  });
  assert.equal(timeline.runs[0].id, 'antivirus:fullScan');
  assert.equal(timeline.runs[0].end - timeline.runs[0].start, 23700);
  assert.equal(timeline.plans.find(plan => plan.id === 'antivirus:fullScan').start, at('2026-11-15T04:00:00+01:00'));
  assert.equal(timeline.plans.find(plan => plan.id === 'storage-scrubbing').start, now + 86400);
  assert.ok(timeline.notes.some(note => note.includes('3 von 3 Aufgaben')));
  assert.ok(timeline.notes.some(note => note.includes('letzter Abschluss')));
});
