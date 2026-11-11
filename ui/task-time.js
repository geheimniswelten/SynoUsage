(function () {
  'use strict';

  const daySeconds = 86400;
  const localStamp = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/;
  const offsetStamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

  function utc({year, month, day, hour = 0, minute = 0, second = 0}) {
    return Date.UTC(year, month - 1, day, hour, minute, second) / 1000;
  }

  function shiftDate({year, month, day}, days) {
    const date = new Date(Date.UTC(year, month - 1, day + days));
    return {year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate()};
  }

  function weekday(parts) {
    return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  }

  function knownZone(value) {
    if (typeof value !== 'string' || !value) return undefined;
    try {
      return new Intl.DateTimeFormat('de-DE', {timeZone: value}).resolvedOptions().timeZone;
    } catch (_) {
      return undefined;
    }
  }

  function clock(zone) {
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: knownZone(zone),
      calendar: 'gregory', numberingSystem: 'latn', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const timeZone = formatter.resolvedOptions().timeZone;
    const offsetsByDay = new Map();

    function civil(stamp) {
      const parts = {};
      for (const {type, value} of formatter.formatToParts(stamp * 1000)) {
        if (type !== 'literal') parts[type] = Number(value);
      }
      return parts;
    }

    function contains(stamp, {after = -Infinity, before = Infinity} = {}) {
      return Number.isFinite(stamp) && Math.abs(stamp) <= 8.64e12 && stamp >= after && stamp <= before;
    }

    function epoch(parts, bounds) {
      const target = utc(parts);
      const date = new Date(target * 1000);
      if (!Number.isFinite(target) || date.getUTCFullYear() !== parts.year ||
          date.getUTCMonth() + 1 !== parts.month || date.getUTCDate() !== parts.day ||
          date.getUTCHours() !== (parts.hour ?? 0) || date.getUTCMinutes() !== (parts.minute ?? 0) ||
          date.getUTCSeconds() !== (parts.second ?? 0)) return null;

      const midnight = Math.floor(target / daySeconds) * daySeconds;
      if (!offsetsByDay.has(midnight)) {
        // Both offsets around a clock change are needed for a repeated hour.
        const probes = [midnight - daySeconds, midnight, midnight + daySeconds, midnight + 2 * daySeconds];
        offsetsByDay.set(midnight, [...new Set(probes.map(stamp => utc(civil(stamp)) - stamp))].sort((a, b) => b - a));
      }
      for (const offset of offsetsByDay.get(midnight)) {
        const stamp = target - offset;
        if (contains(stamp, bounds) && utc(civil(stamp)) === target) return stamp;
      }
      return null;
    }

    function parse(value, bounds) {
      const text = typeof value === 'string' ? value.trim() : '';
      if (typeof value === 'number' || /^\d{9,10}$/.test(text)) {
        const stamp = typeof value === 'number' ? value : Number(text);
        return contains(stamp, bounds) ? stamp : null;
      }
      if (offsetStamp.test(text)) {
        const stamp = Date.parse(text) / 1000;
        return contains(stamp, bounds) ? stamp : null;
      }
      const fields = text.match(localStamp);
      if (!fields) return null;
      const [year, month, day, hour, minute, second = 0] = fields.slice(1).filter(value => value !== undefined).map(Number);
      return epoch({year, month, day, hour, minute, second}, bounds);
    }

    return {timeZone, civil, epoch, parse};
  }

  window.SynoUsageTaskTime = Object.freeze({clock, knownZone, shiftDate, weekday});
})();
