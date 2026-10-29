// Reglas de detección — puerto a JavaScript de Spec/reglas.md (la implementación de referencia es Mac/Sources/Anonimizador/Core).
// Sin dependencias: sirve igual en el navegador y en Node (así el corpus se prueba sin abrir un navegador).
// Las posiciones son índices UTF-16, igual que NSRange en Mac.

export const KINDS = ['email', 'phone', 'card', 'id', 'bank', 'ip', 'token', 'password', 'company', 'person', 'custom'];
export const AUTOMATIC = ['email', 'phone', 'card', 'id', 'bank', 'ip', 'token', 'password'];
export const LISTED = ['company', 'person', 'custom'];

/** Nombre dentro de las etiquetas del texto pegado: igual en todos los idiomas y plataformas. */
export const MARKER = {
  email: 'CORREO', phone: 'TELÉFONO', card: 'TARJETA', id: 'DOCUMENTO', bank: 'CUENTA', ip: 'IP',
  token: 'CLAVE', password: 'CONTRASEÑA', company: 'EMPRESA', person: 'PERSONA', custom: 'DATO',
};

// ---------- Validadores ----------

const digits = (s) => [...s].filter((c) => c >= '0' && c <= '9').map(Number);

export function luhn(s) {
  const d = digits(s);
  if (d.length < 13 || d.length > 19 || new Set(d).size < 2) return false;
  let sum = 0;
  d.reverse().forEach((n, i) => { let v = n; if (i % 2 === 1) { v *= 2; if (v > 9) v -= 9; } sum += v; });
  return sum % 10 === 0;
}

/** Luhn y una agrupación creíble: todo junto, o grupos de 4 (el último de 1 a 4), o 4-6-5 / 4-6-4. */
export function card(s) {
  if (!luhn(s)) return false;
  const groups = s.split(/[ -]/).filter(Boolean).map((g) => g.length);
  if (groups.length <= 1) return true;
  const key = groups.join('-');
  if (key === '4-6-5' || key === '4-6-4') return true;
  return groups.slice(0, -1).every((g) => g === 4) && groups[groups.length - 1] >= 1 && groups[groups.length - 1] <= 4;
}

export function iban(s) {
  const t = s.replace(/\s+/g, '').toUpperCase();
  if (t.length < 15 || t.length > 34) return false;
  const moved = t.slice(4) + t.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    let v;
    if (ch >= '0' && ch <= '9') v = ch.charCodeAt(0) - 48;
    else if (ch >= 'A' && ch <= 'Z') v = ch.charCodeAt(0) - 55;
    else return false;
    rem = v >= 10 ? (rem * 100 + v) % 97 : (rem * 10 + v) % 97;
  }
  return rem === 1;
}

export function clabe(s) {
  const d = digits(s);
  if (d.length !== 18) return false;
  const w = [3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += (d[i] * w[i % 3]) % 10;
  return (10 - (sum % 10)) % 10 === d[17];
}

/** Dígito de verificación del NIT (DIAN): pesos 3,7,13,17,… desde la derecha. */
export function nitCheckDigit(body) {
  if (body.length < 1 || body.length > 15) return null;
  const w = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];
  let sum = 0;
  [...body].reverse().forEach((n, i) => { sum += n * w[i]; });
  const r = sum % 11;
  return r > 1 ? 11 - r : r;
}

export function nit(s) {
  const parts = s.split('-').filter(Boolean);
  if (parts.length !== 2 || parts[1].length !== 1) return false;
  const dv = digits(parts[1])[0];
  const body = digits(parts[0]);
  if (body.length < 6 || body.length > 10) return false;
  return nitCheckDigit(body) === dv;
}

export function cpf(s) {
  const d = digits(s);
  if (d.length !== 11 || new Set(d).size < 2) return false;
  const dv = (n) => {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += d[i] * (n + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === d[9] && dv(10) === d[10];
}

export function cnpj(s) {
  const d = digits(s);
  if (d.length !== 14 || new Set(d).size < 2) return false;
  const dv = (n) => {
    const w = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < n; i++) sum += d[i] * w[i];
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return dv(12) === d[12] && dv(13) === d[13];
}

export function rut(s) {
  const t = s.toUpperCase().replace(/[^0-9K]/g, '');
  if (t.length < 7) return false;
  const last = t[t.length - 1];
  const body = digits(t.slice(0, -1));
  if (body.length !== t.length - 1) return false;
  let sum = 0;
  [...body].reverse().forEach((n, i) => { sum += n * (2 + (i % 6)); });
  const r = 11 - (sum % 11);
  const expected = r === 11 ? '0' : r === 10 ? 'K' : String(r);
  return last === expected;
}

const DNI_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';
export function dniNie(s) {
  let t = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (t.length !== 9) return false;
  const letter = t[8];
  t = t.slice(0, 8);
  const f = 'XYZ'.indexOf(t[0]);
  if (f >= 0) t = String(f) + t.slice(1);
  if (!/^\d{8}$/.test(t)) return false;
  return DNI_LETTERS[Number(t) % 23] === letter;
}

/** Valor tras «cédula», «NIT», «CC»…: al menos 5 dígitos y no es una fecha aaaa-mm-dd. */
export function idValue(s) {
  if (digits(s).length < 5) return false;
  return !/^\d{4}-\d{2}-\d{2}$/.test(s);
}
export const phoneValue = (s) => { const n = digits(s).length; return n >= 7 && n <= 13; };
export const accountValue = (s) => { const d = digits(s); return d.length >= 9 && d.length <= 16 && new Set(d).size > 2; };

// ---------- Reglas (en orden de prioridad de empate) ----------

const ID_PREFIX = String.raw`(?:\bc\.?\s?c\.?|\bc[eé]dula(?:\s+de\s+(?:ciudadan[ií]a|extranjer[ií]a))?|\bdocumento(?:\s+de\s+identidad)?|\bidentificaci[oó]n|\bn\.?i\.?t\.?|\bdni|\bnie|\brut|\brfc|\bcurp|\bcpf|\bcnpj|\bpasaporte|\bpassport|\bssn)\b`;
const PHONE_WORD = String.raw`\b(?:tel[eé]fono|tel|fijo|cel|celular|m[oó]vil|movil|whatsapp|wpp|phone|telefone)\b`;
const ACCOUNT_WORD = String.raw`\b(?:cuenta|cta|ahorros|corriente|account|conta)\b`;

function rule(kind, pattern, { group = 0, ci = false, validate = null } = {}) {
  return { kind, group, validate, re: new RegExp(pattern, 'gd' + (ci ? 'i' : '')) };
}

const RULES = [
  rule('token', String.raw`\bsk-[A-Za-z0-9_\-]{16,}`),
  rule('token', String.raw`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`),
  rule('token', String.raw`\bgh[pousr]_[A-Za-z0-9]{30,}`),
  rule('token', String.raw`\bxox[baprs]-[A-Za-z0-9\-]{10,}`),
  rule('token', String.raw`\bAIza[0-9A-Za-z_\-]{30,}`),
  rule('token', String.raw`\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}`),
  rule('token', String.raw`\bBearer\s+([A-Za-z0-9._\-]{20,})`, { group: 1 }),
  rule('token', String.raw`[?&](?:token|access_token|api_key|apikey|key|secret|sig)=([^&\s]{6,})`, { group: 1, ci: true }),
  rule('password', String.raw`\b(?:password|passwd|pwd|contraseña|clave|senha|pass)\s*[:=]\s*(\S+)`, { group: 1, ci: true }),
  rule('email', String.raw`[A-Za-z0-9._%+\-]+@ ?[A-Za-z0-9.\-]+\.[A-Za-z]{2,}`),
  rule('card', String.raw`(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)`, { validate: card }),
  rule('bank', String.raw`\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b`, { validate: iban }),
  rule('bank', String.raw`(?<!\d)\d{18}(?!\d)`, { validate: clabe }),
  rule('bank', ACCOUNT_WORD + String.raw`[^\d\n]{0,25}?(\d[\d\- ]{7,22}\d)(?![\d])`, { group: 1, ci: true, validate: accountValue }),
  rule('id', ID_PREFIX + String.raw`\s*[:.#]?\s*(?:N[°ºo.]\s*)?([A-Z0-9][A-Z0-9.\-]{4,}[A-Z0-9])`, { group: 1, ci: true, validate: idValue }),
  rule('id', String.raw`(?<![\d.\-])\d{1,3}(?:\.\d{3}){2}-\d(?![\d])`, { validate: nit }),
  rule('id', String.raw`(?<![\d.\-])\d{9,10}-\d(?![\d])`, { validate: nit }),
  rule('id', String.raw`(?<![\d.\-])\d{3}\.\d{3}\.\d{3}-\d{2}(?![\d])`, { validate: cpf }),
  rule('id', String.raw`(?<![\d.\-])\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2}(?![\d])`, { validate: cnpj }),
  rule('id', String.raw`(?<![\d.\-])\d{1,2}\.\d{3}\.\d{3}-[\dkK](?![\w])`, { validate: rut }),
  rule('id', String.raw`(?<![\dA-Za-z])(?:\d{8}|[XYZ]\d{7})[A-HJ-NP-TV-Z](?![\w])`, { validate: dniNie }),
  rule('id', String.raw`(?<![\w])[A-Z]{4}\d{6}[HM][A-Z]{2}[B-DF-HJ-NP-TV-Z]{3}[A-Z0-9]\d(?![\w])`),
  rule('id', String.raw`(?<![\w])[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}(?![\w])`),
  rule('id', String.raw`(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)`),
  rule('ip', String.raw`(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])`),
  rule('phone', String.raw`(?<![\w+])(?:\+|00)57[\s.\-]?3\d{2}[\s.\-]?\d{3}[\s.\-]?\d{4}(?!\d)`),
  rule('phone', String.raw`(?<![\w.\-+])3(?:0\d|1\d|2[0-4]|5[01])\d{7}(?![\d])`),
  rule('phone', String.raw`(?<![\w+])\(?60[1-8]\)?[\s.\-]?\d{3}[\s.\-]?\d{4}(?![\d])`),
  rule('phone', PHONE_WORD + String.raw`\.?\s*[:#]?\s*(\+?\d[\d\s.\-()]{5,18}\d)`, { group: 1, ci: true, validate: phoneValue }),
  rule('phone', String.raw`(?<![\w.])(?<!\d[\s.\-])(?:\+\d{1,3}[\s.\-]?)?(?:\(\d{2,4}\)[\s.\-]?|\d{2,4}[\s.\-])\d{3,5}[\s.\-]\d{3,4}(?!\w)(?![\s.\-]\d)`,
    { validate: (s) => { const n = digits(s).length; return n >= 9 && n <= 14; } }),
];

/** Solo para texto leído por OCR: Tesseract a veces lee la «@» como Q, ©, ® o &, con espacios alrededor («maria.lopez Q example.com»).
 *  Se exige que la parte local tenga un punto, guion bajo o dígito y que el dominio acabe en un TLD conocido, para no tapar de más. */
const OCR_EMAIL = rule('email', String.raw`[A-Za-z0-9_%+\-]*[._0-9][A-Za-z0-9._%+\-]* ?[@Q©®&] ?[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.(?:com|net|org|edu|gov|co|io|ai|app|dev|info|biz|mx|es|br|ar|cl|pe|us|uk|de|fr|it|pt)\b`);

// ---------- Lista propia: sin mayúsculas ni tildes, solo palabras completas ----------

/** Una unidad UTF-16 a la vez, para que los índices del texto plegado sean los del texto original. */
export function fold(s) {
  const out = new Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const code = s.charCodeAt(i);
    if (code < 128) { out[i] = code >= 65 && code <= 90 ? code + 32 : code; continue; }
    if (code >= 0xd800 && code <= 0xdfff) { out[i] = code; continue; }
    const f = c.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    out[i] = f.length === 1 ? f.charCodeAt(0) : code;
  }
  return out;
}

const isWordUnit = (u) => /[\p{L}\p{N}]/u.test(String.fromCharCode(u));

export function termMatches(text, terms) {
  if (!terms || !terms.length) return [];
  const hay = fold(text);
  const out = [];
  for (const term of terms) {
    const needle = fold(term.text.trim());
    if (needle.length < 2 || hay.length < needle.length) continue;
    let i = 0;
    while (i + needle.length <= hay.length) {
      let ok = hay[i] === needle[0];
      for (let k = 1; ok && k < needle.length; k++) if (hay[i + k] !== needle[k]) ok = false;
      if (ok) {
        const end = i + needle.length;
        if ((i === 0 || !isWordUnit(hay[i - 1])) && (end === hay.length || !isWordUnit(hay[end]))) {
          out.push({ kind: term.kind, start: i, end });
          i = end;
          continue;
        }
      }
      i++;
    }
  }
  return out;
}

/**
 * Todo lo sensible de `text`, sin solapes. Si dos candidatos se solapan gana el más largo; en empate, la regla que va antes.
 * `kinds`: conjunto de tipos a buscar (por defecto todos). `terms`: lista propia [{text, kind}].
 */
export function find(text, { terms = [], kinds = null, ocr = false } = {}) {
  const want = (k) => !kinds || kinds.has(k);
  const candidates = [];
  (ocr ? [...RULES, OCR_EMAIL] : RULES).forEach((r, order) => {
    if (!want(r.kind)) return;
    r.re.lastIndex = 0;
    for (const m of text.matchAll(r.re)) {
      const span = r.group === 0 ? [m.index, m.index + m[0].length] : m.indices && m.indices[r.group];
      if (!span || span[1] <= span[0]) continue;
      if (r.validate && !r.validate(text.slice(span[0], span[1]))) continue;
      candidates.push({ kind: r.kind, start: span[0], end: span[1], order });
    }
  });
  for (const m of termMatches(text, terms)) if (want(m.kind)) candidates.push({ ...m, order: RULES.length });
  candidates.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.order - b.order || a.start - b.start);
  const claimed = [];
  const out = [];
  for (const c of candidates) {
    if (claimed.some((x) => Math.min(x.end, c.end) > Math.max(x.start, c.start))) continue;
    claimed.push(c);
    out.push({ kind: c.kind, start: c.start, end: c.end });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** "ma•••": suficiente para reconocerlo en una lista, no para leerlo. */
export const hint = (s) => s.slice(0, 2) + '•••';

/** Etiquetas estables del texto pegado ([CORREO 1]); la tabla solo vive en memoria. */
export class Placeholders {
  constructor() { this.forget(); }
  static normalize(s) { return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''); }
  tag(kind, text) {
    const key = `${kind}|${Placeholders.normalize(text)}`;
    if (this.tags.has(key)) return this.tags.get(key);
    const n = (this.counts[kind] || 0) + 1;
    this.counts[kind] = n;
    const t = `[${MARKER[kind]} ${n}]`;
    this.tags.set(key, t);
    this.originals.set(`${MARKER[kind]} ${n}`, text);
    return t;
  }
  get size() { return this.tags.size; }
  forget() { this.tags = new Map(); this.counts = {}; this.originals = new Map(); }
  /** Devuelve los datos reales a un texto con etiquetas (ignora mayúsculas y espacios); las desconocidas se dejan y se cuentan. */
  restore(text) {
    const markers = new Set(Object.values(MARKER));
    let restored = 0; let unknown = 0;
    const out = text.replace(/\[\s*([A-Za-zÁÉÍÓÚÑáéíóúñ]+)\s+(\d+)\s*\]/g, (whole, name, num) => {
      const key = `${name.toUpperCase()} ${num}`;
      if (this.originals.has(key)) { restored++; return this.originals.get(key); }
      if (markers.has(name.toUpperCase())) unknown++;
      return whole;
    });
    return { text: out, restored, unknown };
  }
}
