(function () {
  'use strict';
  var $ = function (s) {
      return document.querySelector(s);
    },
    content = $('#content'),
    demo = false,
    data,
    page = 'current',
    selected = null,
    dateId = null,
    volumeChoice = 'all',
    busy = false;
  var defaults = {
      start: 'last',
      startVolume: '',
      volume: 'all',
      chart: 'bar',
      free: 'auto',
      mini: true,
      subdivide: true,
      topCount: '20',
      groupSort: 'size',
      detailGroup: 'all',
      sort: 'size',
    },
    prefs;
  try {
    prefs = Object.assign(
      {},
      defaults,
      JSON.parse(localStorage.getItem('synousage.preferences') || '{}'),
    );
  } catch (e) {
    prefs = Object.assign({}, defaults);
  }
  if (!['10', '20', '25', '50', '100', 'all'].includes(prefs.topCount)) {
    prefs.topCount = defaults.topCount;
  }
  if (!['rank', 'size', 'count'].includes(prefs.groupSort)) {
    prefs.groupSort = defaults.groupSort;
  }
  function save() {
    try {
      localStorage.setItem('synousage.preferences', JSON.stringify(prefs));
    } catch (e) {}
  }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      }[c];
    });
  }
  function fmt(n) {
    if (n == null || !Number.isFinite(Number(n))) return '–';
    n = Number(n);
    var units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'],
      i = 0;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i++;
    }
    return (
      new Intl.NumberFormat('de-DE', {
        maximumFractionDigits: i ? 2 : 0,
      }).format(n) +
      ' ' +
      units[i]
    );
  }
  function pct(n, d) {
    return d > 0 ? Math.max(0, Math.min(100, (n / d) * 100)) : 0;
  }
  function date(s) {
    var d = new Date(s);
    return isNaN(d)
      ? String(s || '–')
      : new Intl.DateTimeFormat('de-DE', {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(d);
  }
  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '';
    const totalMinutes = Math.floor(seconds / 60);
    const hours = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
    const minutes = String(totalMinutes % 60).padStart(2, '0');
    return hours + ':' + minutes;
  }
  var names = {
      shares: 'Freigaben',
      apps: 'Apps',
      vmm: 'Virtuelle Maschinen',
      docker: 'Container',
      snapshots: 'Snapshots',
      other: 'Weitere Daten',
      free: 'Frei',
    },
    colors = {
      shares: '#36a6b0',
      apps: '#467bc5',
      vmm: '#8b79bb',
      docker: '#e8a958',
      snapshots: '#d37e8c',
      other: '#9cacb8',
      remainder: '#aabcc5',
      'measured-rest': '#8e9da5',
      reserved: '#becdd2',
      free: '#e1ebef',
    };
  function runs() {
    return (data.runs || []).slice().sort(function (a, b) {
      return new Date(a.at) - new Date(b.at);
    });
  }
  function latest() {
    var r = runs();
    var saved = r[r.length - 1];
    var live = data.current;
    if (live && (!data.status?.runId || live.id === data.status.runId) &&
        (!saved || new Date(live.at) >= new Date(saved.at))) return live;
    return saved;
  }
  function currentRun() {
    return (
      runs().find(function (r) {
        return r.id === dateId;
      }) || latest()
    );
  }
  function volumes(r) {
    return (r.volumes || []).filter(function (v) {
      return volumeChoice === 'all' || v.id === volumeChoice;
    });
  }
  function items(r) {
    var ids = volumes(r).map(function (v) {
      return v.id;
    });
    return (r.items || []).filter(function (i) {
      return ids.indexOf(i.volumeId) >= 0;
    });
  }
  function isSnapshotSummary(item) {
    return item.group === 'snapshots' && !item.parentId && item.path === '/' + item.volumeId;
  }
  function isSnapshotSource(item) {
    return item.group === 'snapshots' && item.exclusiveBytes == null && item.referencedBytes == null &&
      ['btrfs_snapshot_data', 'btrfs_qgroup_exclusive_lower_bound'].includes(item.metric);
  }
  function snapshotSourceRows(all, summary) {
    return all.filter((item) => item.parentId === summary.id && item.volumeId === summary.volumeId && isSnapshotSource(item));
  }
  function hasMeasuredBytes(item) {
    return Number.isFinite(item.bytes) && item.bytes > 0;
  }
  function measuredItems(r) {
    const all = items(r);
    return all
      .filter(
        (item) =>
          !item.parentId &&
          hasMeasuredBytes(item) &&
          item.metric !== 'logical' &&
          item.metric !== 'virtual_mount',
      )
      .flatMap((item) => {
        if (!isSnapshotSummary(item)) return [item];
        const sources = snapshotSourceRows(all, item).filter(hasMeasuredBytes);
        // A complete breakdown replaces the total so both views account for the same bytes.
        return sources.reduce((sum, source) => sum + source.bytes, 0) === item.bytes ? sources : [item];
      })
      .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name, 'de'));
  }
  function rankingLabel() {
    return prefs.topCount === 'all' ? 'Alle Posten' : 'Top ' + prefs.topCount;
  }
  function rankedOverview(run) {
    const measured = measuredItems(run);
    const ranked = prefs.topCount === 'all' ? measured : measured.slice(0, Number(prefs.topCount));
    const summary = measurementSummary(run, measured);
    return { measured, ranked, summary, groups: groupedItems(ranked, summary.remainder) };
  }
  function measurementSummary(r, measured = measuredItems(r)) {
    const byVolume = new Map(volumes(r).map((v) => [v.id, { used: Number(v.used) || 0, measured: 0 }]));
    measured.forEach((item) => { const v = byVolume.get(item.volumeId); if (v) v.measured += item.bytes; });
    return {
      remainder: [...byVolume.values()].reduce((sum, v) => sum + Math.max(0, v.used - v.measured), 0),
      weights: byVolume,
    };
  }
  function sums(r) {
    var vs = volumes(r);
    return vs.reduce(
      function (a, v) {
        a.capacity += Number(v.capacity) || 0;
        a.used += Number(v.used) || 0;
        a.free += Number(v.free) || 0;
        return a;
      },
      { capacity: 0, used: 0, free: 0 },
    );
  }
  function fillVolumes() {
    var vs = latest().volumes || [],
      html =
        '<option value="all">Alle Volumes</option>' +
        vs
          .map(function (v) {
            return (
              '<option value="' + esc(v.id) + '">' + esc(v.name) + '</option>'
            );
          })
          .join('');
    $('#volume-filter').innerHTML = html;
    $('#start-volume').innerHTML = vs
      .map(function (v) {
        return '<option value="' + esc(v.id) + '">' + esc(v.name) + '</option>';
      })
      .join('');
    volumeChoice = vs.some((volume) => volume.id === prefs.volume)
      ? prefs.volume
      : 'all';
    $('#volume-filter').value = volumeChoice;
  }
  function kpis(r) {
    const s = sums(r);
    const count = volumes(r).length;
    const capacityBody = `<span class="kpi-heading"><span>Gesamtkapazität</span><small>${count} Volume${count === 1 ? '' : 's'}</small></span>
      <strong>${fmt(s.capacity)}</strong>`;
    const capacity = volumeChoice === 'all'
      ? `<div class="kpi">${capacityBody}</div>`
      : `<button class="kpi kpi-return" data-volume="all" aria-label="Alle Volumes anzeigen">${capacityBody}<span class="kpi-return-arrow" aria-hidden="true">◀</span></button>`;
    return `<div class="kpis">${capacity}
      <div class="kpi"><span class="kpi-heading"><span>Belegt</span><small>${pct(s.used, s.capacity).toFixed(1).replace('.', ',')} % der Kapazität</small></span><strong>${fmt(s.used)}</strong></div>
      <div class="kpi"><span class="kpi-heading"><span>Frei</span><small>Verfügbarer Speicher</small></span><strong>${fmt(s.free)}</strong></div></div>`;
  }
  function groupedItems(ranked, remainder) {
    const groups = new Map();
    ranked.forEach((item, index) => {
      if (!groups.has(item.group))
        groups.set(item.group, { key: item.group, bytes: 0, rows: [] });
      const group = groups.get(item.group);
      group.bytes += item.bytes;
      group.rows.push({ item, rank: index + 1 });
    });
    if (remainder && !groups.has('other')) {
      groups.set('other', { key: 'other', bytes: 0, rows: [] });
    }
    const ordered = [...groups.values()];
    for (const group of ordered) {
      const unmeasured = group.key === 'other' ? remainder : 0;
      group.totalBytes = group.bytes + unmeasured;
      group.entryCount = group.rows.length + (unmeasured ? 1 : 0);
    }
    // Stable sorting preserves the first item's rank when group totals tie.
    if (prefs.groupSort === 'size') ordered.sort((a, b) => b.totalBytes - a.totalBytes);
    if (prefs.groupSort === 'count') ordered.sort((a, b) => b.entryCount - a.entryCount);
    return ordered;
  }

  function groupColor(group) {
    return colors[group] || colors.other;
  }

  function selectedItem(group, id) {
    return (
      selected === 'group:' + group ||
      (id
        ? selected === id
        : !!selected &&
          items(page === 'history' ? currentRun() : latest()).some(
            (item) => item.group === group && item.id === selected,
          ))
    );
  }

  function itemLabel(item) {
    if (item.group !== 'snapshots' || !item.snapshotCount) return item.name;
    return `${item.name} · ${item.snapshotCount} ${item.snapshotCount === 1 ? 'Snapshot' : 'Snapshots'}`;
  }

  function itemLocation(item, volume) {
    const volumeName = volume?.name || item.volumeId || '';
    if (item.group === 'apps') {
      const directory = typeof item.path === 'string' ? item.path.split('/').filter(Boolean).at(-1) : '';
      return [volumeName, directory].filter(Boolean).join(' › ');
    }
    return volumeChoice === 'all' ? volumeName : '';
  }

  function groupCards(run, { ranked, groups, summary }) {
    const { remainder } = summary;
    const maximum = Math.max(ranked[0]?.bytes || 0, remainder);
    return groups
      .map(
        ({ key, totalBytes, rows }) => {
          const entryLabel = prefs.topCount === 'all'
            ? `${rows.length} ${rows.length === 1 ? 'Eintrag' : 'Einträge'}`
            : `${rows.length} in den ${rankingLabel()}`;
          return `
      <article class="group-card">
        <button class="group-head" data-group="${esc(key)}" aria-pressed="${selectedItem(key)}">
          <span class="dot" style="background:${groupColor(key)}"></span>
          <span class="group-label"><strong>${esc(names[key] || key)}</strong>${rows.length ? `<small>${entryLabel}</small>` : ''}</span>
          <strong>${rows.some(({item}) => item.metric === 'btrfs_qgroup_exclusive_lower_bound') ? '≥ ' : ''}${fmt(totalBytes)}</strong>
        </button>
        <div class="rows">${key === 'other' && remainder ? `<div class="item-row"><span class="rank" aria-hidden="true"></span><span class="item-name">Nicht erfasst</span><span class="item-value">${fmt(remainder)}</span>${prefs.mini ? `<span class="mini"><i style="width:${pct(remainder, maximum)}%;background:${groupColor('remainder')}"></i></span>` : ''}</div>` : ''}${rows
          .map(({ item, rank }) => {
            const volume = run.volumes.find(
              (entry) => entry.id === item.volumeId,
            );
            const location = itemLocation(item, volume);
            return `<button class="item-row" data-item="${esc(item.id)}" data-group="${esc(key)}"
              aria-pressed="${Boolean(selectedItem(key, item.id))}">
            <span class="rank" aria-label="Platz ${rank}">${rank}</span>
            <span class="item-name">${esc(itemLabel(item))}
              ${location ? `<small>${esc(location)}</small>` : ''}</span>
            <span class="item-value">${item.metric === 'btrfs_qgroup_exclusive_lower_bound' ? '≥ ' : ''}${fmt(item.bytes)}</span>
            ${prefs.mini ? `<span class="mini"><i style="width:${pct(item.bytes, maximum)}%;background:${groupColor(key)}"></i></span>` : ''}
          </button>`;
          })
          .join('')}</div>
      </article>`;
        },
      )
      .join('');
  }

  function chartSegments(ranked, groups, total, measured, summary, showFree) {
    const rankedIds = new Set(ranked.map((item) => item.id));
    const weight = (item) => {
      const volume = summary.weights.get(item.volumeId);
      return item.bytes * (volume && volume.measured > volume.used ? volume.used / volume.measured : 1);
    };
    const segments = groups.filter((group) => group.rows.length).flatMap(({ key, bytes, rows }) =>
      prefs.subdivide
        ? rows.map(({ item }) => ({ group: key, id: item.id, name: itemLabel(item), value: item.bytes, weight: weight(item) }))
        : [{ group: key, name: names[key] || key, value: bytes, weight: rows.reduce((sum, row) => sum + weight(row.item), 0) }],
    );
    const outside = measured.filter((item) => !rankedIds.has(item.id));
    if (outside.length) segments.push({
      group: 'measured-rest', name: 'Weitere erfasste Posten',
      value: outside.reduce((sum, item) => sum + item.bytes, 0),
      weight: outside.reduce((sum, item) => sum + weight(item), 0),
    });
    if (summary.remainder) segments.push({ group: 'remainder', name: 'Nicht erfasst', value: summary.remainder });
    const reserved = Math.max(0, total.capacity - total.used - total.free);
    if (showFree && reserved) segments.push({ group: 'reserved', name: 'Reserviert', value: reserved });
    if (showFree && total.free) segments.push({ group: 'free', name: 'Frei', value: total.free });
    return segments;
  }

  function segmentAttributes(segment) {
    const { group, id, name, value } = segment;
    const label = esc(name + ' · ' + fmt(value));
    const action = ['free', 'remainder', 'reserved', 'measured-rest'].includes(group)
      ? ''
      : `data-group="${esc(group)}" ${id ? `data-item="${esc(id)}"` : ''}
      aria-pressed="${Boolean(id ? selectedItem(group, id) : selected === 'group:' + group)}"`;
    return { label, action };
  }

  function renderBar(segments, basis, total) {
    return `<div class="stack" aria-label="Speicherverteilung">${segments
      .map((segment) => {
        const { label, action } = segmentAttributes(segment);
        const style = `width:${pct(segment.weight ?? segment.value, basis)}%;background:${groupColor(segment.group)}`;
        if (!action)
          return `<span class="segment" title="${label}" style="${style}"></span>`;
        return `<button class="segment" ${action} title="${label}" aria-label="${label}" style="${style}"></button>`;
      })
      .join(
        '',
      )}</div><div class="bar-caption"><span>Belegt: ${fmt(total.used)} von ${fmt(total.capacity)}</span></div>`;
  }

  function renderDonut(segments, basis, used) {
    const point = (turn) => {
      const angle = turn * 2 * Math.PI - Math.PI / 2;
      return `${100 + 72 * Math.cos(angle)},${100 + 72 * Math.sin(angle)}`;
    };
    let offset = 0;
    const slices = segments
      .map((segment) => {
        const fraction = Math.min(0.999999, (segment.weight ?? segment.value) / basis);
        const path = `M ${point(offset)} A 72 72 0 ${fraction > 0.5 ? 1 : 0} 1 ${point(offset + fraction)}`;
        offset += (segment.weight ?? segment.value) / basis;
        const { label, action } = segmentAttributes(segment);
        return `<path class="segment" d="${path}" stroke="${groupColor(segment.group)}" stroke-width="28"
        fill="none" ${action ? `${action} role="button" tabindex="0" aria-label="${label}"` : ''}>
        <title>${label}</title></path>`;
      })
      .join('');
    return `<div class="donut-graphic"><svg viewBox="0 0 200 200" aria-label="Speicherverteilung">${slices}</svg>
      <div class="donut-center"><strong>${fmt(used)}</strong><span>Volume belegt</span></div></div>`;
  }

  function chart(run, overview) {
    const total = sums(run);
    const { measured, ranked, groups, summary } = overview;
    const comparison = measured.some((item) => item.additive === false) ||
      [...summary.weights.values()].some((volume) => volume.measured > volume.used + 1);
    const showFree =
      prefs.free === 'show' || (prefs.free === 'auto' && !selected);
    const segments = chartSegments(ranked, groups, total, measured, summary, showFree);
    const basis = segments.reduce((sum, segment) => sum + (segment.weight ?? segment.value), 0);
    const donut = prefs.chart === 'donut';
    const label = rankingLabel();
    const subtitle = comparison
      ? `${label} nach Messwert · mögliche Überschneidungen`
      : showFree
        ? `${label} nach Einzelgröße · gesamte Kapazität`
        : `${label} nach Einzelgröße · belegter Speicher`;
    const diagram = !basis
      ? '<div class="empty">Keine Werte für das Diagramm.</div>'
      : donut
        ? `<div class="donut-layout">${renderDonut(segments, basis, total.used)}
        <div class="donut-cards"><div class="group-grid">${groupCards(run, overview)}</div></div></div>`
        : renderBar(segments, basis, total);
    const note = '„Nicht erfasst“ zeigt die Differenz zwischen Belegung und Summe der Messwerte je Volume.' +
      (comparison ? ' Gemeinsam genutzte Btrfs-Blöcke können mehrfach in den Messwerten stehen.' : '');
    return `<section class="panel chart-panel"><div class="section-head"><div><h3>Speicherverteilung</h3><p>${subtitle}</p></div>
      <div class="segmented"><button data-chart="bar" class="${donut ? '' : 'active'}">Balken</button>
      <button data-chart="donut" class="${donut ? 'active' : ''}">Torte</button></div></div>
      ${diagram}<p class="hint">${note}</p></section>`;
  }
  function volumeSummary(r) {
    if (volumeChoice !== 'all') return '';
    return `<div class="volume-strip">${volumes(r).map((v) => `
      <button class="volume-tile" data-volume="${esc(v.id)}" aria-label="${esc(v.name)} anzeigen">
        <span class="volume-heading"><span>${esc(v.name)} <small>${esc(v.fs || '')}</small></span><span class="volume-arrow" aria-hidden="true">▶</span></span>
        <span class="volume-values"><strong>${fmt(v.used)} <small>von ${fmt(v.capacity)}</small></strong><small>${fmt(v.free)} frei</small></span>
        <span class="volume-meter"><i style="width:${pct(v.used, v.capacity)}%"></i></span>
      </button>`).join('')}</div>`;
  }
  function snapshotValue(bytes, metric) {
    if (bytes == null || !Number.isFinite(Number(bytes))) return 'Nicht ermittelt';
    return (metric === 'btrfs_qgroup_exclusive_lower_bound' ? '≥ ' : '') + fmt(bytes);
  }

  function snapshotBreakdown(run) {
    const all = items(run);
    const summaries = all.filter(isSnapshotSummary);
    if (!summaries.length) return '';
    const sections = summaries.map((summary) => {
      const volume = volumes(run).find((entry) => entry.id === summary.volumeId);
      let sources = snapshotSourceRows(all, summary);
      if (!sources.length) {
        sources = all.filter((item) => item.volumeId === summary.volumeId && item.group !== 'snapshots' && item.snapshotCount)
          .map((item) => ({ ...item, bytes: item.snapshotBytes, metric: item.snapshotMetric || 'btrfs_qgroup_exclusive_lower_bound' }));
      }
      const rows = sources.map((source) => `<tr><td><strong>${esc(source.name)}</strong><small>${esc(source.path || '')}</small></td>
        <td>${source.snapshotCount != null ? esc(source.snapshotCount) : '–'}</td>
        <td>${snapshotValue(source.bytes, source.metric)}</td></tr>`).join('');
      return `<div class="table-wrap"><table><thead><tr><th>Quelle auf ${esc(volume?.name || summary.volumeId)}</th><th>Snapshots</th><th>Nur in Snapshots</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="3">Keine Aufschlüsselung nach Quelle verfügbar</td></tr>'}
        <tr><td><strong>Volume gesamt</strong></td><td>${summary.snapshotCount != null ? esc(summary.snapshotCount) : '–'}</td>
        <td><strong>${snapshotValue(summary.bytes, summary.metric)}</strong></td></tr></tbody></table></div>`;
    }).join('');
    return `<section class="snapshot-breakdown"><div class="section-head"><div><h3>Snapshots nach Quell-Volume</h3>
      <p>≥ kennzeichnet eine Untergrenze aus exklusiven Qgroup-Werten.</p></div></div>${sections}</section>`;
  }
  function current() {
    const run = latest();
    const overview = rankedOverview(run);
    return (
      kpis(run) +
      volumeSummary(run) +
      chart(run, overview) +
      (prefs.chart === 'bar'
        ? `<div class="section-head cards-heading"><div><h3>Die größten Speicherposten</h3><p>Nach Einzelgröße gewählt und anschließend gruppiert.</p></div><span class="count">${rankingLabel()}</span></div><div class="group-grid">` +
          (groupCards(run, overview) ||
            '<div class="empty">Keine auswertbaren Einzelposten vorhanden.</div>') +
          '</div>'
        : '')
    );
  }

  function history() {
    const all = runs().filter((run) => !run.partial);
    const records = all.filter((run) => volumes(run).length);
    if (!records.length)
      return '<div class="empty">Für dieses Volume liegen keine Messstände vor.</div>';
    const chosen = records.find((run) => run.id === dateId) || records.at(-1);
    const overview = rankedOverview(chosen);
    const ranks = new Map(records.map((run) => [run.id, (run === chosen ? overview.measured : measuredItems(run)).slice(0, 5)]));
    const visible = ranks.get(chosen.id);
    const palette = ['#467bc5', '#35a3ae', '#8b79bb', '#d37e8c', '#c18a49'];
    const upper = Math.max(
      1,
      ...records.map((run) => sums(run).used),
      ...[...ranks.values()].flat().map((item) => item.bytes),
    );
    const w = 800,
      h = 215,
      left = 69,
      right = 22,
      bottom = 34,
      topPad = 15;
    const first = +new Date(records[0].at),
      last = +new Date(records.at(-1).at);
    const x = (run) =>
      left +
      (w - left - right) *
        (last > first ? (+new Date(run.at) - first) / (last - first) : 0.5);
    const y = (value) =>
      h - bottom - ((h - topPad - bottom) * Math.min(value, upper)) / upper;
    const ticks = [0, 0.25, 0.5, 0.75, 1]
      .map((fraction) => {
        const v = fraction * upper;
        return `<line x1="${left}" x2="${w - right}" y1="${y(v)}" y2="${y(v)}" stroke="#e1eaef"/>
        <text x="0" y="${y(v) + 4}">${esc(fmt(v))}</text>`;
      })
      .join('');
    const trace = (
      points,
      color,
      dash = '',
    ) => `<polyline points="${points.join(' ')}" fill="none"
      stroke="${color}" stroke-width="${dash ? 2 : 3}" ${dash ? 'stroke-dasharray="5 3"' : ''}/>`;
    const occupied = trace(
      records.map((run) => `${x(run)},${y(sums(run).used)}`),
      '#176e83',
    );
    const lines = visible
      .map((item, index) => {
        let points = [];
        const result = [];
        const color = palette[index];
        for (const run of records) {
          const observed = ranks
            .get(run.id)
            .find((entry) => entry.id === item.id);
          if (observed) {
            const cx = x(run),
              cy = y(observed.bytes);
            points.push(`${cx},${cy}`);
            result.push(
              `<circle cx="${cx}" cy="${cy}" r="2.5" fill="${color}"/>`,
            );
          } else if (points.length) {
            result.push(trace(points, color, true));
            points = [];
          }
        }
        if (points.length) result.push(trace(points, color, true));
        return result.join('');
      })
      .join('');
    const markers = records
      .map((run) => {
        const label = esc(
          date(run.at) + ' · ' + fmt(sums(run).used) + ' belegt',
        );
        const active = run.id === chosen.id;
        return `<circle data-run="${esc(run.id)}" cx="${x(run)}" cy="${y(sums(run).used)}"
        r="${active ? 6.5 : 4.5}" fill="#176e83" stroke="#fff" stroke-width="2" role="button" tabindex="0"
        aria-pressed="${active}" aria-label="${label}"><title>${label}</title></circle>`;
      })
      .join('');
    const formatTick = new Intl.DateTimeFormat('de-DE', {
      month: 'short',
      day: 'numeric',
    });
    const dateLabels =
      records.length === 1 ? [chosen] : [records[0], records.at(-1)];
    const labels = dateLabels
      .map(
        (run, i) => `<text x="${x(run)}" y="${h - 10}"
      text-anchor="${dateLabels.length === 1 ? 'middle' : i === 0 ? 'start' : 'end'}">${formatTick.format(new Date(run.at))}</text>`,
      )
      .join('');
    const legend = visible
      .map(
        (item, i) =>
          `<span><i style="background:${palette[i]}"></i>${esc(itemLabel(item))}</span>`,
      )
      .join('');
    const choices = records
      .slice()
      .reverse()
      .map(
        (run) => `<option value="${esc(run.id)}"
      ${chosen.id === run.id ? 'selected' : ''}>${esc(date(run.at))}</option>`,
      )
      .join('');
    return `<section class="panel"><div class="section-head"><div><h3>Belegung im Zeitverlauf</h3>
      <p>Volume-Belegung und die fünf größten Posten der ausgewählten Erhebung. Eine Linie erscheint an Zeitpunkten, an denen der Posten in den Top 5 lag.</p>
      </div></div><div class="history-chart"><svg viewBox="0 0 ${w} ${h}" aria-label="Zeitverlauf der Belegung">
      ${ticks}${occupied}${lines}${labels}${markers}</svg></div>
      <div class="legend"><span><i style="background:#176e83"></i>Belegt</span>${legend}</div>
      <div class="date-picker"><label>Erhebung auswählen <select id="date-select">${choices}</select></label></div></section>
      <div class="section-head cards-heading"><div><h3>${rankingLabel()} zur ausgewählten Erhebung</h3>
      <p>${esc(date(chosen.at))}</p></div></div><div class="group-grid">
      ${groupCards(chosen, overview) || '<div class="empty">Keine Einzelposten vorhanden.</div>'}</div>`;
  }
  function details() {
    const metrics = {
      physical: 'Belegte Blöcke',
      allocated_blocks: 'Dateiblöcke',
      stat_blocks: 'Dateiblöcke',
      logical: 'Logische Größe',
      virtual_mount: 'Virtuelle Ansicht',
      docker_image: 'Docker-Image-Größe',
      btrfs_snapshot: 'Btrfs-Snapshot',
      btrfs_snapshot_data: 'Snapshot-Daten',
      btrfs_qgroup: 'Btrfs-Qgroup',
      btrfs_qgroup_exclusive: 'Btrfs-Qgroup, exklusiv',
      btrfs_qgroup_exclusive_lower_bound: 'Btrfs-Qgroup, Untergrenze',
      unknown: 'Offen',
    };
    const run = latest();
    const all = items(run);
    const groups = new Set(all.map((item) => item.group));
    const { sort } = prefs;
    const detailGroup = groups.has(prefs.detailGroup)
      ? prefs.detailGroup
      : 'all';
    const breakdown = detailGroup === 'snapshots' ? snapshotBreakdown(run) : '';
    const summaryIds = new Set(breakdown ? all.filter(isSnapshotSummary).map((item) => item.id) : []);
    const list = all.filter((item) =>
      (detailGroup === 'all' || item.group === detailGroup) &&
      !summaryIds.has(item.id) && !(summaryIds.has(item.parentId) && isSnapshotSource(item)));
    list.sort(function (a, b) {
      if (sort === 'size')
        return (Number(b.bytes) || 0) - (Number(a.bytes) || 0);
      return String(
        sort === 'name' ? a.name : names[a.group] || a.group,
      ).localeCompare(
        String(sort === 'name' ? b.name : names[b.group] || b.group),
        'de',
      );
    });
    return (
      '<section class="panel"><div class="section-head"><div><h3>Alle erfassten Werte</h3><p>Die Messbasis zeigt, wie der Wert ermittelt wurde.</p></div><label>Sortieren <select id="sort"><option value="size" ' +
      (sort === 'size' ? 'selected' : '') +
      '>Größe</option><option value="name" ' +
      (sort === 'name' ? 'selected' : '') +
      '>Name</option><option value="group" ' +
      (sort === 'group' ? 'selected' : '') +
      '>Gruppe</option></select></label></div><div class="filters">' +
      [
        ['all', 'Alle'],
        ['shares', 'Freigaben'],
        ['apps', 'Apps'],
        ['vmm', 'VMM'],
        ['docker', 'Docker'],
        ['snapshots', 'Snapshots'],
        ['other', 'Weitere'],
      ]
        .filter(([group]) => group === 'all' || groups.has(group))
        .map(function (x) {
          return (
            '<button data-detail="' +
            x[0] +
            '" class="' +
            (detailGroup === x[0] ? 'active' : '') +
            '">' +
            x[1] +
            '</button>'
          );
        })
        .join('') +
      '</div>' + breakdown + '<div class="table-wrap"><table><thead><tr><th>Name / Pfad</th><th>Gruppe</th><th>Messbasis</th><th>Größe</th></tr></thead><tbody>' +
      list
        .map(function (i) {
          return (
            '<tr><td><strong>' +
            esc(i.name) +
            '</strong><small>' +
            esc(i.path || '') +
            '</small>' +
            (i.note ? '<small>' + esc(i.note) + '</small>' : '') +
            (i.snapshotCount
              ? '<small>Snapshots · ' +
                esc(i.snapshotCount) +
                (i.snapshotBytes != null
                  ? ' · ' +
                    snapshotValue(i.snapshotBytes, i.snapshotMetric || 'btrfs_qgroup_exclusive_lower_bound') +
                    ' Snapshot-Daten (' +
                    esc(i.measuredSnapshots) +
                    '/' +
                    esc(i.snapshotCount) +
                    ' gemessen)'
                  : '') +
                '</small>'
              : '') +
            (i.sharedBytes != null
              ? '<small>Gemeinsam genutzt · ' + fmt(i.sharedBytes) + '</small>'
              : '') +
            (i.exclusiveBytes != null && i.exclusiveBytes !== i.bytes
              ? '<small>Exklusiv · ' + fmt(i.exclusiveBytes) + '</small>'
              : '') +
            (i.referencedBytes != null
              ? '<small>Referenziert · ' + fmt(i.referencedBytes) + '</small>'
              : '') +
            '</td><td>' +
            esc(names[i.group] || i.group) +
            '</td><td>' +
            esc(i.metric === 'btrfs_snapshot_data' && i.exclusiveBytes != null
              ? 'Snapshot-Daten, exklusiv' : metrics[i.metric] || i.metric || '–') +
            '</td><td>' +
            (i.metric === 'btrfs_qgroup_exclusive_lower_bound' && i.bytes != null ? '≥ ' : '') + fmt(i.bytes) +
            '</td></tr>'
          );
        })
        .join('') +
      '</tbody></table></div>' +
      (list.length
        ? ''
        : `<div class="empty">Keine ${breakdown ? 'Einzelwerte' : 'Werte'} für diese Auswahl.</div>`) +
      '</section>'
    );
  }
  function systemInfo() {
    const info = data.hardware;
    if (!info) return '<section class="panel"><h3>System &amp; Speicher</h3><p>Die Informationen werden bei der nächsten Datenerfassung ermittelt.</p></section>';
    const devices = Array.isArray(info.devices) ? info.devices : [];
    const disks = devices.filter((d) => d.kind === 'disk');
    const parts = devices.filter((d) => d.kind === 'partition');
    const raids = devices.filter((d) => d.kind === 'raid');
    const mappers = devices.filter((d) => d.kind === 'mapper');
    const usb = disks.filter((d) => d.transport === 'usb');
    const memberOf = (name) => raids.filter((r) => (r.members || []).includes(name)).map((r) => r.name);
    const raidColors = ['#218b91', '#467bc5', '#8b79bb', '#c98254', '#7e9f58', '#bb7693', '#6c90a1'];
    const partitionColor = (p) => p.free ? '#e1e9ed' : p.raids?.length ? raidColors[raids.findIndex((r) => r.name === p.raids[0]) % raidColors.length] : '#a5b8c1';
    const card = (title, value, ...details) => `<div class="system-card"><span>${esc(title)}</span><strong>${esc(value)}</strong>${details.map((detail) => `<small>${esc(detail)}</small>`).join('')}</div>`;
    const usbText = usb.length ? usb.map((d) => `${d.name} · ${d.model || 'USB-Laufwerk'} · ${fmt(d.size)}`).join(' | ') : 'Kein USB-Laufwerk erkannt';
    const bars = (disk, scale) => {
      let end = 0;
      const segments = [];
      parts.filter((p) => p.parent === disk.name).sort((a,b) => a.start - b.start).forEach((p) => {
        if (p.start > end) segments.push({name:'Nicht partitioniert', start:end, size:p.start-end, free:true});
        segments.push({name:p.name, start:p.start, size:p.size, raids:memberOf(p.name)});
        end = Math.max(end, p.start + p.size);
      });
      if (disk.size > end) segments.push({name:'Nicht partitioniert', start:end, size:disk.size-end, free:true});
      if (!disk.size) return '<p class="hint">Größe nicht verfügbar.</p>';
      return `<div class="disk-bar" style="width:${pct(disk.size, scale || disk.size)}%" aria-label="Partitionen von ${esc(disk.name)}">${segments.map((p) => {
        const label = `${p.name} · ${fmt(p.size)}${p.raids?.length ? ' · ' + p.raids.join(', ') : ''}`;
        return `<span class="disk-segment${p.free ? '' : ' disk-segment-partition'}" style="width:${pct(p.size, disk.size)}%;background:${partitionColor(p)}" title="${esc(label)}" aria-label="${esc(label)}"></span>`;
      }).join('')}</div><div class="disk-parts">${segments.filter((p) => !p.free || p.size > 1024 * 1024).map((p) => `<span><i style="background:${partitionColor(p)}"></i>${esc(p.name)} · ${fmt(p.size)}${p.raids?.length ? ' · ' + esc(p.raids.join(', ')) : ''}</span>`).join('')}</div>`;
    };
    const topology = window.SynoUsageTopology.build(info);
    const overviewGroups = topology.groups.map((group) => {
      const scale = Math.max(...group.disks.map((disk) => Number(disk.size) || 0), 0);
      const title = group.raids.length ? group.raids.map((raid) => `${raid.name} · ${raid.level || 'RAID'}`).join(' + ') : 'Ohne erkannte RAID-Zuordnung';
      const lvmLabel = group.volumeGroups.length ? 'LVM: ' + group.volumeGroups.join(', ') : '';
      const volumeLabels = group.volumes.length ? group.volumes.map((mount) => `<span class="storage-volume">Verbunden: ${esc(mount.replace(/^\//, ''))}</span>`).join('') : '<span class="storage-unknown">Volume-Zuordnung nicht ermittelt</span>';
      const entries = group.disks.map((disk) => `<article class="disk-card"><div class="disk-head"><strong>${esc(disk.name)}${disk.model ? ' · ' + esc(disk.model) : ''}${disk.medium ? ' · ' + esc(disk.medium) : ''}</strong><span>${fmt(disk.size)}</span></div>${bars(disk, scale)}</article>`).join('');
      return `<div class="storage-group"><div class="storage-group-head"><strong>${esc(title)}</strong><span class="storage-relations">${lvmLabel ? `<small>${esc(lvmLabel)}</small>` : ''}${volumeLabels}</span></div><div class="disk-list">${entries || '<p class="hint">Mitgliedslaufwerke nicht eindeutig erkannt.</p>'}</div></div>`;
    }).join('');
    const raidRows = raids.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.level || '–')}</td><td>${fmt(r.size)}</td><td>${esc((r.members || []).join(', ') || '–')}</td><td>${esc((r.mounts || []).join(', ') || r.state || '–')}</td></tr>`).join('');
    const mapperRows = mappers.map((m) => `<tr><td>${esc(m.label || m.name)} <small>(${esc(m.name)})</small></td><td>${fmt(m.size)}</td><td>${esc((m.members || []).join(', ') || '–')}</td><td>${esc((m.mounts || []).join(', ') || '–')}</td></tr>`).join('');
    const pvRows = (info.pvs || []).map((v) => `<tr><td>${esc(v.name)}</td><td>${esc(v.group || '–')}</td><td>${fmt(v.size)}</td><td>${fmt(v.free)}</td></tr>`).join('');
    const lvRows = (info.lvm || []).map((v) => `<tr><td>${esc(v.group + ' / ' + v.name)}</td><td>${fmt(v.size)}</td><td>${esc(v.devices || '–')}</td></tr>`).join('');
    const vmRows = (latest()?.items || []).filter((item) => item.group === 'vmm' && item.parentId).map((item) => `<tr><td>${esc(item.name)}</td><td>${esc(item.volumeId)}</td><td>${esc(item.path || '–')}</td><td>${fmt(item.bytes)}</td></tr>`).join('');
    const volumeItems = latest()?.items || [];
    const measuredFileBlocks = (item) => item.bytes != null && ['allocated_blocks', 'physical'].includes(item.metric);
    const parentsWithDetails = new Set(volumeItems.filter((item) => item.parentId && item.group === 'apps' && measuredFileBlocks(item)).map((item) => item.parentId));
    const topForVolume = (volumeId, group) => {
      const totals = new Map();
      volumeItems.filter((item) => item.volumeId === volumeId && item.group === group && measuredFileBlocks(item) &&
        (group === 'shares' ? !item.parentId : !parentsWithDetails.has(item.id)))
        .forEach((item) => totals.set(item.name, (totals.get(item.name) || 0) + Number(item.bytes)));
      return [...totals].sort((a,b) => b[1] - a[1]).slice(0, 3);
    };
    const topList = (items) => items.length ? `<ul class="volume-top-list">${items.map(([name, size]) => `<li><span>${esc(name)}</span><strong>${fmt(size)}</strong></li>`).join('')}</ul>` : '<p class="hint">Keine Werte erfasst.</p>';
    const volumeCards = (latest()?.volumes || []).map((volume) => `<article class="disk-card volume-detail-card"><div class="disk-head"><strong>${esc(volume.name || volume.id)}</strong><span>${fmt(volume.used)} belegt · ${fmt(volume.capacity)} gesamt</span></div><div class="volume-top-columns"><div><h4>Größte Freigaben</h4>${topList(topForVolume(volume.id, 'shares'))}</div><div><h4>Größte App-Posten</h4>${topList(topForVolume(volume.id, 'apps'))}</div></div></article>`).join('');
    const cpuDetail = [info.cpus ? info.cpus + ' logische Prozessoren' : 'Prozessoranzahl nicht verfügbar', info.maxMHz ? 'max. ' + (info.maxMHz / 1000).toLocaleString('de-DE', {maximumFractionDigits: 2}) + ' GHz' : 'Maximaltakt nicht verfügbar'].join(' · ');
    const root = info.root;
    const rootView = root ? `<div class="system-root-values"><strong>${fmt(root.used)} belegt</strong><span>von ${fmt(root.capacity)} · ${fmt(root.free)} verfügbar</span></div><div class="volume-meter"><i style="width:${pct(root.used,root.capacity)}%"></i></div>` : '<p class="hint">Die Größe und Belegung konnten nicht ermittelt werden.</p>';
    const layouts = info.partitionLayouts ? `<details class="partition-layouts"><summary>Verfügbare Synology-Partitionsvorlagen</summary><p class="hint">Ausgabe von synopartition --list. Die Liste beschreibt mögliche Layouts; sie weist nicht automatisch das aktuell verwendete Layout aus.</p><pre>${esc(info.partitionLayouts)}</pre></details>` : '';
    const dsm = info.dsm ? 'DSM ' + info.dsm : 'DSM-Version nicht verfügbar';
    const kernel = info.kernel ? 'Linux-Kernel ' + info.kernel : 'Linux-Kernelversion nicht verfügbar';
    return `<div class="system-cards">${card('System', info.model || 'Nicht verfügbar', dsm, kernel)}${card('CPU', info.cpu || 'Nicht verfügbar', cpuDetail)}${card('Arbeitsspeicher', info.memory ? fmt(info.memory) : 'Nicht verfügbar', 'Vom Betriebssystem nutzbar · RAM-Riegel: nicht ermittelt')}${card('USB-Laufwerke', usbText, 'Interner Bootspeicher nur bei eindeutiger Erkennung zuordenbar')}</div>
      <section class="panel storage-overview"><div class="section-head"><div><h3>Speicheraufbau</h3><p>Laufwerke nach erkannten RAID- und LVM-Verbindungen gruppiert. Die Balken sind innerhalb eines Verbunds proportional zur Laufwerksgröße; sehr kleine Partitionen werden zur Sichtbarkeit breiter dargestellt.</p></div></div>${overviewGroups || '<p class="hint">Keine Laufwerke erkannt.</p>'}<p class="hint">Ein Laufwerk kann in mehreren Verbünden erscheinen. System- und Swap-Arrays können Laufwerke mehrerer Verbünde gemeinsam nutzen. „Verbunden“ beschreibt den Gerätepfad; eine Cache-Funktion wird nicht automatisch angenommen. Nicht partitionierter Platz ist nicht automatisch nutzbarer Pool-Speicher.</p></section>
      <section class="panel system-section system-root"><h3>Systempartition /</h3>${rootView}<p class="hint">Dateisystemgröße und Belegung; die Größe des zugrunde liegenden RAID-Arrays steht unten.</p>${layouts}</section>
      <section class="panel system-section"><h3>Volumes</h3><p class="hint">Jeweils die drei größten erkannten Freigaben und App-Posten; Messwerte können gemeinsam genutzte Blöcke enthalten.</p><div class="disk-list">${volumeCards || '<p class="hint">Keine Volumes erfasst.</p>'}</div></section>
      <section class="panel system-section"><h3>RAID-Arrays</h3><p class="hint">Mitglieder sind Partitionen. Die RAID-Größe ist nicht die Summe ihrer Mitglieder.</p><div class="table-wrap"><table><thead><tr><th>Array</th><th>Typ</th><th>Größe</th><th>Mitglieder</th><th>Mount / Zustand</th></tr></thead><tbody>${raidRows || '<tr><td colspan="5">Keine Arrays erkannt.</td></tr>'}</tbody></table></div></section>
      <section class="panel system-section"><h3>LVM und Gerätezuordnung</h3>
        <p class="hint">LVM-Volumengruppen fassen erkannte physische Volumes zusammen. Geräte ohne eindeutige Zuordnung bleiben separat aufgeführt.</p>
        <section class="mapping-section"><h4>Physische Volumes (PV)</h4><div class="table-wrap"><table><thead><tr><th>Gerät</th><th>Gruppe</th><th>Größe</th><th>Frei im PV</th></tr></thead><tbody>${pvRows || '<tr><td colspan="4">Keine LVM-Volumes erkannt.</td></tr>'}</tbody></table></div></section>
        <section class="mapping-section"><h4>Logische Volumes (LV)</h4><div class="table-wrap"><table><thead><tr><th>Gruppe / Volume</th><th>Größe</th><th>Geräte</th></tr></thead><tbody>${lvRows || '<tr><td colspan="3">Keine logischen Volumes erkannt.</td></tr>'}</tbody></table></div></section>
        <section class="mapping-section"><h4>Device Mapper</h4><div class="table-wrap"><table><thead><tr><th>Gerät</th><th>Größe</th><th>Untergeordnete Geräte</th><th>Mount</th></tr></thead><tbody>${mapperRows || '<tr><td colspan="4">Keine Device-Mapper-Geräte erkannt.</td></tr>'}</tbody></table></div></section>
        ${(info.warnings || []).map((w) => `<p class="hint">${esc(w)}</p>`).join('')}<p class="hint">Stand der Hardwareerfassung: ${esc(date(info.at))}</p></section>
      <section class="panel system-section"><h3>Erkannte VM-Datenträger</h3><p class="hint">Zuordnung nach dem bei der Erfassung gefundenen Ablagepfad.</p><div class="table-wrap"><table><thead><tr><th>Datenträger</th><th>Volume</th><th>Pfad</th><th>Messwert</th></tr></thead><tbody>${vmRows || '<tr><td colspan="4">Keine VM-Datenträger erkannt.</td></tr>'}</tbody></table></div></section>`;
  }
  let groupResizeObserver;
  function observeGroupCards() {
    groupResizeObserver?.disconnect();
    const grid = content.querySelector('.group-grid');
    if (!grid || typeof ResizeObserver !== 'function') return;
    const cards = [...grid.querySelectorAll(':scope > .group-card')];
    if (cards.length < 2) return;

    function placeCards() {
      if (!grid.isConnected) return;
      const width = grid.getBoundingClientRect().width;
      if (!width) return;
      const style = getComputedStyle(grid);
      const columns = Math.min(cards.length, style.gridTemplateColumns.trim().split(/\s+/).length);
      const gap = Number.parseFloat(style.columnGap);
      grid.classList.toggle('packed', columns > 1);
      if (columns < 2) return;

      const cardWidth = (width - gap * (columns - 1)) / columns;
      grid.style.setProperty('--group-card-width', `${cardWidth}px`);
      const heights = cards.map((card) => card.getBoundingClientRect().height);
      const nextTop = Array(columns).fill(0);
      for (const [index, card] of cards.entries()) {
        const top = Math.min(...nextTop);
        const column = nextTop.indexOf(top);
        card.style.setProperty('--group-card-left', `${column * (cardWidth + gap)}px`);
        card.style.setProperty('--group-card-top', `${top}px`);
        nextTop[column] = top + heights[index] + gap;
      }
      grid.style.setProperty('--group-grid-height', `${Math.max(...nextTop) - gap}px`);
    }

    placeCards();
    groupResizeObserver = new ResizeObserver(() => requestAnimationFrame(placeCards));
    groupResizeObserver.observe(grid);
    cards.forEach((card) => groupResizeObserver.observe(card));
  }

  let mountedPage;

  async function loadTasks() {
    if (isPreview) return window.SynoUsageDemo.tasks();
    const result = await window.SynoUsageDSM.timeline();
    if (!demo) window.SynoUsageTaskData.addMeasurements(result, runs(), data.status);
    return result;
  }

  function render() {
    const run = data && latest();
    if (!run) return;
    fillVolumes();
    $('#demo-badge').hidden = page === 'tasks' ? !isPreview : !demo;
    var title = {
      current: ['Speicherübersicht', 'Kapazität und größte Speicherposten'],
      history: ['Verlauf', 'Entwicklung und frühere Erhebungen vergleichen.'],
      tasks: ['Aufgaben', 'Arbeitszeiten, Laufzeiten und geplante Starts'],
      details: ['Details', 'Messwerte und ihre Grundlagen im Überblick.'],
      info: ['System & Speicher', 'Hardware, Partitionen und Speicheraufbau'],
    }[page];
    $('#page-title').textContent = title[0];
    $('#page-subtitle').textContent = title[1];
    $('#volume-filter-label').hidden = page === 'info' || page === 'tasks';
    document.querySelectorAll('.nav').forEach(function (b) {
      b.classList.toggle('active', b.dataset.page === page);
      if (b.dataset.page === page) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    if (page === 'tasks') {
      if (mountedPage !== page) window.SynoUsageTasks.mount(content, {load: loadTasks, demo: isPreview});
    } else {
      content.innerHTML =
        page === 'current'
          ? current()
          : page === 'history'
            ? history()
            : page === 'details' ? details() : systemInfo();
    }
    mountedPage = page;
    observeGroupCards();
    const duration = formatDuration(run.durationSeconds);
    $('#header-stand').textContent =
      (demo ? 'Beispielstand: ' : run.partial ? 'Teilstand: ' : 'Stand: ') + date(run.at) +
      (duration ? ' · Dauer: ' + duration : '');
    $('#header-version').textContent = window.SynoUsageBuild?.version
      ? 'Version ' + window.SynoUsageBuild.version
      : 'Vorschau';
    statusDisplay();
  }
  function showToast(message) {
    var t = $('#toast');
    t.textContent = message;
    t.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(function () {
      t.hidden = true;
    }, 4500);
  }
  const settingFields = {
    'start-view': 'start',
    'start-volume': 'startVolume',
    'chart-mode': 'chart',
    'free-mode': 'free',
    'top-count': 'topCount',
    'group-sort': 'groupSort',
    'mini-bars': 'mini',
    subdivide: 'subdivide',
  };
  function syncSettings() {
    for (const [id, key] of Object.entries(settingFields)) {
      const field = $('#' + id);
      if (field.type === 'checkbox') field.checked = !!prefs[key];
      else field.value = prefs[key];
    }
    $('#start-volume-label').hidden = prefs.start !== 'volume';
  }

  let demoTask = 'missing';
  let connected = false;
  let pendingUntil = 0;
  let controlPending = '';
  let controlRun = '';
  let pendingRun;
  let loading = false;
  let polling = false;
  let taskStatusRequest = 0;
  const isPreview = location.protocol === 'file:';
  const phases = {
    discover: 'Volumes ermitteln',
    scan: 'Datenpfade messen',
    retry_pending: 'Zeitlimit erreicht · erneute Messung vorgemerkt',
    retry: 'Datenpfad erneut messen',
    snapshots: 'Snapshots auswerten',
    docker: 'Docker-Images erfassen',
  };

  async function taskStatus() {
    const requestId = ++taskStatusRequest;
    const label = $('#task-status');
    const fallback = $('#task-script');
    const disabledNote = $('#task-disabled-note');
    disabledNote.hidden = true;
    $('#task-register').disabled = true;
    $('#task-register').dataset.available = 'false';
    $('#task-update').hidden = true;
    $('#task-scheduler').hidden = isPreview;
    fallback.hidden = true;
    if (isPreview) {
      $('#task-update-hint').hidden = true;
      label.textContent =
        demoTask === 'missing'
          ? 'Vorschau · Die Erfassungsaufgabe fehlt.'
          : 'Vorschau · Die Erfassungsaufgabe ist aktuell.';
      $('#task-register').dataset.available = String(demoTask === 'missing');
      $('#task-register').disabled = demoTask !== 'missing';
      disabledNote.hidden = demoTask !== 'ready';
      return;
    }
    label.textContent = 'Aufgabe wird geprüft …';
    try {
      const scheduler = window.SynoUsageDSM;
      const result = await scheduler.status();
      if (requestId !== taskStatusRequest) return;
      label.textContent = [result.message, result.schedule]
        .filter(Boolean)
        .join(' · ');
      disabledNote.hidden = result.scheduleEnabled !== false;
      $('#task-register').dataset.available = String(result.state === 'missing');
      $('#task-register').disabled = result.state !== 'missing';
      $('#task-update').hidden = result.state !== 'outdated';
      $('#task-update-hint').hidden = result.state !== 'outdated';
      if (
        result.state === 'unavailable' ||
        result.state === 'missing' ||
        result.state === 'outdated'
      ) {
        $('#task-command').value = scheduler.taskScript();
        fallback.hidden = false;
      }
    } catch (error) {
      if (requestId !== taskStatusRequest) return;
      if (label.textContent === 'Aufgabe wird geprüft …')
        label.textContent = error.message;
      fallback.hidden = true;
    }
  }

  async function taskAction(action) {
    if (isPreview) {
      demoTask = 'ready';
      showToast('Registrierung in der Vorschau gezeigt.');
      await taskStatus();
      return;
    }
    const buttons = document.querySelectorAll(
      '#task-register,#task-update,#task-scheduler',
    );
    buttons.forEach((button) => {
      button.disabled = true;
    });
    try {
      const result = await window.SynoUsageDSM[action]();
      showToast(result.message);
      if (action !== 'openScheduler') await taskStatus();
    } catch (error) {
      showToast(error.message || 'Die Aktion ist fehlgeschlagen.');
      if (action !== 'openScheduler') await taskStatus();
    } finally {
      buttons.forEach((button) => {
        button.disabled = false;
      });
      $('#task-register').disabled = $('#task-register').dataset.available !== 'true';
    }
  }

  async function update() {
    if (busy || controlPending || pendingUntil > Date.now()) return;
    if (data.status?.state === 'running') {
      if (data.status.canCancel) await controlScan('restart');
      return;
    }
    if (isPreview) {
      const startedAt = new Date().toISOString();
      data.status = {
        state: 'running',
        phase: 'scan',
        startedAt,
        current: 'Volume 1',
        done: 1,
        total: 2,
        message: 'Demo-Erfassung läuft',
        log: ['Vorschau gestartet', 'Volume 1 wird gemessen'],
      };
      statusDisplay();
      setTimeout(() => {
        data.status = {
          ...data.status,
          state: 'complete',
          current: '',
          done: 2,
          message: 'Demo-Erfassung abgeschlossen',
          updatedAt: new Date().toISOString(),
          log: [...data.status.log, '2 Beispiel-Volumes erfasst'],
        };
        statusDisplay();
        showToast(data.status.message);
      }, 1800);
      return;
    }
    busy = true;
    statusDisplay();
    try {
      const result = await window.SynoUsageDSM.start();
      pendingRun = data.status?.runId;
      pendingUntil = Date.now() + 30_000;
      showToast(result.message);
      await poll();
    } catch (error) {
      showToast(error.message || 'Erfassung fehlgeschlagen.');
      taskStatus();
    } finally {
      busy = false;
      statusDisplay();
    }
  }

  async function controlScan(action) {
    if (busy || controlPending || !data.status?.canCancel || !data.status.runId) return;
    const runId = data.status.runId;
    busy = true;
    statusDisplay();
    try {
      await window.SynoUsageDSM.controlScan(action, runId);
      controlPending = action;
      controlRun = runId;
      showToast(action === 'restart' ? 'Neustart angefordert.' : 'Abbruch angefordert.');
      await poll();
    } catch (error) {
      showToast(error.message || 'Die Aktion ist fehlgeschlagen.');
      await poll();
    } finally {
      busy = false;
      statusDisplay();
    }
  }

  function statusDisplay() {
    const status = data?.status || {};
    if (
      pendingUntil &&
      (pendingUntil <= Date.now() ||
        status.state === 'running' ||
        (status.runId && status.runId !== pendingRun))
    )
      pendingUntil = 0;
    if (controlPending && (status.runId !== controlRun || status.state !== 'running')) controlPending = '';
    const pending = pendingUntil > 0;
    const running = status.state === 'running';
    const failed = status.state === 'failed' && !pending;
    const run = latest();
    const currentRun = !status.runId || status.runId === run?.id;
    const warnings = !demo && currentRun ? [...(run?.warnings || [])] : [];
    const missing = !demo && currentRun ? (run?.items || []).filter((item) =>
      !item.parentId && item.bytes == null && (item.note || '').includes('Belegung konnte nicht ermittelt werden')
    ) : [];
    for (const item of missing) {
      const message = `${item.path}: ${item.note}`;
      if (!warnings.includes(message)) warnings.push(message);
    }
    const incomplete = !running && !pending && !failed && warnings.length > 0;
    const title = controlPending
      ? (controlPending === 'restart' ? 'Neustart angefordert' : 'Abbruch angefordert')
      : pending
      ? 'Start angefordert'
      : running
        ? 'Erfassung läuft'
        : failed
          ? 'Erfassung fehlgeschlagen'
          : status.state === 'cancelled'
            ? 'Erfassung abgebrochen'
          : status.state === 'complete'
            ? (incomplete ? 'Erfassung mit Hinweisen' : 'Erfassung abgeschlossen')
            : isPreview
              ? 'Vorschau'
              : connected
                ? 'Bereit zur Erfassung'
                : 'DSM-Verbindung fehlt';
    const progress = [
      phases[status.phase] || status.phase,
      status.current,
      status.total > 0
        ? `${status.done || 0} / ${status.total}${running ? ' geprüft' : ''}`
        : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const summary =
      (running ? progress : '') || (pending ? '' : status.message) || title;

    $('#connection').textContent = '● ' + title;
    $('#connection').dataset.state =
      !isPreview && !connected
        ? 'offline'
        : pending
          ? 'running'
          : incomplete ? 'warning' : status.state || 'idle';
    $('#refresh').disabled = busy || pending || !!controlPending || (running && !status.canCancel);
    $('#refresh').textContent = running && status.canCancel ? '↻  Erfassung neu starten' : '↻  Daten aktualisieren';
    $('#run-cancel').hidden = !(running && status.canCancel);
    $('#run-cancel').disabled = busy || !!controlPending;
    $('#rail-status').textContent = summary;
    const notice = $('#notice');
    notice.hidden = !(
      running ||
      pending ||
      !!latest()?.partial ||
      failed ||
      incomplete ||
      (!isPreview && !connected)
    );
    notice.textContent =
      !isPreview && !connected
        ? 'DSM-Verbindung fehlt. Zuletzt geladener Stand.'
        : latest()?.partial && !running ? 'Teilergebnis der Erfassung' : incomplete ? `Erfassung unvollständig oder mit Hinweisen · ${warnings.length} ${warnings.length === 1 ? 'Hinweis' : 'Hinweise'} · Status oben öffnen` : title +
          ((running || failed) && summary !== title ? ' · ' + summary : '');
    $('#run-phase').textContent = [
      title,
      running ? progress : '',
      pending ? '' : status.message,
      status.startedAt ? 'Start ' + date(status.startedAt) : '',
      status.updatedAt ? 'Stand ' + date(status.updatedAt) : '',
    ]
      .filter(Boolean)
      .join(' · ');
    $('#run-log').textContent =
      (status.log || []).join('\n') ||
      'Bisher sind keine Laufmeldungen vorhanden.';
    $('#run-warnings').hidden = warnings.length === 0;
    $('#run-warnings').textContent = warnings.join('\n');
  }

  async function request(view = '') {
    const response = await window.SynoUsageDSM.cgiRequest(view, 12_000);
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response.json();
  }

  async function poll() {
    if (isPreview || loading || polling) return;
    polling = true;
    try {
      const previous = data.status || {};
      const result = await request('?view=status');
      const wasConnected = connected;
      connected = true;
      const status = result.status || {};
      data.status = status;
      if (!wasConnected ||
          (status.runId && previous.runId && status.runId !== previous.runId) ||
          (['complete', 'cancelled', 'failed'].includes(status.state) && status.runId &&
            (status.runId !== previous.runId || status.state !== previous.state))) {
        await load();
      } else if (status.checkpoint &&
          (status.checkpoint !== previous.checkpoint || status.runId !== previous.runId)) {
        const live = await request('?view=current');
        data.status = live.status || status;
        data.user = live.user || data.user;
        data.current = live.current;
        if (live.current && demo) {
          demo = false;
          data.runs = [];
          selected = null;
          dateId = null;
        }
        render();
      } else {
        if (data.current && status.runId && data.current.id !== status.runId) data.current = undefined;
        statusDisplay();
      }
    } catch (_) {
      connected = false;
      statusDisplay();
    } finally {
      polling = false;
    }
  }

  async function load() {
    if (loading) return;
    if (isPreview) {
      render();
      return;
    }
    loading = true;
    try {
      const result = await request();
      connected = true;
      if (demo && (result.runs?.length || result.current)) {
        selected = null;
        dateId = null;
      }
      demo = !result.runs?.length && !result.current;
      data = {
        ...result,
        runs: demo ? window.SynoUsageDemo.runs : result.runs,
      };
    } catch (_) {
      connected = false;
    } finally {
      loading = false;
      render();
    }
  }

  data = { ...window.SynoUsageDemo, status: { state: 'idle' }, user: '' };
  demo = true;
  if (prefs.start === 'all') prefs.volume = 'all';
  else if (prefs.start === 'volume') prefs.volume = prefs.startVolume || 'all';
  document.querySelectorAll('.nav').forEach(function (b) {
    b.addEventListener('click', function () {
      page = b.dataset.page;
      selected = null;
      render();
    });
  });
  $('#volume-filter').addEventListener('change', function (e) {
    prefs.volume = e.target.value;
    selected = null;
    save();
    render();
  });
  $('#refresh').addEventListener('click', update);
  $('#settings-open').addEventListener('click', function () {
    syncSettings();
    $('#settings').showModal();
    taskStatus();
  });
  $('#task-update-hint').addEventListener('click', function () {
    syncSettings();
    $('#settings').showModal();
    taskStatus();
  });
  $('#settings-close').addEventListener('click', function () {
    $('#settings').close();
  });
  $('#settings-done').addEventListener('click', function () {
    $('#settings').close();
  });
  $('#task-register').addEventListener('click', function () {
    taskAction('register');
  });
  $('#task-update').addEventListener('click', function () {
    taskAction('update');
  });
  $('#task-scheduler').addEventListener('click', function () {
    taskAction('openScheduler');
  });
  for (const [id, key] of Object.entries(settingFields)) {
    $('#' + id).addEventListener('change', function (e) {
      prefs[key] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
      if (key === 'topCount') selected = null;
      save();
      syncSettings();
      render();
    });
  }

  $('#connection').addEventListener('click', () =>
    $('#run-dialog').showModal(),
  );
  $('#run-close').addEventListener('click', () => $('#run-dialog').close());
  $('#run-cancel').addEventListener('click', () => controlScan('cancel'));

  function choose(el) {
    const choice = el.dataset;
    if (choice.volume) {
      prefs.volume = choice.volume;
      selected = null;
      save();
    } else if (choice.chart) {
      prefs.chart = choice.chart;
      save();
    } else if (choice.detail) {
      prefs.detailGroup = choice.detail;
      save();
    } else if (choice.run) {
      dateId = choice.run;
      selected = null;
    } else if (choice.item || choice.group) {
      const id = choice.item || 'group:' + choice.group;
      selected = selected === id ? null : id;
    } else {
      return;
    }
    const restoreFocus = document.activeElement === el;
    render();
    if (restoreFocus) {
      const attribute = [
        'volume',
        'chart',
        'detail',
        'run',
        'item',
        'group',
      ].find((key) => choice[key]);
      const nodes = Array.from(
        content.querySelectorAll('[data-' + attribute + ']'),
      );
      const same = (node) => node.dataset[attribute] === choice[attribute];
      const target =
        nodes.find(
          (node) =>
            same(node) &&
            node.classList.contains('segment') ===
              el.classList.contains('segment'),
        ) || nodes.find(same);
      target?.focus({ preventScroll: true });
    }
  }
  content.addEventListener('click', (event) => {
    const element = event.target.closest('button,[role="button"]');
    if (element) choose(element);
  });
  content.addEventListener('keydown', (event) => {
    if (
      event.target.matches('svg [role="button"]') &&
      ['Enter', ' '].includes(event.key)
    ) {
      event.preventDefault();
      choose(event.target);
    }
  });
  content.addEventListener('change', (event) => {
    if (event.target.id === 'date-select') {
      dateId = event.target.value;
      selected = null;
      render();
      $('#date-select')?.focus({ preventScroll: true });
    } else if (event.target.id === 'sort') {
      prefs.sort = event.target.value;
      save();
      render();
      $('#sort')?.focus({ preventScroll: true });
    }
  });
  const markable = '[data-item],[data-group]';
  content.addEventListener('mouseover', (event) => {
    const hovered = event.target.closest(markable);
    if (!hovered) return;
    const { item, group } = hovered.dataset;
    content.querySelectorAll(markable).forEach((element) => {
      const match = item
        ? element.dataset.item === item ||
          (!element.dataset.item && !element.classList.contains('segment') && element.dataset.group === group)
        : element.dataset.group === group;
      element.classList.toggle('highlight', match);
    });
  });
  content.addEventListener('mouseout', (event) => {
    if (
      event.target.closest(markable) ===
      event.relatedTarget?.closest?.(markable)
    )
      return;
    content
      .querySelectorAll('.highlight')
      .forEach((element) => element.classList.remove('highlight'));
  });
  render();
  load();
  taskStatus();
  setInterval(poll, 5000);
})();
