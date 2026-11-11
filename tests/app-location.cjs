const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../ui/app.js'), 'utf8');
const start = source.indexOf('  function itemLocation(');
const end = source.indexOf('  function groupCards(', start);
assert.ok(start >= 0 && end > start);

function location(choice, item, volume) {
  const context = {volumeChoice: choice};
  vm.runInNewContext(source.slice(start, end) + '\nthis.location = itemLocation;', context);
  return context.location(item, volume);
}

test('app entries show volume and actual directory, including single-volume view', () => {
  const item = {group: 'apps', path: '/volume1/@ActiveBackup', volumeId: 'volume1'};
  assert.equal(location('all', item, {name: 'Volume 1'}), 'Volume 1 › @ActiveBackup');
  assert.equal(location('volume1', item, {name: 'Volume 1'}), 'Volume 1 › @ActiveBackup');
  assert.equal(location('all', {...item, path: ''}, {name: 'Volume 1'}), 'Volume 1');
});

test('other groups keep the existing volume display', () => {
  const item = {group: 'shares', path: '/volume1/Files', volumeId: 'volume1'};
  assert.equal(location('all', item, {name: 'Volume 1'}), 'Volume 1');
  assert.equal(location('volume1', item, {name: 'Volume 1'}), '');
});
