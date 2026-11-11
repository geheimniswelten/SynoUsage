(function () {
  'use strict';
  const key = 'synousage.tasks.v1';
  const days = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  function readPrefs(storageKey) {
    try {
      const value = JSON.parse(localStorage.getItem(storageKey));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (_) {
      return {};
    }
  }

  function savePrefs(storageKey, p) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(p));
    } catch (_) {}
  }

  function duration(seconds) {
    const s = Math.max(0, Math.round(seconds));
    const h = Math.floor(s / 3600),
      m = Math.floor(s % 3600 / 60),
      rest = s % 60;
    return [h && h + ' h', (m || !h) && m + ' min', rest && rest + ' s'].filter(Boolean).join(' ');
  }

  function mount(root, options) {
    const {clock: makeClock, shiftDate, weekday} = window.SynoUsageTaskTime;
    const storageKey = key + (options.demo ? '.demo' : '');
    const prefs = readPrefs(storageKey);
    if (Array.isArray(prefs.hours)) {
      prefs.hours = days.map((_, i) => {
        const entry = prefs.hours[i];
        if (!Array.isArray(entry) || entry.length !== 2) return ['', ''];
        const validTime = value => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
        return validTime(entry[0]) && validTime(entry[1]) && entry[0] < entry[1] ? entry : ['', ''];
      });
    } else {
      delete prefs.hours;
    }
    if (options.demo && !Array.isArray(prefs.hours)) prefs.hours = [
      ['09:00', '17:00'],
      ['09:00', '17:00'],
      ['09:00', '17:00'],
      ['09:00', '17:00'],
      ['09:00', '17:00'],
      ['', ''],
      ['', '']
    ];
    let data = {
      runs: [],
      plans: [],
      notes: []
    };
    let error = '';
    let loading = false;
    const wrap = el('section', 'task-view panel');
    root.replaceChildren(wrap);
    const controls = el('div', 'task-controls');

    function select(label, values, value) {
      const l = el('label', 'select-label', label);
      const s = el('select');
      values.forEach(([v, t]) => {
        const o = el('option', '', t);
        o.value = v;
        s.append(o);
      });
      s.value = values.some(x => x[0] === value) ? value : values[0][0];
      l.append(s);
      controls.append(l);
      return s;
    }
    const period = select('Zeitraum', [
      ['plan', 'Diese und nächste Woche'],
      ['today', 'Heute'],
      ['7', 'Letzte 7 Tage'],
      ['14', 'Letzte 14 Tage']
    ], prefs.period);
    const filter = select('Gespeicherte Läufe', [
      ['long', 'Längste Läufe ab 5 min'],
      ['overlap', 'Überschneidungen ab 5 min']
    ], prefs.filter);
    const refresh = el('button', 'button secondary', 'Aktualisieren');
    refresh.type = 'button';
    controls.append(refresh);
    wrap.append(controls);
    const message = el('p', 'task-message');
    message.setAttribute('role', 'status');
    wrap.append(message);
    const legend = el('div', 'task-legend');
    [
      ['task-work', 'Arbeitszeit'],
      ['task-run', 'Gespeicherter Lauf'],
      ['task-work-overlap', 'Lauf in Arbeitszeit'],
      ['task-overlap', 'Aufgabenüberschneidung ab 5 min'],
      ['task-plan', 'Geplanter Start']
    ].forEach(([c, t]) => {
      const item = el('span');
      item.append(el('i', c), document.createTextNode(t));
      legend.append(item);
    });
    wrap.append(legend);
    const axis = el('div', 'task-axis task-row');
    axis.append(el('span', '', 'Aufgabe'), el('div', 'task-ticks'));
    wrap.append(axis);
    const rows = el('div', 'task-rows');
    rows.setAttribute('role', 'group');
    rows.setAttribute('aria-label', 'Zeitachse der Aufgaben');
    wrap.append(rows);
    const notes = el('div', 'task-notes');
    wrap.append(notes);
    const editor = el('form', 'task-hours');
    editor.hidden = true;
    editor.id = 'task-hours-editor';
    editor.append(el('h3', '', 'Wöchentliche Arbeitszeiten'), el('p', '', 'Zeiten gelten in der angezeigten Zeitzone. Leere Tage bleiben frei. Die Angaben werden in diesem Browser gespeichert.'));
    const fields = [];
    days.forEach((day, i) => {
      const line = el('div', 'task-hours-day');
      line.append(el('strong', '', day));
      const inputs = [];
      ['Von', 'Bis'].forEach((caption, j) => {
        const label = el('label', '', caption);
        const input = el('input');
        input.type = 'time';
        input.setAttribute('aria-label', `${day} ${caption.toLowerCase()}`);
        input.value = Array.isArray(prefs.hours) && prefs.hours[i] ? prefs.hours[i][j] || '' : '';
        label.append(input);
        line.append(label);
        inputs.push(input);
      });
      fields.push(inputs);
      editor.append(line);
    });
    const validation = el('p', 'task-validation');
    validation.setAttribute('role', 'alert');
    editor.append(validation);
    const actions = el('div', 'button-row');
    const save = el('button', 'button primary', 'Arbeitszeiten speichern');
    save.type = 'submit';
    const cancel = el('button', 'button secondary', 'Abbrechen');
    cancel.type = 'button';
    actions.append(save, cancel);
    editor.append(actions);
    function closeEditor() {
      editor.hidden = true;
      validation.textContent = '';
      const edit = rows.querySelector('.task-edit');
      edit?.setAttribute('aria-expanded', 'false');
      edit?.focus();
    }
    cancel.addEventListener('click', () => {
      fields.forEach((pair, i) => pair.forEach((input, j) => {
        input.value = (prefs.hours && prefs.hours[i] && prefs.hours[i][j]) || '';
      }));
      closeEditor();
    });
    editor.addEventListener('submit', event => {
      event.preventDefault();
      const values = fields.map(pair => pair.map(input => input.value));
      if (values.some(([a, b]) => (!!a !== !!b) || (a && a >= b))) {
        validation.textContent = 'Bitte für jeden Arbeitstag Beginn und Ende angeben. Das Ende muss am selben Tag nach dem Beginn liegen.';
        return;
      }
      prefs.hours = values;
      prefs.hoursEdited = true;
      savePrefs(storageKey, prefs);
      editor.hidden = true;
      render();
      closeEditor();
    });

    function settingsChanged() {
      prefs.period = period.value;
      prefs.filter = filter.value;
      savePrefs(storageKey, prefs);
      render();
    }
    period.addEventListener('change', settingsChanged);
    filter.addEventListener('change', settingsChanged);
    refresh.addEventListener('click', load);
    async function load() {
      loading = true;
      refresh.disabled = true;
      message.dataset.state = 'loading';
      message.textContent = 'Aufgaben werden geladen …';
      try {
        const result = await options.load();
        data = result || {};
        error = '';
      } catch (_) {
        error = 'Aufgabendaten konnten nicht geladen werden. Die zuletzt geladenen Daten bleiben sichtbar. Bitte erneut versuchen.';
      } finally {
        loading = false;
        refresh.disabled = false;
        render();
      }
    }

    function render() {
      const now = Number.isFinite(data.now) ? data.now : Date.now() / 1000;
      const clock = makeClock(data.timeZone);
      const zone = clock.timeZone;
      const current = clock.civil(now);
      const monday = shiftDate(current, -((weekday(current) + 6) % 7));
      let low = now - Number(period.value) * 86400;
      let high = now;
      if (period.value === 'plan') {
        low = clock.epoch(monday);
        high = clock.epoch(shiftDate(monday, 14));
      } else if (period.value === 'today') {
        low = clock.epoch(shiftDate(current, 0));
        high = clock.epoch(shiftDate(current, 1));
      }
      if (low === null || high === null || high <= low) {
        message.dataset.state = 'error';
        message.textContent = 'Der Zeitraum kann für diese Zeitzone nicht dargestellt werden.';
        return;
      }
      const fmt = new Intl.DateTimeFormat('de-DE', {
        timeZone: zone,
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
      const short = new Intl.DateTimeFormat('de-DE', period.value === 'today' ? {
        timeZone: zone,
        hour: '2-digit',
        minute: '2-digit'
      } : {
        timeZone: zone,
        day: '2-digit',
        month: '2-digit'
      });
      const at = t => fmt.format(t * 1000);
      const pos = t => Math.max(0, Math.min(100, 100 * (t - low) / (high - low)));
      const runs = (Array.isArray(data.runs) ? data.runs : []).filter(r => r && Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start && r.end > low && r.start < high);
      const overlapRuns = runs.filter(r => r.end - r.start >= 300).sort((a, b) => a.start - b.start);
      const overlaps = [];
      overlapRuns.forEach((a, i) => {
        for (let j = i + 1; j < overlapRuns.length && overlapRuns[j].start <= a.end - 300; j++) {
          const b = overlapRuns[j];
          if (a.id === b.id) continue;
          const start = Math.max(a.start, b.start, low),
            end = Math.min(a.end, b.end, high);
          if (end - start >= 300) overlaps.push({
            a,
            b,
            start,
            end
          });
        }
      });
      const matching = filter.value === 'overlap' ? overlapRuns.filter(r => overlaps.some(o => o.a === r || o.b === r)) : overlapRuns.slice().sort((a, b) => (b.end - b.start) - (a.end - a.start));
      const visible = filter.value === 'long' ? matching.slice(0, 10) : matching;
      const work = [];
      const firstDay = clock.civil(low);
      for (let i = 0; i <= 14; i++) {
        const day = shiftDate(firstDay, i);
        const entry = prefs.hours?.[(weekday(day) + 6) % 7];
        if (!entry || !entry[0] || !entry[1]) continue;
        const [fromHour, fromMinute] = entry[0].split(':').map(Number);
        const [toHour, toMinute] = entry[1].split(':').map(Number);
        const start = clock.epoch({...day, hour: fromHour, minute: fromMinute});
        const end = clock.epoch({...day, hour: toHour, minute: toMinute});
        if (start !== null && end !== null && end > start && end > low && start < high) work.push({start, end});
      }
      message.dataset.state = error ? 'error' : 'loading';
      message.textContent = error || (loading ? 'Aufgaben werden geladen …' : '');
      const ticks = axis.lastChild;
      ticks.replaceChildren();
      [0, .25, .5, .75, 1].forEach(ratio => {
        const tick = el('span', '', short.format((low + ratio * (high - low)) * 1000));
        tick.style.left = ratio * 100 + '%';
        ticks.append(tick);
      });
      const focusedField = editor.contains(document.activeElement) ? document.activeElement : null;
      rows.replaceChildren();

      function row(title, detail) {
        const box = el('div', 'task-row task-timeline-row');
        const caption = el('div', 'task-caption');
        caption.append(el('strong', '', title), el('small', '', detail));
        const track = el('div', 'task-track');
        box.append(caption, track);
        rows.append(box);
        return {
          caption,
          track
        };
      }

      function interval(track, start, end, cls, label) {
        const mark = el('span', 'task-mark ' + cls);
        mark.style.left = pos(start) + '%';
        mark.style.width = (pos(end) - pos(start)) + '%';
        mark.title = label;
        mark.setAttribute('role', 'img');
        mark.setAttribute('aria-label', label);
        track.append(mark);
      }
      const workDays = days.flatMap((day, i) => {
        const interval = prefs.hours?.[i];
        return interval?.[0] ? [`${day.slice(0, 2)} ${interval.join('–')}`] : [];
      });
      const configured = workDays.length > 0;
      if (configured && options.demo && !prefs.hoursEdited) workDays.push('Beispiel');
      const office = row('Meine Arbeitszeiten', configured ? workDays.join(' · ') : 'Noch keine Arbeitszeiten hinterlegt');
      const edit = el('button', 'task-edit', configured ? 'Arbeitszeiten ändern' : 'Arbeitszeiten festlegen');
      edit.type = 'button';
      edit.setAttribute('aria-controls', editor.id);
      edit.setAttribute('aria-expanded', String(!editor.hidden));
      edit.addEventListener('click', () => {
        editor.hidden = false;
        edit.setAttribute('aria-expanded', 'true');
        fields[0][0].focus();
      });
      office.caption.append(edit);
      rows.append(editor);
      if (!editor.hidden) focusedField?.focus({preventScroll: true});
      work.forEach(w => interval(office.track, w.start, w.end, 'task-work', 'Arbeitszeit ' + at(w.start) + ' – ' + at(w.end)));
      visible.forEach(run => {
        const approx = run.approximate ? '≈ ' : '';
        const detail = at(run.start) + ' – ' + at(run.end) + ' · ' + approx + duration(run.end - run.start) + (run.status ? ' · ' + run.status : '');
        const r = row(String(run.name || 'Unbenannte Aufgabe'), detail);
        interval(r.track, run.start, run.end, 'task-run', detail);
        work.forEach(w => {
          const start = Math.max(w.start, run.start, low),
            end = Math.min(w.end, run.end, high);
          if (end > start) interval(r.track, start, end, 'task-work-overlap', 'In Arbeitszeit ' + at(start) + ' – ' + at(end) + ' · ' + duration(end - start));
        });
        overlaps.filter(o => o.a === run || o.b === run).forEach(o => interval(r.track, o.start, o.end, 'task-overlap', 'Mit ' + (o.a === run ? o.b.name : o.a.name) + ' · ' + at(o.start) + ' – ' + at(o.end) + ' · ' + duration(o.end - o.start)));
      });
      if (!visible.length) rows.append(el('p', 'task-empty', 'Keine passenden gespeicherten Läufe im gewählten Zeitraum.'));
      else if (matching.length > visible.length) rows.append(el('p', 'task-empty', (matching.length - visible.length) + ' weitere passende Läufe sind ausgeblendet.'));
      const plans = ['plan', 'today'].includes(period.value) ? (data.plans || [])
        .filter(plan => Number.isFinite(plan.start) && plan.start >= now && plan.start < high)
        .sort((a, b) => a.start - b.start) : [];
      if (plans.length) rows.append(el('h3', 'task-plan-heading', 'Geplante Starts'));
      const groups = new Map();
      plans.forEach(plan => {
        const id = String(plan.id);
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id).push(plan);
      });
      groups.forEach(group => {
        const inWork = plan => work.some(interval => plan.start >= interval.start && plan.start < interval.end);
        const detail = plan => [at(plan.start), plan.detail, inWork(plan) ? 'In Arbeitszeit' : ''].filter(Boolean).join(' · ');
        const info = group.length === 1 ? detail(group[0]) : `${group.length} Starts · nächster am ${detail(group[0])}`;
        const r = row(String(group[0].name || 'Unbenannte Aufgabe'), info);
        group.forEach(plan => {
          const mark = el('span', inWork(plan) ? 'task-point task-plan task-plan-in-hours' : 'task-point task-plan');
          mark.style.left = pos(plan.start) + '%';
          mark.title = detail(plan);
          mark.setAttribute('role', 'img');
          mark.setAttribute('aria-label', mark.title);
          r.track.append(mark);
        });
      });
      notes.replaceChildren();
      const longest = overlaps.reduce((best, overlap) => !best || overlap.end - overlap.start > best.end - best.start ? overlap : best, null);
      if (longest) notes.append(el('p', 'task-overlap-summary', `Längste Überschneidung · ${longest.a.name} und ${longest.b.name} · ${duration(longest.end - longest.start)}`));
      notes.append(el('p', '', 'Zeitzone ' + zone + '. Für Aufgabenüberschneidungen zählen gespeicherte Laufzeiten.'));
      (Array.isArray(data.notes) ? data.notes : []).forEach(note => notes.append(el('p', '', String(note))));
    }
    render();
    load();
  }
  window.SynoUsageTasks = {
    mount
  };
})();
