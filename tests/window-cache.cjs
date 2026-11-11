const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('opening the DSM window requests a fresh entry page each time', () => {
  const source = fs.readFileSync(path.join(__dirname, '../package/ui/SynoUsage.js'), 'utf8')
    .replace('__SYNOUSAGE_BUILD__', 'test-build');
  let now = 100;
  const configs = [];
  const namespace = {};
  const Ext = {
    namespace() {},
    apply: (defaults, options) => Object.assign(defaults, options),
    define(name, definition) {
      if (name.endsWith('.MainWindow')) {
        definition.superclass = {constructor: function (options) { configs.push(options); }};
        namespace.MainWindow = definition;
      }
    },
  };
  vm.runInNewContext(source, {Ext, SYNO: {SDS: {h5uSynoUsage: namespace}}, Date: {now: () => now}});
  namespace.MainWindow.constructor.call({}, {appInstance: {}});
  now++;
  namespace.MainWindow.constructor.call({}, {appInstance: {}});
  assert.match(configs[0].html, /index\.html\?v=test-build&amp;open=100/);
  assert.match(configs[1].html, /index\.html\?v=test-build&amp;open=101/);
});
