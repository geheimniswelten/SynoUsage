(function () {
  'use strict';

  const taskAPI = 'SYNO.Core.TaskScheduler';
  const taskName = 'SynoUsage Erfassung';
  const collector = '/var/packages/h5uSynoUsage/target/bin/synousage';
  const controlPanel = 'SYNO.SDS.AdminCenter.Application';
  const schedulerWindow = 'SYNO.SDS.AdminCenter.TaskScheduler.Main';
  const sessionError =
    'SynoUsage aus dem DSM-Hauptmenü mit einem Administratorkonto öffnen.';

  function dsmDesktop() {
    if (window.location.protocol === 'file:') return null;
    try {
      return window.parent.location.origin === window.location.origin
        ? window.parent.SYNO
        : null;
    } catch (_) {
      return null;
    }
  }

  function scriptFor(sha256) {
    return [
      '# SynoUsage Collector v1',
      'set -eu',
      'export PATH=/usr/syno/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      'umask 077',
      'work=$(mktemp -d /tmp/synousage.XXXXXXXXXX)',
      'trap \'rm -f -- "$work/synousage"; rmdir -- "$work"\' 0',
      "trap 'exit 1' HUP INT TERM",
      `[ -f '${collector}' ]`,
      `head -c 16777216 '${collector}' > "$work/synousage"`,
      `printf '%s  %s\\n' '${sha256}' "$work/synousage" | sha256sum -c -`,
      'chmod 0700 "$work/synousage"',
      '"$work/synousage" collect',
    ].join('\n');
  }

  function taskScript() {
    const hash = window.SynoUsageBuild?.collectorSHA256;
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error(
        'Die Prüfsumme des installierten Collectors fehlt. Das SPK erneut installieren.',
      );
    }
    return scriptFor(hash);
  }

  function normalizeScript(script) {
    return typeof script === 'string'
      ? script.replace(/\r\n/g, '\n').trim()
      : '';
  }

  function isSynoUsageScript(script) {
    const hash = script.match(
      /'([a-f0-9]{64})' "\$work\/synousage" \| sha256sum -c -/,
    )?.[1];
    return Boolean(hash && script === scriptFor(hash));
  }

  function request(method, version, params) {
    const api = dsmDesktop()?.API;
    if (typeof api?.Request !== 'function')
      return Promise.reject(new Error(sessionError));
    return new Promise((resolve, reject) => {
      const deadline = window.setTimeout(() => {
        reject(new Error(`Keine Antwort vom DSM-Aufgabenplaner (${method}).`));
      }, 22000);
      try {
        api.Request({
          api: taskAPI,
          method,
          version,
          params: structuredClone(params),
          timeout: 20000,
          callback(success, data) {
            window.clearTimeout(deadline);
            if (success === true) {
              resolve(data ?? {});
              return;
            }
            const code = Number(data?.error?.code ?? data?.code);
            const suffix =
              Number.isInteger(code) && code > 0 ? ` (DSM ${code})` : '';
            const error = new Error(
              `Der DSM-Aufgabenplaner hat „${method}“ abgelehnt${suffix}.`,
            );
            error.code = code;
            reject(error);
          },
        });
      } catch (_) {
        window.clearTimeout(deadline);
        reject(
          new Error(
            'Die Verbindung zum DSM-Aufgabenplaner ist fehlgeschlagen.',
          ),
        );
      }
    });
  }

  async function call(method, versions, params) {
    for (const version of versions) {
      try {
        return await request(method, version, params);
      } catch (error) {
        const rejectedVersion =
          error.code === 104 || (method === 'list' && error.code === 103);
        if (!rejectedVersion || version === versions.at(-1)) throw error;
      }
    }
  }

  function parseObject(value) {
    try {
      if (typeof value === 'string') value = JSON.parse(value);
      return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : null;
    } catch (_) {
      return null;
    }
  }

  function taskID(value) {
    return (
      /^\d+$/.test(String(value)) &&
      Number.isSafeInteger(Number(value)) &&
      Number(value) > 0
    );
  }

  async function listMatches() {
    const matches = [];
    const seen = new Set();
    let expectedTotal;
    for (let offset = 0; offset <= 1100; ) {
      const result = await call('list', [2, 3], {
        offset,
        limit: 100,
        sort_by: 'name',
        sort_direction: 'ASC',
      });
      const total = Number(result.total);
      if (
        !Array.isArray(result.tasks) ||
        result.total == null ||
        !Number.isInteger(total) ||
        total < 0 ||
        total > 1100 ||
        (expectedTotal !== undefined && total !== expectedTotal)
      ) {
        throw new Error(
          'DSM lieferte keine vollständige, eindeutige Aufgabenliste.',
        );
      }
      expectedTotal = total;
      for (const task of result.tasks) {
        const id = Number(task.id);
        if (!taskID(task.id) || seen.has(id))
          throw new Error('DSM lieferte widersprüchliche Aufgaben-IDs.');
        seen.add(id);
        if (task.name === taskName) matches.push(task);
      }
      offset += result.tasks.length;
      if (offset === total) return matches;
      if (offset > total || !result.tasks.length) break;
    }
    throw new Error('DSM lieferte nur einen Teil der Aufgabenliste.');
  }

  function conflict(message) {
    return { state: 'conflict', message };
  }

  async function inspect() {
    const expected = taskScript();
    const matches = await listMatches();
    if (matches.length === 0)
      return {
        state: 'missing',
        message: 'Die DSM-Aufgabe für SynoUsage fehlt.',
      };
    if (matches.length > 1)
      return conflict(
        'Im Aufgabenplaner existieren mehrere Aufgaben namens „SynoUsage Erfassung“.',
      );
    const summary = matches[0];
    const id = Number(summary.id);
    const realOwner = summary.real_owner;
    if (
      summary.owner !== 'root' ||
      typeof realOwner !== 'string' ||
      !realOwner
    ) {
      return conflict(
        'Die gleichnamige Aufgabe ist keiner passenden Root-Ausführung zugeordnet.',
      );
    }
    const result = await call('get', [3, 4, 2], { id, real_owner: realOwner });
    const task = result.task || result;
    const extra = parseObject(task.extra);
    const script = normalizeScript(extra?.script);
    const type = task.type ?? summary.type;
    if (
      Number(task.id) !== id ||
      task.name !== taskName ||
      task.owner !== 'root' ||
      task.real_owner !== realOwner ||
      (type && type !== 'script') ||
      !isSynoUsageScript(script)
    ) {
      return conflict(
        'Die vorhandene Aufgabe entspricht keinem bekannten SynoUsage-Erfassungsskript.',
      );
    }
    const enabled =
      task.enable === true ||
      task.enable === 1 ||
      task.enable === 'true' ||
      task.enable === '1';
    const state = script === expected ? 'ready' : 'outdated';
    return {
      state,
      id,
      realOwner,
      task,
      extra,
      message:
        state === 'ready'
          ? 'Die DSM-Aufgabe ist registriert und aktuell.'
          : 'Das Erfassungsskript stammt aus einer anderen Paketversion.',
      schedule: enabled ? 'Zeitplan aktiv' : 'Zeitplan deaktiviert',
    };
  }

  async function status() {
    try {
      const { state, message, schedule } = await inspect();
      return { state, message, schedule };
    } catch (error) {
      return { state: 'unavailable', message: error.message };
    }
  }

  async function currentUser() {
    const response = await fetch('./api.cgi?view=status', {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(sessionError);
    const { user } = await response.json();
    if (typeof user !== 'string' || !user.trim()) throw new Error(sessionError);
    return user;
  }

  // Re-read after either a success or an ambiguous failure. A lost response
  // must not cause a second create or overwrite a task edited in DSM.
  async function verifiedChange(method, params, confirmation) {
    let operationError;
    try {
      await call(method, [3, 4, 2], params);
    } catch (error) {
      operationError = error;
    }
    let verified;
    try {
      verified = await inspect();
    } catch (error) {
      throw operationError || error;
    }
    if (verified.state !== 'ready' || !confirmation(verified)) {
      throw (
        operationError ||
        new Error(
          'DSM konnte die Änderung nicht bestätigen. Aufgabe im Aufgabenplaner prüfen.',
        )
      );
    }
  }

  async function register() {
    const existing = await inspect();
    if (existing.state !== 'missing') throw new Error(existing.message);
    const user = await currentUser();
    const result = await call('get', [3, 4, 2], {
      id: -1,
      type: 'script',
      real_owner: user,
    });
    const defaultOwner = (result.task || result).real_owner;
    const owner =
      typeof defaultOwner === 'string' && defaultOwner.trim()
        ? defaultOwner
        : user;
    await verifiedChange(
      'create',
      {
        name: taskName,
        type: 'script',
        owner: 'root',
        real_owner: owner,
        enable: false,
        schedule: {
          date_type: 0,
          monthly_week: '[]',
          repeat_date: 1002,
          week_day: '1',
          hour: 3,
          minute: 0,
          repeat_hour: 0,
          repeat_min: 0,
          last_work_hour: 3,
        },
        extra: {
          script: taskScript(),
          notify_enable: false,
          notify_mail: '',
          notify_if_error: false,
        },
      },
      (task) => task.realOwner === owner,
    );
    return {
      message:
        'Aufgabe registriert. Die automatische Ausführung lässt sich im DSM-Aufgabenplaner aktivieren.',
    };
  }

  async function update() {
    const previous = await inspect();
    if (previous.state !== 'outdated') throw new Error(previous.message);
    const schedule = parseObject(previous.task.schedule);
    const enable = previous.task.enable;
    if (
      !schedule ||
      ![true, false, 0, 1, 'true', 'false', '0', '1'].includes(enable)
    ) {
      throw new Error(
        'DSM lieferte den vorhandenen Zeitplan nicht vollständig. Aufgabe im Aufgabenplaner prüfen.',
      );
    }
    await verifiedChange(
      'set',
      {
        id: previous.id,
        name: taskName,
        owner: 'root',
        real_owner: previous.realOwner,
        enable,
        schedule,
        extra: { ...previous.extra, script: taskScript() },
      },
      (task) =>
        task.id === previous.id && task.realOwner === previous.realOwner,
    );
    return {
      message:
        'Aufgabe aktualisiert. Der bestehende Zeitplan wurde übernommen.',
    };
  }

  async function start() {
    const task = await inspect();
    if (task.state !== 'ready')
      throw new Error(`${task.message} Bitte unter Einstellungen prüfen.`);
    await call('run', [2], {
      tasks: [{ id: task.id, real_owner: task.realOwner }],
    });
    return { message: 'Erfassung beim DSM-Aufgabenplaner angefordert.' };
  }

  function openScheduler() {
    const desktop = dsmDesktop();
    if (typeof desktop?.SDS?.AppLaunch === 'function') {
      desktop.SDS.AppLaunch(controlPanel, { fn: schedulerWindow });
    } else if (window.location.protocol !== 'file:') {
      const link = document.createElement('a');
      const url = new URL('/', window.location.href);
      url.searchParams.set('launchApp', controlPanel);
      url.searchParams.set(
        'launchParam',
        new URLSearchParams({ fn: schedulerWindow }).toString(),
      );
      link.href = url.href;
      link.target = '_blank';
      link.rel = 'noopener';
      link.click();
    }
    return { message: 'DSM-Aufgabenplaner geöffnet.' };
  }

  window.SynoUsageDSM = Object.freeze({
    status,
    register,
    update,
    start,
    openScheduler,
    taskScript,
  });
})();
