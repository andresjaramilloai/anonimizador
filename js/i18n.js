// Textos: el español es la clave (igual que L("…") en la app de Mac). Los archivos mac-*.json se copian de Mac/Resources; web-*.json son los textos propios de la web.
const LANGS = ['es', 'en', 'pt'];
let table = {};
let lang = 'es';

export function detect() {
  let saved = null;
  try { saved = localStorage.getItem('anon.lang'); } catch (e) { /* sin almacenamiento */ }
  if (saved && LANGS.includes(saved)) return saved;
  for (const l of navigator.languages || [navigator.language || 'es']) {
    const c = String(l).toLowerCase();
    if (c.startsWith('es')) return 'es';
    if (c.startsWith('pt')) return 'pt';
    if (c.startsWith('en')) return 'en';
  }
  return 'en';
}

export async function setLang(l, { save = true } = {}) {
  lang = LANGS.includes(l) ? l : 'es';
  table = {};
  if (lang !== 'es') {
    const code = lang === 'pt' ? 'pt-BR' : 'en';
    for (const f of [`mac-${code}.json`, `web-${code}.json`]) {
      try { Object.assign(table, await (await fetch(new URL(`../i18n/${f}`, import.meta.url))).json()); } catch (e) { /* queda en español */ }
    }
  }
  document.documentElement.lang = lang === 'pt' ? 'pt-BR' : lang;
  if (save) { try { localStorage.setItem('anon.lang', lang); } catch (e) { /* ignorar */ } }
  return lang;
}

export const getLang = () => lang;
export const keys = () => new Set(Object.keys(table));

/** Traduce un texto en español; cada «%@» se reemplaza, en orden, por un argumento (igual que L() en Mac). */
export function t(key, ...args) {
  let s = table[key] ?? key;
  if (!args.length || !s.includes('%')) return s;
  let n = 0;
  s = s.replace(/%(\d)\$@|%@/g, (m, d) => String(d ? args[Number(d) - 1] : args[n++] ?? ''));
  return s;
}
