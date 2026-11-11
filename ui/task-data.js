(function () {
  'use strict';

  const day = 86400;
  const eventAPI = 'SYNO.Core.EventScheduler';
  const historyMethods = {scheduled: 'get_history_status_list', event: 'result_list'};

  async function readClock(call, cgiRequest) {
    const {clock, knownZone} = window.SynoUsageTaskTime;
    let now = Math.floor(Date.now() / 1000);
    let zone;
    let offset;
    try {
      const response = await cgiRequest('?view=task-clock', 8000);
      if (response.ok) {
        const data = await response.json();
        if (Number.isSafeInteger(data.now) && data.now > 0 && data.now < 253402300800) now = data.now;
        zone = knownZone(data.timeZone);
        offset = data.utcOffset;
      }
    } catch (_) {
      // Older packages can still supply a zone through the DSM session.
    }
    if (!zone) {
      try {
        const region = await call('get', [3, 2, 1], {}, 'SYNO.Core.Region.NTP');
        zone = knownZone(region.timezone);
      } catch (_) {
        // The browser zone is usable if DSM uses the same clock offset.
      }
    }
    const resolved = clock(zone);
    const {year, month, day: date, hour, minute, second} = resolved.civil(now);
    const resolvedOffset = Date.UTC(year, month - 1, date, hour, minute, second) / 1000 - now;
    return {
      now, clock: resolved, timeZone: resolved.timeZone,
      fromBrowser: !zone, offsetMismatch: Number.isFinite(offset) && offset !== resolvedOffset,
    };
  }

  function asJobs(tasks, taskName) {
    const rootScans = tasks.filter(task => task.name === taskName && task.owner === 'root' && task.type === 'script');
    return tasks.filter(task => typeof task.name === 'string' && task.name.trim()).map(task => {
      const event = typeof task.type === 'string' && task.type.startsWith('event');
      const id = rootScans.length === 1 && task === rootScans[0] ? 'synousage'
        : `scheduler:${task.id}`;
      return {id, name: task.name, event, task};
    });
  }

  function plannedStarts(jobs, {now, clock}) {
    const plans = [];
    for (const {id, name, event, task} of jobs) {
      if (event || ![true, 1, '1', 'true'].includes(task.enable)) continue;
      const start = clock.parse(task.next_trigger_time, {after: now, before: now + 14 * day});
      if (start !== null) plans.push({id, name, start, detail: 'DSM-Aufgabenplaner'});
    }
    return plans;
  }

  function resultStatus(type, code) {
    if (['stop', 'by_signal'].includes(type)) return 'Unterbrochen';
    if (type === 'error' || (type === 'normal' && code != null && Number(code) !== 0)) return 'Fehlgeschlagen';
    return type === 'normal' ? 'Abgeschlossen' : '';
  }

  async function readHistory(job, context, call) {
    const {now, clock} = context;
    const rows = job.event
      ? await call(historyMethods.event, [1], {task_name: job.name}, eventAPI)
      : await call(historyMethods.scheduled, [1], {id: Number(job.task.id)});
    if (!Array.isArray(rows)) throw new Error('DSM lieferte keine Ergebnisliste.');
    const runs = [];
    const seen = new Set();
    for (const row of rows) {
      if (!row) continue;
      const {exit_type: type, exit_code: code} = row.exit_info ?? row;
      if (type === 'running') continue;
      const timestamp = clock.parse(row.timestamp);
      // The index timestamp identifies which occurrence of a repeated local hour to use.
      const hintedStart = timestamp === null ? null : clock.parse(row.start_time, {after: timestamp, before: timestamp});
      const start = hintedStart ?? clock.parse(row.start_time);
      if (start === null) continue;
      if (hintedStart === null && clock.parse(row.start_time, {after: start + 1}) !== null) continue;
      const before = now + 60;
      const end = clock.parse(row.stop_time, {after: start + 1, before});
      const key = `${start}:${end}`;
      if (end === null || end < now - 14 * day || seen.has(key)) continue;
      if (clock.parse(row.stop_time, {after: end + 1, before}) !== null) continue;
      seen.add(key);
      runs.push({id: job.id, name: job.name, start, end, status: resultStatus(type, code)});
    }
    return runs;
  }

  async function savedRuns(jobs, context, call) {
    const runs = [];
    let unavailable = 0;
    const unsupported = new Set();
    const batchSize = 8;
    const deadline = Date.now() + 30000;
    for (let offset = 0; offset < jobs.length; offset += batchSize) {
      if (Date.now() > deadline) {
        unavailable += jobs.length - offset;
        break;
      }
      const batch = jobs.slice(offset, offset + batchSize);
      const results = await Promise.allSettled(batch.map(job => unsupported.has(job.event)
        ? Promise.reject()
        : readHistory(job, context, call)));
      for (const [index, result] of results.entries()) {
        if (result.status === 'fulfilled') {
          for (const run of result.value) runs.push(run);
        } else {
          unavailable++;
          if ([102, 103, 104].includes(result.reason?.code)) unsupported.add(batch[index].event);
        }
      }
    }
    return {runs, unavailable};
  }

  async function load({call, listTasks, cgiRequest, taskName}) {
    const [context, taskList] = await Promise.all([
      readClock(call, cgiRequest),
      listTasks().catch(() => null),
    ]);
    const notes = [];
    const {now, timeZone, fromBrowser, offsetMismatch} = context;
    if (offsetMismatch) {
      notes.push('Die DSM-Zeitzone konnte nicht zugeordnet werden. Lokale DSM-Zeitangaben fehlen daher in der Ansicht.');
      return {now, timeZone, runs: [], plans: [], notes};
    }
    if (fromBrowser) notes.push('Die Ansicht verwendet die Zeitzone des Browsers, da DSM keine bekannte Zeitzone gemeldet hat.');
    if (!taskList) notes.push('Die Liste des DSM-Aufgabenplaners konnte nicht geladen werden.');
    const jobs = asJobs(taskList || [], taskName);
    const [history, extra] = await Promise.all([
      savedRuns(jobs, context, call),
      window.SynoUsageTaskSources.load(call, context),
    ]);
    if (history.unavailable) {
      notes.push(`DSM-Ausführungsergebnisse waren für ${history.unavailable} von ${jobs.length} Aufgaben nicht verfügbar.`);
    }
    return {
      now, timeZone,
      runs: [...history.runs, ...extra.runs],
      plans: [...plannedStarts(jobs, context), ...extra.plans],
      notes: [...notes, ...extra.notes],
    };
  }

  function addMeasurements(timeline, measurements, status) {
    const scans = timeline.runs.filter(run => run.id === 'synousage');
    const oldest = timeline.now - 14 * day;
    function append(start, end, result) {
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end < oldest) return;
      if (scans.some(run => run.start <= start + 2 && run.end >= end - 2)) return;
      const run = {id: 'synousage', name: 'SynoUsage Erfassung', start, end, status: result};
      timeline.runs.push(run);
      scans.push(run);
    }
    for (const measurement of measurements) {
      if (measurement.partial || !Number.isFinite(measurement.durationSeconds)) continue;
      const end = Math.floor(Date.parse(measurement.at) / 1000);
      append(end - measurement.durationSeconds, end, 'Abgeschlossen');
    }
    if (status?.state === 'cancelled') {
      append(Date.parse(status.startedAt) / 1000, Date.parse(status.updatedAt) / 1000, 'Abgebrochen');
    }
  }

  window.SynoUsageTaskData = Object.freeze({load, addMeasurements});
})();
