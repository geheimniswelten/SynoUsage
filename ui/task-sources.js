(function () {
  'use strict';

  const storageAPI = 'SYNO.Storage.CGI.Storage';
  const scanNames = {
    fullScan: 'Antivirus Essential · Vollständiger Scan',
    sysScan: 'Antivirus Essential · Systemscan',
    customScan: 'Antivirus Essential · Benutzerdefinierter Scan',
  };
  const daySeconds = 86400;

  function enabled(value) {
    return value === true || value === 1 || value === '1';
  }

  function timestamp(value) {
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 && number <= 253402300799
      ? number
      : null;
  }

  async function antivirusPlans(call, { now, clock }) {
    // The package represents weekdays as 0 (Sunday) through 6 and stores wall time.
    const data = await call('load', [1], {}, 'SYNO.AntiVirus.Schedule');
    if (!Array.isArray(data?.scheduleScanJobs)) throw new Error('scheduleScanJobs');
    const { shiftDate, weekday } = window.SynoUsageTaskTime;
    const today = clock.civil(now);
    const plans = new Map();
    for (const job of data.scheduleScanJobs) {
      if (!enabled(job?.activated) || !Object.hasOwn(scanNames, job.scanType)) continue;
      const match = typeof job.triggerTime === 'string' &&
        job.triggerTime.match(/^([0-6](?:,[0-6]){0,6}):(\d{1,2}):(\d{1,2})$/);
      if (!match) continue;
      const weekdays = new Set(match[1].split(',').map(Number));
      const hour = Number(match[2]), minute = Number(match[3]);
      if (hour > 23 || minute > 59) continue;
      for (let i = 0; i < 14; i++) {
        const date = shiftDate(today, i);
        if (!weekdays.has(weekday(date))) continue;
        const start = clock.epoch({ ...date, hour, minute });
        if (!Number.isFinite(start) || start < now) continue;
        const id = `antivirus:${job.scanType}`;
        plans.set(`${id}:${start}`, { id, name: scanNames[job.scanType], start });
      }
    }
    return { plans: [...plans.values()] };
  }

  function scanEvent(content) {
    if (typeof content !== 'string') return null;
    // Event text is rendered by the package server. Match the EN and DE
    // [log] scan_started, scan_completed and scan_terminated messages verbatim.
    const en = content.match(/^(Full|System|Custom) Scan (started|was complete|was stopped)\.$/);
    const de = content.match(/^(Vollständiger Scan|Systemscan|Benutzerdefinierter Scan) wurde (gestartet|abgeschlossen|gestoppt)\.$/);
    const match = en || de;
    if (!match) return null;
    const type = {
      Full: 'fullScan', System: 'sysScan', Custom: 'customScan',
      'Vollständiger Scan': 'fullScan', Systemscan: 'sysScan',
      'Benutzerdefinierter Scan': 'customScan',
    }[match[1]];
    const action = {
      started: 'start', 'was complete': 'completed', 'was stopped': 'stopped',
      gestartet: 'start', abgeschlossen: 'completed', gestoppt: 'stopped',
    }[match[2]];
    return { type, action };
  }

  async function antivirusRuns(call, { now, clock }) {
    const limit = 100;
    const maxPages = 5;
    const oldestVisible = now - 14 * daySeconds;
    const events = [];
    const known = new Set();
    const notes = [];
    for (let page = 0; page < maxPages; page++) {
      let data;
      try {
        data = await call('load', [1], {
          start: page * limit,
          limit,
          sort: 'date',
          dir: 'DESC',
          modules: ['scanner'],
          categories: ['warning', 'error', 'info', 'detected'],
        }, 'SYNO.AntiVirus.Log');
        if (!Array.isArray(data?.reportArray)) throw new Error('reportArray');
      } catch (error) {
        if (page === 0) throw error;
        notes.push('Das Antivirus-Protokoll konnte nur teilweise geladen werden.');
        break;
      }
      for (const entry of data.reportArray) {
        if (entry?.module !== 'scanner') continue;
        const event = scanEvent(entry.eventContent);
        if (!event) continue;
        const time = clock.parse(entry.date);
        if (!Number.isFinite(time) || time > now) continue;
        const key = entry.ID ?? `${event.type}:${event.action}:${time}`;
        if (known.has(key)) continue;
        known.add(key);
        const ambiguous = clock.parse(entry.date, { after: time + 1 }) !== null;
        events.push({ ...event, time, ambiguous });
      }
      const count = data.reportArray.length;
      const total = Number(data.reportCount);
      if (count < limit || (total > 0 && total <= (page + 1) * limit)) break;
      const oldest = clock.parse(data.reportArray.at(-1)?.date);
      if (Number.isFinite(oldest) && oldest < oldestVisible &&
          events.some(event => event.action === 'start' && event.time <= oldestVisible)) break;
      if (page === maxPages - 1) {
        notes.push('Für Antivirus Essential wurden die neuesten 500 Protokolleinträge geprüft.');
      }
    }

    // The package runs one scan at a time. An intervening start supersedes any
    // unmatched start, including a start of another scan type.
    const runs = [];
    let active = null;
    // Finish the earlier scan before recording a new start in the same second.
    for (const event of events.sort((a, b) => a.time - b.time ||
        Number(a.action === 'start') - Number(b.action === 'start'))) {
      if (event.action === 'start') {
        active = event;
      } else if (active?.type === event.type) {
        if (!active.ambiguous && !event.ambiguous &&
            event.time > active.time && event.time >= oldestVisible) {
          runs.push({
            id: `antivirus:${event.type}`,
            name: scanNames[event.type],
            start: active.time,
            end: event.time,
            status: event.action === 'stopped' ? 'Gestoppt' : 'Abgeschlossen',
          });
        }
        active = null;
      }
    }
    return { runs, notes };
  }

  function scrubStart(schedule, now, clock) {
    const earliest = timestamp(schedule.next_start_time);
    if (earliest === null || earliest < now || enabled(schedule.sche_is_running)) return null;
    if (schedule.run_time_option !== 'run_setting_time') return earliest;

    // Storage Manager uses one bit per NAS-local hour, starting Sunday at 00:00.
    const bitmap = schedule.schedule_plan;
    if (typeof bitmap !== 'string' || !/^[01]{168}$/.test(bitmap)) return null;
    const { shiftDate, weekday } = window.SynoUsageTaskTime;
    const civil = clock.civil(earliest);
    for (let i = 0; i <= 168; i++) {
      const offset = civil.hour + i;
      const day = shiftDate(civil, Math.floor(offset / 24));
      const hour = offset % 24;
      if (bitmap[weekday(day) * 24 + hour] !== '1') continue;
      if (i === 0) return earliest;
      const start = clock.epoch({ ...day, hour }, { after: earliest });
      if (Number.isFinite(start) && start >= earliest) return start;
    }
    return null;
  }

  async function scrubbingPlan(call, { now, clock }) {
    const { schedule } = await call('get_schedule_plan', [1], {}, storageAPI);
    if (!schedule || !Object.hasOwn(schedule, 'schedule_enabled')) throw new Error('schedule');
    if (!enabled(schedule.schedule_enabled)) return {};
    const start = scrubStart(schedule, now, clock);
    if (start === null) return {};
    return {
      plans: [{
        id: 'storage-scrubbing',
        name: 'Speicher-Manager · Datenbereinigung',
        start,
      }],
    };
  }

  async function scrubbingCompletions(call, { now, clock }) {
    const data = await call('load_info', [1], {}, storageAPI);
    if (!Array.isArray(data?.storagePools)) throw new Error('storagePools');
    const format = new Intl.DateTimeFormat('de-DE', {
      timeZone: clock.timeZone,
      dateStyle: 'short',
      timeStyle: 'short',
    });
    const notes = [];
    for (const pool of data.storagePools) {
      const end = timestamp(pool?.last_done_time);
      if (end === null || end > now || end < now - 14 * daySeconds) continue;
      const number = Number(pool.num_id);
      const name = Number.isInteger(number) && number > 0
        ? `Speicherpool ${number}`
        : 'Speicherpool';
      notes.push(`Datenbereinigung · ${name} · letzter Abschluss ${format.format(end * 1000)} · Dauer unbekannt`);
    }
    return { notes };
  }

  async function load(call, context) {
    const sources = [
      [antivirusPlans, 'Antivirus-Zeitplan'],
      [antivirusRuns, 'Antivirus-Protokoll'],
      [scrubbingPlan, 'Zeitplan der Datenbereinigung'],
      [scrubbingCompletions, 'Letzte Abschlüsse der Datenbereinigung'],
    ];
    const result = { plans: [], runs: [], notes: [] };
    const settled = await Promise.allSettled(sources.map(([read]) => read(call, context)));
    for (const [index, entry] of settled.entries()) {
      if (entry.status === 'fulfilled') {
        for (const key of Object.keys(result)) result[key].push(...(entry.value[key] ?? []));
      } else if (entry.reason?.code !== 102) {
        result.notes.push(`${sources[index][1]} konnte nicht geladen werden.`);
      }
    }
    return result;
  }

  window.SynoUsageTaskSources = { load };
})();
