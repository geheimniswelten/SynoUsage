(function (global) {
  'use strict';

  function normalizeLanguage(value) {
    return /^(de(?:[-_].*)?|ger|german)$/i.test(String(value || '')) ? 'de' : 'en';
  }

  function detectLanguage(env) {
    env = env || global;
    try {
      const parent = env.window?.parent;
      const dsm = parent?.SYNO?.SDS?.Session?.lang;
      if (dsm && dsm !== 'def') return normalizeLanguage(dsm);
      if (parent && parent !== env.window && parent.document?.documentElement?.lang) {
        return normalizeLanguage(parent.document.documentElement.lang);
      }
    } catch (_) {
      // A cross-origin parent cannot expose its language settings.
    }
    return normalizeLanguage(env.navigator?.languages?.[0] || env.navigator?.language || 'en');
  }

  function translate(messages, language, key, args) {
    const translations = messages[language] || {};
    const fallback = messages.de || {};
    const template = translations[key] ?? fallback[key] ?? key;
    return template.replace(/\{(\w+)\}/g, (match, name) =>
      args && Object.prototype.hasOwnProperty.call(args, name) ? String(args[name]) : match);
  }

  global.SynoUsageI18n = {normalizeLanguage, detectLanguage, translate};
})(globalThis);
