const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../ui/app.js'), 'utf8');
const start = source.indexOf('  function itemLabel(');
const end = source.indexOf('  function segmentAttributes(', start);
const context = {prefs: {subdivide: true}, names: {}};
vm.runInNewContext(source.slice(start, end) + '\nthis.chartSegments = chartSegments;', context);
const item = (id, bytes, volumeId = 'v') => ({id, name: id, bytes, volumeId});
const groups = ranked => [{key: 'apps', rows: ranked.map(item => ({item})), bytes: ranked.reduce((s, i) => s + i.bytes, 0)}];
const summary = (remainder, volumes) => ({remainder, weights: new Map(volumes)});
const total = {used: 60, free: 35, capacity: 100};

test('partial measurements leave actual unmeasured, reserved and free space', () => {
  const ranked = [item('a', 10)];
  const result = context.chartSegments(ranked, groups(ranked), total, ranked, summary(50, [['v', {used: 60, measured: 10}]]), true);
  assert.deepEqual(Array.from(result, x => [x.group, x.weight ?? x.value]), [['apps', 10], ['remainder', 50], ['reserved', 5], ['free', 35]]);
});
test('measured posts outside the top 20 are separate from unmeasured space', () => {
  const ranked = [item('a', 10)], measured = [...ranked, item('b', 20)];
  const result = context.chartSegments(ranked, groups(ranked), total, measured, summary(30, [['v', {used: 60, measured: 30}]]), false);
  assert.deepEqual(Array.from(result, x => [x.group, x.value]), [['apps', 10], ['measured-rest', 20], ['remainder', 30]]);
});
test('overlap scales each volume independently while preserving another volume remainder', () => {
  const ranked = [item('a', 120, 'a'), item('b', 80, 'a'), item('c', 10, 'b')];
  const result = context.chartSegments(ranked, groups(ranked), {used: 110, free: 40, capacity: 150}, ranked,
    summary(40, [['a', {used: 60, measured: 200}], ['b', {used: 50, measured: 10}]]), true);
  assert.deepEqual(Array.from(result, x => x.weight ?? x.value), [36, 24, 10, 40, 40]);
});
test('no measurements leaves the entire used area unmeasured', () => {
  const result = context.chartSegments([], [], total, [], summary(60, [['v', {used: 60, measured: 0}]]), true);
  assert.deepEqual(Array.from(result, x => [x.group, x.value]), [['remainder', 60], ['reserved', 5], ['free', 35]]);
});
test('grouped segments retain scaled weights', () => {
  context.prefs.subdivide = false;
  try {
    const ranked = [item('a', 120), item('b', 80)];
    const result = context.chartSegments(ranked, groups(ranked), total, ranked, summary(0, [['v', {used: 60, measured: 200}]]), false);
    assert.equal(result[0].value, 200);
    assert.equal(result[0].weight, 60);
  } finally { context.prefs.subdivide = true; }
});

// Exercise the real item filtering and overview together with the chart helpers.
const uiContext = {document: {querySelector: () => ({})}, localStorage: {getItem: () => null}};
const uiEnd = source.indexOf('  function current() {');
vm.runInNewContext(source.slice(0, uiEnd) + `
  globalThis.snapshotUI = {measuredItems, measurementSummary, snapshotBreakdown, itemLabel,
    chooseVolume: value => { volumeChoice = value; }};
})();`, uiContext);
const snapshotUI = uiContext.snapshotUI;
const snapshotRun = {
  volumes: [{id: 'volume1', name: 'Volume 1', used: 100}, {id: 'volume2', name: 'Volume 2', used: 80}],
  items: [
    {id: 'live', volumeId: 'volume1', group: 'shares', name: 'Freigabe', path: '/volume1/Freigabe', bytes: 30, metric: 'physical'},
    {id: 'sum1', volumeId: 'volume1', group: 'snapshots', name: 'Btrfs-Snapshots', path: '/volume1', bytes: 40, metric: 'btrfs_snapshot_data', snapshotCount: 2},
    {id: 'src1', parentId: 'sum1', volumeId: 'volume1', group: 'snapshots', name: 'Freigabe', path: '/volume1/Freigabe', bytes: 32, metric: 'btrfs_snapshot_data', snapshotCount: 2},
    {id: 'shared', parentId: 'sum1', volumeId: 'volume1', group: 'snapshots', name: 'Quellübergreifend geteilt', bytes: 8, metric: 'btrfs_snapshot_data'},
    {id: 'snap1', parentId: 'sum1', volumeId: 'volume1', group: 'snapshots', name: 'Einzelner Snapshot', bytes: 20, exclusiveBytes: 20, referencedBytes: 40, metric: 'btrfs_snapshot_data'},
    {id: 'sum2', volumeId: 'volume2', group: 'snapshots', name: 'Btrfs-Snapshots', path: '/volume2', bytes: 10, metric: 'btrfs_snapshot_data', snapshotCount: 1},
    {id: 'src2', parentId: 'sum2', volumeId: 'volume2', group: 'snapshots', name: 'VM-Image', path: '/volume2/VM', bytes: 10, metric: 'btrfs_snapshot_data', snapshotCount: 1},
  ],
};

test('snapshot sources and shared bytes replace the matching volume total exactly once', () => {
  snapshotUI.chooseVolume('all');
  const measured = snapshotUI.measuredItems(snapshotRun);
  assert.deepEqual(Array.from(measured, row => row.id), ['src1', 'live', 'src2', 'shared']);
  assert.equal(snapshotUI.itemLabel(measured[0]), 'Freigabe · 2 Snapshots');
  assert.equal(snapshotUI.itemLabel(measured[2]), 'VM-Image · 1 Snapshot');
  assert.equal(snapshotUI.measurementSummary(snapshotRun, measured).remainder, 100);
  assert.doesNotMatch(snapshotUI.snapshotBreakdown(snapshotRun), /Einzelner Snapshot/);
});

test('an incomplete breakdown preserves the volume total and the unmeasured remainder', () => {
  const partial = {...snapshotRun, items: snapshotRun.items.filter(row => row.id !== 'shared')};
  assert.deepEqual(Array.from(snapshotUI.measuredItems(partial), row => row.id), ['sum1', 'live', 'src2']);
  assert.equal(snapshotUI.measurementSummary(partial).remainder, 100);
});

test('snapshot overview follows the selected source volume', () => {
  snapshotUI.chooseVolume('volume2');
  try {
    const html = snapshotUI.snapshotBreakdown(snapshotRun);
    assert.match(html, /Volume 2/);
    assert.match(html, /VM-Image/);
    assert.doesNotMatch(html, /Volume 1|Freigabe/);
    assert.equal(snapshotUI.measurementSummary(snapshotRun).remainder, 70);
  } finally { snapshotUI.chooseVolume('all'); }
});

test('older snapshot runs retain source lower bounds and distinguish missing values', () => {
  const legacy = {volumes: [snapshotRun.volumes[0]], items: [
    {id: 'oldsum', volumeId: 'volume1', group: 'snapshots', path: '/volume1', metric: 'btrfs_qgroup_exclusive_lower_bound', bytes: 5, snapshotCount: 2},
    {id: 'oldsource', volumeId: 'volume1', group: 'shares', name: 'Alte Freigabe', snapshotCount: 1, snapshotBytes: 5},
    {id: 'missing', volumeId: 'volume1', group: 'shares', name: 'Unbekannt', snapshotCount: 1},
  ]};
  const html = snapshotUI.snapshotBreakdown(legacy);
  assert.match(html, /Alte Freigabe/);
  assert.match(html, /≥ 5 B/);
  assert.match(html, /Unbekannt/);
  assert.match(html, /Nicht ermittelt/);
});

