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
    var items = [
      item('abb', 'apps', 'Active Backup for Business', 10.02, {
        path: '/volume1/ActiveBackupforBusiness/@ActiveBackup',
        note: 'Gemessene Ablage des Backups.',
      }),
      item('drive', 'apps', 'Synology Drive', drive, {
        path: '/volume1/@synologydrive',
      }),
      item('photos', 'shares', 'Fotos', 1.15 * scale, {
        snapshotCount: 2,
        snapshotBytes: 0.12 * T * scale,
        measuredSnapshots: 2,
      }),
      item('media', 'shares', 'Medien', 0.92 * scale),
      item('backup', 'shares', 'Datensicherung', 0.62 * scale),
      item('vm', 'vmm', 'Virtuelle Datenträger', 0.54 * scale, {
        path: '/volume1/@iSCSI/LUN/VDISK_BLUN',
        snapshotCount: 1,
        snapshotBytes: 0.06 * T * scale,
        measuredSnapshots: 1,
      }),
      item('containers', 'docker', 'Docker / Container Manager', 0.24 * scale),
      item('snap', 'snapshots', 'Btrfs-Snapshots', 0.18 * scale, {
        metric: 'btrfs_qgroup_exclusive_lower_bound',
        snapshotCount: 3,
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
  window.SynoUsageDemo = {
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
