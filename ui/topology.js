(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SynoUsageTopology = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // Group only relationships reported by sysfs or LVM. System/swap mirrors
  // are displayed on disks but must not merge otherwise separate pools.
  function build(info) {
    const devices = Array.isArray(info.devices) ? info.devices : [];
    const disks = devices.filter((d) => d.kind === 'disk' && d.transport !== 'usb');
    const parts = devices.filter((d) => d.kind === 'partition');
    const raids = devices.filter((d) => d.kind === 'raid');
    const byName = new Map(devices.map((d) => [d.name, d]));
    const byLabel = new Map(devices.filter((d) => d.label).map((d) => [d.label, d]));
    const lvm = info.lvm || [];
    const pvs = info.pvs || [];
    const basename = (name) => String(name || '').split('/').pop();
    const lookup = (name) => byName.get(basename(name)) || byLabel.get(basename(name));
    const escaped = (part) => String(part || '').replace(/-/g, '--');
    const lvFor = (device) => lvm.find((lv) => device.label === escaped(lv.group) + '-' + escaped(lv.name));
    function ancestors(name, seen = new Set()) {
      const device = lookup(name);
      if (!device || seen.has(device.name)) return new Set();
      seen.add(device.name);
      const result = new Set(device.kind === 'raid' ? [device.name] : []);
      let children = device.members || [];
      const lv = device.kind === 'mapper' && lvFor(device);
      if (lv?.devices) {
        children = children.concat([...lv.devices.matchAll(/\/dev\/([^,(\s]+)/g)].map((m) => m[1]));
      }
      for (const child of children) for (const raid of ancestors(child, seen)) result.add(raid);
      return result;
    }
    const system = new Set(raids.filter((r) => (r.mounts || []).some((m) => m === '/' || m.startsWith('Swap'))).map((r) => r.name));
    const dataRaids = raids.filter((r) => !system.has(r.name));
    const parents = new Map(dataRaids.map((r) => [r.name, r.name]));
    const find = (name) => {
      let current = name;
      while (parents.has(current) && parents.get(current) !== current) current = parents.get(current);
      return current;
    };
    const union = (names) => {
      const valid = [...names].filter((n) => parents.has(n));
      if (!valid.length) return;
      const first = find(valid[0]);
      for (const name of valid.slice(1)) parents.set(find(name), first);
    };
    const raidDisks = (raid) => new Set((raid.members || []).map((name) => {
      const device = lookup(name);
      return device?.kind === 'disk' ? device.name : device?.kind === 'partition' ? device.parent : '';
    }).filter(Boolean));
    // A shared disk alone does not establish that arrays belong to the same
    // pool. Only group separate arrays when LVM reports the same VG.
    const vgArrays = new Map();
    for (const pv of pvs) {
      if (!pv.group) continue;
      if (!vgArrays.has(pv.group)) vgArrays.set(pv.group, new Set());
      for (const raid of ancestors(pv.name)) vgArrays.get(pv.group).add(raid);
    }
    for (const arrays of vgArrays.values()) union(arrays);
    const groups = new Map();
    for (const raid of dataRaids) {
      const key = find(raid.name);
      if (!groups.has(key)) groups.set(key, {raids: [], disks: [], volumes: []});
      groups.get(key).raids.push(raid);
    }
    for (const group of groups.values()) {
      const names = new Set(group.raids.flatMap((raid) => [...raidDisks(raid)]));
      group.disks = disks.filter((disk) => names.has(disk.name)).sort((a, b) => {
        const membership = (disk) => group.raids.map((r) => raidDisks(r).has(disk.name) ? '0' : '1').join('');
        return membership(a).localeCompare(membership(b)) || b.size - a.size || a.name.localeCompare(b.name);
      });
      group.volumeGroups = [...vgArrays].filter(([, arrays]) => group.raids.some((r) => arrays.has(r.name))).map(([name]) => name);
    }
    // Attach a volume only where the kernel/LVM device chain reaches its array.
    for (const device of devices) for (const mount of device.mounts || []) {
      if (!/^\/volume[1-9][0-9]*$/.test(mount)) continue;
      const found = ancestors(device.name);
      for (const group of groups.values()) {
        if (group.raids.some((raid) => found.has(raid.name)) && !group.volumes.includes(mount)) group.volumes.push(mount);
      }
    }
    const grouped = [...groups.values()].sort((a, b) =>
      (a.volumes[0] || '~').localeCompare(b.volumes[0] || '~', undefined, {numeric:true}) ||
      (a.raids[0]?.name || '').localeCompare(b.raids[0]?.name || '', undefined, {numeric:true}));
    const included = new Set(grouped.flatMap((g) => g.disks.map((d) => d.name)));
    const remaining = disks.filter((d) => !included.has(d.name));
    if (remaining.length) grouped.push({raids: [], disks: remaining, volumes: [], volumeGroups: []});
    return {groups: grouped, systemRaids: [...system], parts};
  }
  return {build};
});
