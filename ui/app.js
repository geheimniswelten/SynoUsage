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
    return r[r.length - 1];
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
  function top(r) {
    return items(r)
      .filter(
        (item) =>
          !item.parentId &&
          Number.isFinite(item.bytes) &&
          item.bytes > 0 &&
          item.metric !== 'logical' &&
          item.metric !== 'virtual_mount',
      )
      .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name, 'de'))
      .slice(0, 20);
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
    var s = sums(r);
    return (
      '<div class="kpis"><div class="kpi"><span>Gesamtkapazität</span><strong>' +
      fmt(s.capacity) +
      '</strong><small>' +
      volumes(r).length +
      ' Volume' +
      (volumes(r).length === 1 ? '' : 's') +
      '</small></div><div class="kpi"><span>Belegt</span><strong>' +
      fmt(s.used) +
      '</strong><small>' +
      pct(s.used, s.capacity).toFixed(1).replace('.', ',') +
      ' % der Kapazität</small></div><div class="kpi"><span>Frei</span><strong>' +
      fmt(s.free) +
      '</strong><small>Verfügbarer Speicher</small></div></div>'
    );
  }
  function groupedItems(ranked) {
    const groups = new Map();
    ranked.forEach((item, index) => {
      if (!groups.has(item.group))
        groups.set(item.group, { key: item.group, bytes: 0, rows: [] });
      const group = groups.get(item.group);
      group.bytes += item.bytes;
      group.rows.push({ item, rank: index + 1 });
    });
    return [...groups.values()].sort((a, b) => b.bytes - a.bytes);
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

  function groupCards(run, ranked = top(run), groups = groupedItems(ranked)) {
    const maximum = ranked[0]?.bytes;
    return groups
      .map(
        ({ key, bytes, rows }) => `
      <article class="group-card">
        <button class="group-head" data-group="${esc(key)}" aria-pressed="${selectedItem(key)}">
          <span class="dot" style="background:${groupColor(key)}"></span>
          <span class="group-label"><strong>${esc(names[key] || key)}</strong><small>${rows.length} in den Top 20</small></span>
          <strong>${fmt(bytes)}</strong>
        </button>
        <div class="rows">${rows
          .map(({ item, rank }) => {
            const volume = run.volumes.find(
              (entry) => entry.id === item.volumeId,
            );
            return `<button class="item-row" data-item="${esc(item.id)}" data-group="${esc(key)}"
              aria-pressed="${Boolean(selectedItem(key, item.id))}">
            <span class="rank" aria-label="Platz ${rank}">${rank}</span>
            <span class="item-name">${esc(item.name)}
              ${volumeChoice === 'all' ? `<small>${esc(volume?.name || item.volumeId)}</small>` : ''}</span>
            <span class="item-value">${fmt(item.bytes)}</span>
            ${prefs.mini ? `<span class="mini"><i style="width:${pct(item.bytes, maximum)}%;background:${groupColor(key)}"></i></span>` : ''}
          </button>`;
          })
          .join('')}</div>
      </article>`,
      )
      .join('');
  }

  function chartSegments(ranked, groups, total, comparison, showFree) {
    const segments = groups.flatMap(({ key, bytes, rows }) =>
      prefs.subdivide
        ? rows.map(({ item }) => ({
            group: key,
            id: item.id,
            name: item.name,
            value: item.bytes,
          }))
        : [{ group: key, name: names[key] || key, value: bytes }],
    );
    if (!comparison) {
      const known = ranked.reduce((sum, item) => sum + item.bytes, 0);
      const rest = Math.max(0, total.used - known);
      const reserved = Math.max(0, total.capacity - total.used - total.free);
      if (rest)
        segments.push({
          group: 'remainder',
          name: 'Übrige Belegung',
          value: rest,
        });
      if (showFree && reserved)
        segments.push({
          group: 'reserved',
          name: 'Reserviert',
          value: reserved,
        });
      if (showFree && total.free)
        segments.push({ group: 'free', name: 'Frei', value: total.free });
    }
    return segments;
  }

  function segmentAttributes(segment) {
    const { group, id, name, value } = segment;
    const label = esc(name + ' · ' + fmt(value));
    const action = ['free', 'remainder', 'reserved'].includes(group)
      ? ''
      : `data-group="${esc(group)}" ${id ? `data-item="${esc(id)}"` : ''}
      aria-pressed="${Boolean(selectedItem(group, id))}"`;
    return { label, action };
  }

  function renderBar(segments, basis) {
    return `<div class="stack" aria-label="Speicherverteilung">${segments
      .map((segment) => {
        const { label, action } = segmentAttributes(segment);
        const style = `width:${pct(segment.value, basis)}%;background:${groupColor(segment.group)}`;
        if (!action)
          return `<span class="segment" title="${label}" style="${style}"></span>`;
        return `<button class="segment" ${action} title="${label}" aria-label="${label}" style="${style}"></button>`;
      })
      .join(
        '',
      )}</div><div class="bar-caption"><span>0</span><span>Basis: ${fmt(basis)}</span></div>`;
  }

  function renderDonut(segments, basis, used) {
    const point = (turn) => {
      const angle = turn * 2 * Math.PI - Math.PI / 2;
      return `${100 + 72 * Math.cos(angle)},${100 + 72 * Math.sin(angle)}`;
    };
    let offset = 0;
    const slices = segments
      .map((segment) => {
        const fraction = Math.min(0.999999, segment.value / basis);
        const path = `M ${point(offset)} A 72 72 0 ${fraction > 0.5 ? 1 : 0} 1 ${point(offset + fraction)}`;
        offset += segment.value / basis;
        const { label, action } = segmentAttributes(segment);
        return `<path class="segment" d="${path}" stroke="${groupColor(segment.group)}" stroke-width="28"
        fill="none" ${action ? `${action} role="button" tabindex="0" aria-label="${label}"` : ''}>
        <title>${label}</title></path>`;
      })
      .join('');
    return `<div class="donut-graphic"><svg viewBox="0 0 200 200" aria-label="Speicherverteilung">${slices}</svg>
      <div class="donut-center"><strong>${fmt(used)}</strong><span>Volume belegt</span></div></div>`;
  }

  function chart(run) {
    const total = sums(run);
    const ranked = top(run);
    const groups = groupedItems(ranked);
    const known = ranked.reduce((sum, item) => sum + item.bytes, 0);
    const comparison =
      ranked.some((item) => item.additive === false) || known > total.used + 1;
    const showFree =
      prefs.free === 'show' || (prefs.free === 'auto' && !selected);
    const segments = chartSegments(ranked, groups, total, comparison, showFree);
    const basis = segments.reduce((sum, segment) => sum + segment.value, 0);
    const donut = prefs.chart === 'donut';
    const subtitle = comparison
      ? 'Top 20 nach Messwert · mögliche Überschneidungen'
      : showFree
        ? 'Top 20 nach Einzelgröße · gesamte Kapazität'
        : 'Top 20 nach Einzelgröße · belegter Speicher';
    const capacity =
      comparison && showFree
        ? `<div class="capacity-context"><span>Volume-Belegung</span>
      <span class="volume-meter"><i style="width:${pct(total.used, total.capacity)}%"></i></span>
      <span>${fmt(total.free)} frei</span></div>`
        : '';
    const diagram = !basis
      ? '<div class="empty">Keine Werte für das Diagramm.</div>'
      : donut
        ? `<div class="donut-layout">${renderDonut(segments, basis, total.used)}
        <div class="donut-cards"><div class="group-grid">${groupCards(run, ranked, groups)}</div></div></div>`
        : renderBar(segments, basis);
    const note = comparison
      ? 'Gemeinsam genutzte Blöcke können in mehreren Posten auftauchen. Die Belegung des Dateisystems steht oben.'
      : 'Die Gruppen enthalten Posten aus den Top 20. Weitere Segmente zeigen die übrige Belegung' +
        (showFree ? ' und den freien Platz.' : '.');
    return `<section class="panel chart-panel"><div class="section-head"><div><h3>Speicherverteilung</h3><p>${subtitle}</p></div>
      <div class="segmented"><button data-chart="bar" class="${donut ? '' : 'active'}">Balken</button>
      <button data-chart="donut" class="${donut ? 'active' : ''}">Torte</button></div></div>
      ${capacity}${diagram}<p class="hint">${note}</p></section>`;
  }
  function volumeSummary(r) {
    if (volumeChoice !== 'all') return '';
    return (
      '<div class="volume-strip">' +
      volumes(r)
        .map(function (v) {
          return (
            '<button class="volume-tile" data-volume="' +
            esc(v.id) +
            '"><span>' +
            esc(v.name) +
            ' <small>' +
            esc(v.fs || '') +
            '</small></span><strong>' +
            fmt(v.used) +
            ' <small>von ' +
            fmt(v.capacity) +
            '</small></strong><span class="volume-meter"><i style="width:' +
            pct(v.used, v.capacity) +
            '%"></i></span><small>' +
            fmt(v.free) +
            ' frei &nbsp; →</small></button>'
          );
        })
        .join('') +
      '</div>'
    );
  }
  function current() {
    var r = latest();
    return (
      kpis(r) +
      volumeSummary(r) +
      chart(r) +
      (prefs.chart === 'bar'
        ? '<div class="section-head cards-heading"><div><h3>Die größten Speicherposten</h3><p>Nach Einzelgröße gewählt und anschließend gruppiert.</p></div><span class="count">TOP 20</span></div><div class="group-grid">' +
          (groupCards(r) ||
            '<div class="empty">Keine auswertbaren Einzelposten vorhanden.</div>') +
          '</div>'
        : '')
    );
  }

  function history() {
    const all = runs();
    const records = all.filter((run) => volumes(run).length);
    if (!records.length)
      return '<div class="empty">Für dieses Volume liegen keine Messstände vor.</div>';
    const chosen = records.find((run) => run.id === dateId) || records.at(-1);
    const ranks = new Map(records.map((run) => [run.id, top(run).slice(0, 5)]));
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
          `<span><i style="background:${palette[i]}"></i>${esc(item.name)}</span>`,
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
      <div class="section-head cards-heading"><div><h3>Top 20 zur ausgewählten Erhebung</h3>
      <p>${esc(date(chosen.at))}</p></div></div><div class="group-grid">
      ${groupCards(chosen) || '<div class="empty">Keine Einzelposten vorhanden.</div>'}</div>`;
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
      btrfs_qgroup: 'Btrfs-Qgroup',
      btrfs_qgroup_exclusive: 'Btrfs-Qgroup, exklusiv',
      btrfs_qgroup_exclusive_lower_bound: 'Btrfs-Qgroup, Untergrenze',
      unknown: 'Offen',
    };
    const all = items(latest());
    const groups = new Set(all.map((item) => item.group));
    const { sort } = prefs;
    const detailGroup = groups.has(prefs.detailGroup)
      ? prefs.detailGroup
      : 'all';
    const list = all.filter(function (i) {
      return detailGroup === 'all' || i.group === detailGroup;
    });
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
      '</div><div class="table-wrap"><table><thead><tr><th>Name / Pfad</th><th>Gruppe</th><th>Messbasis</th><th>Größe</th></tr></thead><tbody>' +
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
                  ? ' · mindestens ' +
                    fmt(i.snapshotBytes) +
                    ' exklusiv (' +
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
            esc(metrics[i.metric] || i.metric || '–') +
            '</td><td>' +
            fmt(i.bytes) +
            '</td></tr>'
          );
        })
        .join('') +
      '</tbody></table></div>' +
      (list.length
        ? ''
        : '<div class="empty">Keine Werte für diese Auswahl.</div>') +
      '</section>'
    );
  }
  function render() {
    if (!data || !latest()) return;
    fillVolumes();
    $('#demo-badge').hidden = !demo;
    var title = {
      current: ['Speicherübersicht', 'Kapazität und größte Speicherposten'],
      history: ['Verlauf', 'Entwicklung und frühere Erhebungen vergleichen.'],
      details: ['Details', 'Messwerte und ihre Grundlagen im Überblick.'],
    }[page];
    $('#page-title').textContent = title[0];
    $('#page-subtitle').textContent = title[1];
    document.querySelectorAll('.nav').forEach(function (b) {
      b.classList.toggle('active', b.dataset.page === page);
      if (b.dataset.page === page) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    content.innerHTML =
      page === 'current'
        ? current()
        : page === 'history'
          ? history()
          : details();
    $('#footer-info').textContent =
      (demo ? 'Beispielstand · ' : 'Letzte Erfassung · ') +
      date(latest().at) +
      (data.user ? ' · ' + data.user : '');
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
  function syncSettings() {
    ['start-view', 'start-volume', 'chart-mode', 'free-mode'].forEach(
      function (id) {
        $('#' + id).value =
          prefs[
            {
              'start-view': 'start',
              'start-volume': 'startVolume',
              'chart-mode': 'chart',
              'free-mode': 'free',
            }[id]
          ];
      },
    );
    $('#start-volume-label').hidden = prefs.start !== 'volume';
    $('#mini-bars').checked = !!prefs.mini;
    $('#subdivide').checked = !!prefs.subdivide;
  }

  let demoTask = 'missing';
  let connected = false;
  let pendingUntil = 0;
  let pendingRun;
  let loading = false;
  let polling = false;
  const isPreview = location.protocol === 'file:';
  const phases = {
    discover: 'Volumes ermitteln',
    scan: 'Datenpfade messen',
    snapshots: 'Snapshots auswerten',
    docker: 'Docker-Images erfassen',
  };

  async function taskStatus() {
    const label = $('#task-status');
    const fallback = $('#task-script');
    $('#task-register').hidden = true;
    $('#task-update').hidden = true;
    $('#task-scheduler').hidden = isPreview;
    fallback.hidden = true;
    if (isPreview) {
      label.textContent =
        demoTask === 'missing'
          ? 'Vorschau · Die Erfassungsaufgabe fehlt.'
          : 'Vorschau · Die Erfassungsaufgabe ist aktuell.';
      $('#task-register').hidden = demoTask !== 'missing';
      return;
    }
    label.textContent = 'Aufgabe wird geprüft …';
    try {
      const scheduler = window.SynoUsageDSM;
      const result = await scheduler.status();
      label.textContent = [result.message, result.schedule]
        .filter(Boolean)
        .join(' · ');
      $('#task-register').hidden = result.state !== 'missing';
      $('#task-update').hidden = result.state !== 'outdated';
      if (
        result.state === 'unavailable' ||
        result.state === 'missing' ||
        result.state === 'outdated'
      ) {
        $('#task-command').value = scheduler.taskScript();
        fallback.hidden = false;
      }
    } catch (error) {
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
    }
  }

  async function update() {
    if (busy || data.status?.state === 'running' || pendingUntil > Date.now())
      return;
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
    const pending = pendingUntil > 0;
    const running = status.state === 'running';
    const failed = status.state === 'failed' && !pending;
    const title = pending
      ? 'Start angefordert'
      : running
        ? 'Erfassung läuft'
        : failed
          ? 'Erfassung fehlgeschlagen'
          : status.state === 'complete'
            ? 'Erfassung abgeschlossen'
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
          : status.state || 'idle';
    $('#refresh').disabled = busy || pending || running;
    $('#rail-status').textContent = summary;
    const notice = $('#notice');
    notice.hidden = !(
      running ||
      pending ||
      failed ||
      (!isPreview && !connected)
    );
    notice.textContent =
      !isPreview && !connected
        ? 'DSM-Verbindung fehlt. Zuletzt geladener Stand.'
        : title +
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
    const warnings = demo ? [] : latest()?.warnings || [];
    $('#run-warnings').hidden = warnings.length === 0;
    $('#run-warnings').textContent = warnings.join('\n');
  }

  async function request(view = '') {
    const response = await fetch('./api.cgi' + view, {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response.json();
  }

  async function poll() {
    if (isPreview || loading || polling) return;
    polling = true;
    try {
      const result = await request('?view=status');
      const wasConnected = connected;
      connected = true;
      data.status = result.status;
      statusDisplay();
      if (
        !wasConnected ||
        (result.status?.state === 'complete' &&
          result.status.runId &&
          result.status.runId !== latest()?.id)
      )
        await load();
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
      if (demo && result.runs?.length) {
        selected = null;
        dateId = null;
      }
      demo = !result.runs?.length;
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
  [
    ['start-view', 'start'],
    ['start-volume', 'startVolume'],
    ['chart-mode', 'chart'],
    ['free-mode', 'free'],
    ['mini-bars', 'mini'],
    ['subdivide', 'subdivide'],
  ].forEach(function (pair) {
    $('#' + pair[0]).addEventListener('change', function (e) {
      prefs[pair[1]] =
        e.target.type === 'checkbox' ? e.target.checked : e.target.value;
      save();
      syncSettings();
      render();
    });
  });

  $('#connection').addEventListener('click', () =>
    $('#run-dialog').showModal(),
  );
  $('#run-close').addEventListener('click', () => $('#run-dialog').close());

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
      const match =
        item && element.dataset.item
          ? element.dataset.item === item
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
  setInterval(poll, 5000);
})();
