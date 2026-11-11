const test = require('node:test');
const assert = require('node:assert/strict');
const {build} = require('../ui/topology.js');

test('groups data arrays through LVM without merging disks through system mirrors', () => {
  const info = {devices: [
    {name:'sda',kind:'disk',size:8}, {name:'sdb',kind:'disk',size:12},
    {name:'sdc',kind:'disk',size:12}, {name:'sdd',kind:'disk',size:4},
    {name:'sda1',kind:'partition',parent:'sda'}, {name:'sdb1',kind:'partition',parent:'sdb'},
    {name:'sdc1',kind:'partition',parent:'sdc'}, {name:'sdd1',kind:'partition',parent:'sdd'},
    {name:'sda5',kind:'partition',parent:'sda'}, {name:'sdb5',kind:'partition',parent:'sdb'},
    {name:'sdc5',kind:'partition',parent:'sdc'}, {name:'sdb6',kind:'partition',parent:'sdb'},
    {name:'sdc6',kind:'partition',parent:'sdc'}, {name:'sdd3',kind:'partition',parent:'sdd'},
    {name:'md0',kind:'raid',members:['sda1','sdb1','sdc1','sdd1'],mounts:['/']},
    {name:'md1',kind:'raid',members:['sda1','sdb1','sdc1','sdd1'],mounts:['Swap (aktiv)']},
    {name:'md2',kind:'raid',members:['sda5','sdb5','sdc5']},
    {name:'md3',kind:'raid',members:['sdb6','sdc6']},
    {name:'md4',kind:'raid',members:['sdd3']},
    {name:'dm-0',kind:'mapper',label:'vg1-volume_1',members:['md2','md3']},
    {name:'dm-1',kind:'mapper',label:'cachedev_0',members:['dm-0'],mounts:['/volume1']},
    {name:'dm-2',kind:'mapper',members:['md4'],mounts:['/volume2']},
  ], pvs:[{name:'/dev/md2',group:'vg1'},{name:'/dev/md3',group:'vg1'}]};
  const topology = build(info);
  assert.deepEqual(topology.systemRaids, ['md0','md1']);
  assert.equal(topology.groups.length, 2);
  const first = topology.groups.find((g) => g.volumes.includes('/volume1'));
  assert.deepEqual(first.raids.map((r) => r.name), ['md2','md3']);
  assert.deepEqual(new Set(first.disks.map((d) => d.name)), new Set(['sda','sdb','sdc']));
  assert.deepEqual(first.volumeGroups, ['vg1']);
  const second = topology.groups.find((g) => g.volumes.includes('/volume2'));
  assert.deepEqual(second.disks.map((d) => d.name), ['sdd']);
});

test('leaves NVMe and unlinked volumes unclassified instead of assuming a cache', () => {
  const topology = build({devices:[
    {name:'nvme0n1',kind:'disk',size:10},
    {name:'nvme0n1p1',kind:'partition',parent:'nvme0n1'},
    {name:'md3',kind:'raid',members:['nvme0n1p1']},
    {name:'dm-4',kind:'mapper',members:[],mounts:['/volume3']},
  ]});
  assert.equal(topology.groups.length, 1);
  assert.deepEqual(topology.groups[0].volumes, []);
  assert.deepEqual(topology.groups[0].disks.map((d) => d.name), ['nvme0n1']);
});

test('uses LVM device lists when the mapper has no accessible lower devices', () => {
  const topology = build({devices:[
    {name:'sda',kind:'disk',size:10}, {name:'sda5',kind:'partition',parent:'sda'},
    {name:'md2',kind:'raid',members:['sda5']},
    {name:'dm-1',kind:'mapper',label:'vg1-volume_1',mounts:['/volume1']},
  ], lvm:[{group:'vg1',name:'volume_1',devices:'/dev/md2(3)'}]});
  assert.deepEqual(topology.groups[0].volumes, ['/volume1']);
});

test('does not merge arrays solely because they share a physical disk', () => {
  const topology = build({devices:[
    {name:'sda',kind:'disk',size:20},
    {name:'sda3',kind:'partition',parent:'sda'}, {name:'sda4',kind:'partition',parent:'sda'},
    {name:'md2',kind:'raid',members:['sda3']}, {name:'md3',kind:'raid',members:['sda4']},
  ]});
  assert.equal(topology.groups.length, 2);
  assert.deepEqual(topology.groups.map((g) => g.raids[0].name), ['md2','md3']);
});
