(function () {
  'use strict';

  const taskAPI = 'SYNO.Core.TaskScheduler';
  const rootTaskAPI = 'SYNO.Core.TaskScheduler.Root';
  const passwordAPI = 'SYNO.Core.User.PasswordConfirm';
  const passwordDialog = 'SYNO.SDS.Utils.PasswordConfirmDialog';
  const application = 'SYNO.SDS.h5uSynoUsage.Application';
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

  async function synoToken() {
    let token;
    try {
      token = window.parent.SYNO?.SDS?.Session?.SynoToken || window.parent.SynoToken;
    } catch (_) {
      // A standalone or cross-origin parent cannot supply the session token.
    }
    if (typeof token === 'string' && token) return token;
    const response = await fetch('/webman/login.cgi', {
      credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error('Das DSM-Sitzungstoken konnte nicht gelesen werden.');
    const session = await response.json();
    token = session.SynoToken || session.data?.SynoToken;
    if (typeof token !== 'string' || !token)
      throw new Error('Kein DSM-Sitzungstoken verfügbar. Bitte erneut bei DSM anmelden.');
    return token;
  }

  async function cgiRequest(query, timeout) {
    const token = await synoToken();
    return fetch('./api.cgi' + query, {
      credentials: 'same-origin', cache: 'no-store',
      headers: { 'X-SYNO-TOKEN': token }, signal: AbortSignal.timeout(timeout),
    });
  }

  async function controlScan(action, runId) {
    if (!['restart', 'cancel'].includes(action) || !runId)
      throw new Error('Ungültige Erfassungsaktion.');
    const token = await synoToken();
    const response = await fetch('./api.cgi?action=' + action, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'X-SYNO-TOKEN': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId }), signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) {
      let detail;
      try { detail = (await response.json()).error; } catch (_) {}
      throw new Error(typeof detail === 'string' && detail.length <= 200
        ? detail : 'Erfassungsaktion fehlgeschlagen (HTTP ' + response.status + ').');
    }
  }

  function legacyScriptFor(sha256, tempRoot = '/var/lib') {
    return [
      '# SynoUsage Collector v1',
      'set -eu',
      'export PATH=/usr/syno/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      'umask 077',
      `work=$(mktemp -d ${tempRoot}/synousage.XXXXXXXXXX)`,
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
    return [
      '# SynoUsage Collector v2',
      'set -eu',
      'export PATH=/usr/syno/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      'launcher=/var/packages/h5uSynoUsage/scripts/start-stop-status',
      'for path in / /var /var/packages /var/packages/h5uSynoUsage /var/packages/h5uSynoUsage/scripts "$launcher"; do',
      '  [ ! -L "$path" ] || { echo "Unerwarteter symbolischer Link $path" >&2; exit 1; }',
      '  owner_mode=$(stat -c "%u:%a" "$path")',
      '  mode=${owner_mode#*:}',
      '  if [ "${owner_mode%%:*}" != 0 ] || [ "$((0$mode & 022))" -ne 0 ]; then',
      '    echo "Root-Schreibschutz fehlt für $path" >&2',
      '    exit 1',
      '  fi',
      'done',
      '[ -f "$launcher" ]',
      'exec /bin/sh "$launcher" collect',
    ].join('\n');
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
    return script === taskScript() ||
      Boolean(hash && (script === legacyScriptFor(hash) || script === legacyScriptFor(hash, '/tmp')));
  }

  function request(method, version, params, apiName) {
    const api = dsmDesktop()?.API;
    if (typeof api?.Request !== 'function')
      return Promise.reject(new Error(sessionError));
    return new Promise((resolve, reject) => {
      const deadline = window.setTimeout(() => {
        reject(new Error(`Keine Antwort vom DSM-Aufgabenplaner (${method}).`));
      }, 22000);
      try {
        api.Request({
          api: apiName,
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

  async function call(method, versions, params, apiName = taskAPI) {
    for (const version of versions) {
      try {
        return await request(method, version, params, apiName);
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

  async function listTasks(versions = [2, 3]) {
    const tasks = [];
    const seen = new Set();
    let expectedTotal;
    for (let offset = 0; offset <= 1100; ) {
      const result = await call('list', versions, {
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
        tasks.push(task);
      }
      offset += result.tasks.length;
      if (offset === total) return tasks;
      if (offset > total || !result.tasks.length) break;
    }
    throw new Error('DSM lieferte nur einen Teil der Aufgabenliste.');
  }

  function conflict(message) {
    return { state: 'conflict', message };
  }

  async function inspect(getVersions = [3, 4, 2]) {
    const expected = taskScript();
    const matches = (await listTasks()).filter(task => task.name === taskName);
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
    const result = await call('get', getVersions, { id, real_owner: realOwner });
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
    const enabled = [true, 1, 'true', '1'].includes(task.enable)
      ? true
      : [false, 0, 'false', '0'].includes(task.enable)
        ? false
        : null;
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
          : 'Die DSM-Aufgabe verwendet noch das frühere Erfassungsskript.',
      schedule: enabled === null ? 'Zeitplanstatus unbekannt' : enabled ? 'Zeitplan aktiv' : 'Zeitplan deaktiviert',
      scheduleEnabled: enabled,
    };
  }

  async function status() {
    try {
      const { state, message, schedule, scheduleEnabled } = await inspect();
      return { state, message, schedule, scheduleEnabled };
    } catch (error) {
      return { state: 'unavailable', message: error.message };
    }
  }

  function timeline() {
    return window.SynoUsageTaskData.load({call, listTasks: () => listTasks([3, 2]), cgiRequest, taskName});
  }

  async function currentUser() {
    const response = await cgiRequest('?view=status', 8000);
    if (!response.ok) {
      let detail;
      try {
        const body = await response.json();
        if (typeof body.error === 'string' && body.error.length <= 200)
          detail = body.error;
      } catch (_) {
        // A proxy or web server may return HTML instead of the CGI response.
      }
      throw new Error(
        `Abfrage der SynoUsage-Schnittstelle fehlgeschlagen (HTTP ${response.status})${detail ? ': ' + detail : '.'}`,
      );
    }
    const { user } = await response.json();
    if (typeof user !== 'string' || !user.trim())
      throw new Error('Die SynoUsage-Schnittstelle lieferte keinen Benutzernamen.');
    return user;
  }

  function supportsVersion(info, version) {
    return Number(info?.minVersion) <= version && Number(info?.maxVersion) >= version;
  }

  async function protectedTaskWrites(api) {
    const root = api.GetKnownAPI?.(rootTaskAPI);
    const password = api.GetKnownAPI?.(passwordAPI);
    if (root && password) {
      return supportsVersion(root, 4) && supportsVersion(password, 2);
    }

    const query = new URLSearchParams({
      api: 'SYNO.API.Info', method: 'query', version: '1',
      query: rootTaskAPI + ',' + passwordAPI,
    });
    let catalog;
    try {
      const response = await fetch('/webapi/entry.cgi?' + query, {
        credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(8000),
      });
      if (response.ok) catalog = await response.json();
    } catch (_) {
      // A proxy can return a redirect or an error page instead of the catalog.
    }
    if (catalog?.success !== true || !catalog.data) {
      throw new Error('Die Schnittstellen des DSM-Aufgabenplaners konnten nicht ermittelt werden.');
    }
    return supportsVersion(catalog.data[rootTaskAPI], 4) &&
      supportsVersion(catalog.data[passwordAPI], 2);
  }

  async function authorizeTaskChange() {
    const desktop = dsmDesktop();
    if (!desktop?.API) throw new Error(sessionError);
    const sds = desktop.SDS;
    const owner = sds?.AppMgr?.getByAppName?.(application)?.[0]?.window;
    const dsm71 = Number(owner?._S?.('majorversion')) === 7 &&
      Number(owner._S('minorversion')) === 1;
    if (dsm71 || !(await protectedTaskWrites(desktop.API))) return {};

    let Dialog = sds?.Utils?.PasswordConfirmDialog;
    if (!Dialog && typeof sds?.JSLoadPromise === 'function') {
      try {
        await sds.JSLoadPromise(passwordDialog);
        Dialog = sds.Utils?.PasswordConfirmDialog;
      } catch (_) {
        // The DSM loader may not expose this module in every desktop context.
      }
    }
    if (typeof Dialog !== 'function' || !owner) {
      throw new Error('Der DSM-Passwortdialog ist hier nicht verfügbar. Aufgabe im DSM-Aufgabenplaner speichern.');
    }

    return new Promise((resolve, reject) => {
      const cancel = () => resolve(null);
      const dialog = new Dialog({
        module: owner,
        owner,
        callback(result) {
          const token = result?.SynoConfirmPWToken;
          if (typeof token === 'string' && token) resolve({ token });
          else reject(new Error('DSM hat keine Passwortbestätigung zurückgegeben.'));
        },
        cancelCallback: cancel,
      });
      // DSM closes the dialog just before calling back with the token.
      const closed = () => queueMicrotask(cancel);
      dialog.on('close', closed, null, { single: true });
      dialog.on('destroy', closed, null, { single: true });
      dialog.open();
    });
  }

  // Re-read after either a success or an ambiguous failure. A lost response
  // must not cause a second create or overwrite a task edited in DSM.
  async function verifiedChange(method, params, confirmation, token) {
    let operationError;
    try {
      if (token) {
        await call(method, [4], { ...params, SynoConfirmPWToken: token }, rootTaskAPI);
      } else {
        await call(method, [3, 4, 2], params);
      }
    } catch (error) {
      operationError = error;
    }
    let verified;
    try {
      verified = await inspect(token ? [4] : undefined);
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
    const authorization = await authorizeTaskChange();
    if (!authorization) return { message: 'Aufgabenregistrierung abgebrochen.' };
    const [result, current] = await Promise.all([
      call('get', authorization.token ? [4] : [3, 4, 2], {
        id: -1,
        type: 'script',
        real_owner: user,
      }),
      authorization.token ? inspect([4]) : existing,
    ]);
    if (current.state !== 'missing') throw new Error(current.message);
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
      authorization.token,
    );
    return {
      message:
        'Aufgabe registriert. Die automatische Ausführung lässt sich im DSM-Aufgabenplaner aktivieren.',
    };
  }

  async function update() {
    let previous = await inspect();
    if (previous.state !== 'outdated') throw new Error(previous.message);
    const authorization = await authorizeTaskChange();
    if (!authorization) return { message: 'Aufgabenaktualisierung abgebrochen.' };
    if (authorization.token) {
      const current = await inspect([4]);
      if (current.state !== 'outdated') throw new Error(current.message);
      if (current.id !== previous.id || current.realOwner !== previous.realOwner) {
        throw new Error('Die DSM-Aufgabe hat sich während der Bestätigung geändert. Bitte erneut prüfen.');
      }
      previous = current;
    }
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
      authorization.token,
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
    timeline,
    register,
    update,
    start,
    openScheduler,
    taskScript,
    cgiRequest,
    controlScan,
  });
})();
