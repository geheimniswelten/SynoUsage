(function () {
  'use strict';
  var T = Math.pow(1024, 4),
    G = Math.pow(1024, 3);
  function item(id, group, name, size, extra) {
    return Object.assign(
      {
        id: id,
        volumeId: 'volume1',
        group: group,
        name: name,
        path: '/volume1/' + name,
        bytes: size * T,
        metric: 'physical',
        additive: true,
      },
      extra || {},
    );
  }
  function run(id, date, drive, scale) {
    var photoSnapshots = Math.round(0.12 * T * scale);
    var vmSnapshots = Math.round(0.06 * T * scale);
    var items = [
      item('abb', 'shares', 'ActiveBackupforBusiness', 10.02, {
        path: '/volume1/ActiveBackupforBusiness',
        note: 'Beispiel für die Freigabe der Sicherungsdaten.',
      }),
      item('abb-app', 'apps', 'Active Backup for Business', 0.48, {
        path: '/volume1/@ActiveBackup',
        note: 'Separates Beispiel für das App-Verzeichnis.',
      }),
      item('drive', 'apps', 'Synology Drive', drive, {
        path: '/volume1/@synologydrive',
      }),
      item('photos', 'shares', 'Fotos', 1.15 * scale, {
        snapshotCount: 2,
        snapshotBytes: photoSnapshots,
        measuredSnapshots: 2,
      }),
      item('media', 'shares', 'Medien', 0.92 * scale),
      item('backup', 'shares', 'Datensicherung', 0.62 * scale),
      item('vm', 'vmm', 'Virtuelle Datenträger', 0.54 * scale, {
        path: '/volume1/@iSCSI/LUN/VDISK_BLUN',
        snapshotCount: 1,
        snapshotBytes: vmSnapshots,
        measuredSnapshots: 1,
      }),
      item('containers', 'docker', 'Docker / Container Manager', 0.24 * scale),
      item('snap', 'snapshots', 'Btrfs-Snapshots', 0, {
        path: '/volume1',
        bytes: photoSnapshots + vmSnapshots,
        metric: 'btrfs_qgroup_exclusive_lower_bound',
        snapshotCount: 3,
      }),
      item('snap-source-photos', 'snapshots', 'Fotos', 0, {
        parentId: 'snap',
        bytes: photoSnapshots,
        metric: 'btrfs_qgroup_exclusive_lower_bound',
        snapshotCount: 2,
        additive: false,
      }),
      item('snap-source-vm', 'snapshots', 'Virtuelle Datenträger', 0, {
        path: '/volume1/@iSCSI/LUN/VDISK_BLUN',
        parentId: 'snap',
        bytes: vmSnapshots,
        metric: 'btrfs_qgroup_exclusive_lower_bound',
        snapshotCount: 1,
        additive: false,
      }),
      item('home', 'shares', 'homes', 0.17 * scale),
      item('san', 'other', 'iSCSI / SAN', 0.044 * scale, {
        path: '/volume1/@iSCSI',
      }),
      item('other', 'other', 'Weitere Daten', 0.436 * scale),
      item('abb-logical', 'apps', 'ABB · virtuelle Sicherungsgröße', 43, {
        path: '/volume1/ActiveBackupforBusiness/ActiveBackupData',
        parentId: 'abb',
        metric: 'logical',
        additive: false,
        note: 'Virtuelle Sicherungsansicht.',
      }),
      item('docker-image', 'docker', 'nginx:stable', (0.33 * G) / T, {
        parentId: 'containers',
        metric: 'docker_image',
        additive: false,
        sharedBytes: 0.14 * G,
      }),
      ...[
        ['photos', 'Fotos · 01.10. 07:00', 0.08, 1.12],
        ['photos', 'Fotos · 30.09. 07:00', 0.04, 1.05],
        ['vm', 'VM-Datenträger · 01.10. 03:00', 0.06, 0.32],
      ].map(([parentId, name, exclusive, referenced], i) =>
        item('snap-' + i, 'snapshots', name, exclusive * scale, {
          parentId,
          metric: 'btrfs_qgroup_exclusive',
          additive: false,
          exclusiveBytes: exclusive * T * scale,
          referencedBytes: referenced * T * scale,
        }),
      ),
      item('vol2-media', 'shares', 'Archiv', 1.8 * scale, {
        volumeId: 'volume2',
        path: '/volume2/Archiv',
      }),
      item('vol2-backup', 'shares', 'Backup', 0.8 * scale, {
        volumeId: 'volume2',
        path: '/volume2/Backup',
      }),
    ];
    var used =
      id === 'r5'
        ? 14.6 * T
        : items
            .filter(function (x) {
              return x.volumeId === 'volume1' && x.additive;
            })
            .reduce(function (a, x) {
              return a + x.bytes;
            }, 0);
    return {
      id: id,
      at: date,
      durationSeconds: 7380,
      volumes: [
        {
          id: 'volume1',
          name: 'Volume 1',
          fs: 'Btrfs',
          capacity: 31.4 * T,
          used: used,
          free: 31.4 * T - used,
        },
        {
          id: 'volume2',
          name: 'Volume 2',
          fs: 'Btrfs',
          capacity: 8 * T,
          used: 2.6 * T * scale,
          free: (8 - 2.6 * scale) * T,
        },
      ],
      items: items,
    };
  }
  function tasks() {
    const {clock, shiftDate, weekday} = window.SynoUsageTaskTime;
    const local = clock();
    const now = Math.floor(Date.now() / 1000);
    const today = local.civil(now);
    let workday = shiftDate(today, -1);
    while ([0, 6].includes(weekday(workday))) workday = shiftDate(workday, -1);
    const work = (hour, minute = 0) => local.epoch({...workday, hour, minute});
    const scheduled = (name, id, days, hour) => ({
      name, id, start: local.epoch({...shiftDate(today, days), hour}),
    });
    return {
      now, timeZone: local.timeZone,
      runs: [
        {id: 'backup', name: 'Datensicherung', start: work(6), end: work(10, 35)},
        {id: 'synousage', name: 'SynoUsage Erfassung', start: work(9), end: work(10, 10)},
        {id: 'antivirus', name: 'Antivirus Essential · Vollständiger Scan', start: work(13), end: work(18, 10)},
      ],
      plans: [
        scheduled('SynoUsage Erfassung', 'synousage', 1, 3),
        scheduled('Datensicherung', 'backup', 1, 10),
        scheduled('Datenbereinigung', 'scrub', 3, 0),
        scheduled('Antivirus Essential · Vollständiger Scan', 'antivirus', 5, 4),
      ],
      notes: ['Beispieldaten für die Vorschau.'],
    };
  }

  window.SynoUsageDemo = {
    tasks,
    hardware: {
      at: '2026-10-01T08:00:00Z', model: 'Beispiel-NAS', dsm: '7.2.2-72806', kernel: '4.4.302+', cpu: 'Beispiel-Prozessor', cpus: 4, memory: 8 * G,
      root: {capacity: 2.4 * G, used: 1.7 * G, free: 0.6 * G},
      devices: [
        {name:'sda', kind:'disk', model:'Beispiel-HDD', size:16*T},
        {name:'sda1', kind:'partition', parent:'sda', start:1024*1024, size:2*G-1024*1024},
        {name:'sda2', kind:'partition', parent:'sda', start:2*G, size:2*G},
        {name:'sda3', kind:'partition', parent:'sda', start:4*G, size:16*T-4*G},
        {name:'sdb', kind:'disk', model:'Beispiel-HDD', size:24*T},
        {name:'sdb1', kind:'partition', parent:'sdb', start:1024*1024, size:2*G-1024*1024},
        {name:'sdb2', kind:'partition', parent:'sdb', start:2*G, size:2*G},
        {name:'sdb3', kind:'partition', parent:'sdb', start:4*G, size:16*T-4*G},
        {name:'sdb4', kind:'partition', parent:'sdb', start:16*T, size:4*T},
        {name:'sdc', kind:'disk', model:'Beispiel-HDD', size:20*T},
        {name:'sdc1', kind:'partition', parent:'sdc', start:1024*1024, size:2*G-1024*1024},
        {name:'sdc2', kind:'partition', parent:'sdc', start:2*G, size:2*G},
        {name:'sdc3', kind:'partition', parent:'sdc', start:4*G, size:16*T-4*G},
        {name:'sdc4', kind:'partition', parent:'sdc', start:16*T, size:4*T},
        {name:'sdd', kind:'disk', model:'Beispiel-SSD', medium:'nicht rotierend', size:8*T},
        {name:'sdd1', kind:'partition', parent:'sdd', start:1024*1024, size:2*G-1024*1024},
        {name:'sdd2', kind:'partition', parent:'sdd', start:2*G, size:2*G},
        {name:'sdd3', kind:'partition', parent:'sdd', start:4*G, size:8*T-4*G},
        {name:'nvme0n1', kind:'disk', model:'Beispiel-NVMe', size:500*G},
        {name:'nvme0n1p1', kind:'partition', parent:'nvme0n1', start:1024*1024, size:499*G},
        {name:'nvme1n1', kind:'disk', model:'Beispiel-NVMe', size:500*G},
        {name:'nvme1n1p1', kind:'partition', parent:'nvme1n1', start:1024*1024, size:499*G},
        {name:'sde', kind:'disk', transport:'usb', model:'Beispiel-USB', size:4*G},
        {name:'md0', kind:'raid', level:'raid1', size:2*G, members:['sda1','sdb1','sdc1','sdd1'], mounts:['/']},
        {name:'md1', kind:'raid', level:'raid1', size:2*G, members:['sda2','sdb2','sdc2','sdd2'], mounts:['Swap (aktiv)']},
        {name:'md2', kind:'raid', level:'raid5', size:32*T-8*G, members:['sda3','sdb3','sdc3']},
        {name:'md3', kind:'raid', level:'raid1', size:8*T-4*G, members:['sdd3']},
        {name:'md4', kind:'raid', level:'raid1', size:4*T, members:['sdb4','sdc4']},
        {name:'md5', kind:'raid', level:'raid1', size:499*G, members:['nvme0n1p1','nvme1n1p1']},
        {name:'dm-0', kind:'mapper', label:'vg1-volume_1', size:31.4*T, members:['md2','md4'], mounts:['/volume1']},
        {name:'dm-1', kind:'mapper', label:'cachedev_2', size:8*T-4*G, members:['md3'], mounts:['/volume2']},
      ],
      pvs:[{name:'/dev/md2',group:'vg1',size:32*T-8*G,free:1*G},{name:'/dev/md4',group:'vg1',size:4*T,free:1*G}],
      lvm:[{group:'vg1',name:'volume_1',size:31.4*T,devices:'/dev/md2(0),/dev/md4(0)'}],
    },
    runs: [
      run('r1', '2026-06-01T08:00:00Z', 18, 0.8),
      run('r2', '2026-07-01T08:00:00Z', 12, 0.85),
      run('r3', '2026-08-01T08:00:00Z', 5, 0.9),
      run('r4', '2026-09-01T08:00:00Z', 1.2, 0.95),
      run('r5', '2026-10-01T08:00:00Z', 0.28, 1),
    ],
    status: { state: 'idle', message: 'Demo-Daten' },
    user: 'Demo',
  };
})();
