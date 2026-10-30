// Anonimizador web — la interfaz. Todo se procesa en este navegador: no hay servidor que reciba archivos.
import { t, detect, setLang, getLang } from './i18n.js';
import { find, AUTOMATIC, LISTED, Placeholders } from './rules.js';
import { recognizeLines, langsFor, stopOcr } from './ocr.js';
import { findingsFromLines, manualFinding, redactedCanvas, encode, loadImage } from './redact.js';
import { rasterize, pdfFromCanvases, PdfError, MAX_PAGES } from './pdfio.js';
import { VERSION } from './version.js';

// ---------- utilidades ----------

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (['checked', 'value', 'disabled', 'selected', 'open'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const $ = (sel, root = document) => root.querySelector(sel);

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

const store = {
  get(k, d) { try { const v = localStorage.getItem('anon.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('anon.' + k, JSON.stringify(v)); } catch (e) { /* sin almacenamiento: queda en memoria */ } },
};

const KIND_TITLE = () => ({
  email: t('Correos'), phone: t('Teléfonos'), card: t('Tarjetas'), id: t('Documentos de identidad'), bank: t('Cuentas bancarias'), ip: t('Direcciones IP'),
  token: t('Claves y tokens'), password: t('Contraseñas visibles'), company: t('Empresas (tu lista)'), person: t('Nombres de personas'), custom: t('Otros términos (tu lista)'),
});
const kindWord = (k) => (k === 'company' ? t('Empresa') : k === 'person' ? t('Persona') : t('Otro'));
const hiddenMessage = (n) => (n === 1 ? t('Se ocultó 1 dato sensible') : t('Se ocultaron %@ datos sensibles', n));
const sizeText = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

// ---------- estado ----------

const S = {
  tab: 'files',                // files | text | restore
  stage: 'empty',              // empty | busy | review | done
  busy: { msg: '', pct: null },
  doc: null,                   // { name, isPdf, type, pages:[canvas], sizes:[{w,h}] }
  findings: [], page: 0, after: false, selected: null, afterCache: new Map(),
  result: null,                // { blob, url, name, bytes, hidden, thumb }
  kinds: new Set(store.get('kinds', [...AUTOMATIC, ...LISTED])),
  terms: store.get('terms', []),
  ph: new Placeholders(),
  text: { input: '', findings: [], disabled: new Set(), sampleTerms: [] }, // sampleTerms: la «lista» del ejemplo, solo en memoria
  answer: '',
  newVersion: false,
  net: { requests: [], blocked: 0 },
  dragDepth: 0,
};

const settings = () => ({ kinds: S.kinds, terms: S.terms });
const saveSettings = () => { store.set('kinds', [...S.kinds]); store.set('terms', S.terms); };

// ---------- red: lo que hace esta página (para el panel «Verificar») ----------

(function watchNetwork() {
  const log = (u, how) => { try { S.net.requests.push({ url: new URL(u, location.href).href, how }); } catch (e) { /* ignorar */ } };
  const f = window.fetch.bind(window);
  window.fetch = (input, init) => { log(typeof input === 'string' ? input : input.url, 'fetch'); return f(input, init); };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u, ...rest) { log(u, 'xhr'); return open.call(this, m, u, ...rest); };
  document.addEventListener('securitypolicyviolation', () => { S.net.blocked++; });
})();

// ---------- diálogos ----------

function dialog(title, body, { wide = false, onClose = null } = {}) {
  const dlg = h('dialog', { 'aria-label': title });
  const close = () => { dlg.close(); };
  dlg.append(h('div', { class: 'dh' }, h('h2', {}, title), h('button', { class: 'btn small', onclick: close }, t('Cerrar'))), h('div', { class: 'db' }, body));
  dlg.addEventListener('close', () => { dlg.remove(); if (onClose) onClose(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

function showError(msg) {
  dialog(t('No se pudo continuar'), [h('p', {}, msg), h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: (e) => e.target.closest('dialog').close() }, t('Entendido')))]);
}

// ---------- abrir archivos ----------

const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
const baseName = (n) => n.replace(/\.[^.]+$/, '');

function busy(msg, pct = null) { S.stage = 'busy'; S.busy = { msg, pct }; render(); }

function ocrProgress(prefix) {
  return (m) => {
    if (!m || !m.status) return;
    const map = { 'loading tesseract core': 'Preparando el lector de texto (solo la primera vez)…', 'loading language traineddata': 'Cargando los idiomas del lector (solo la primera vez)…',
      'initializing tesseract': 'Preparando el lector de texto…', 'initializing api': 'Preparando el lector de texto…' };
    if (map[m.status]) { S.busy = { msg: t(map[m.status]), pct: typeof m.progress === 'number' ? m.progress : null }; updateBusy(); }
    else if (m.status === 'recognizing text') { S.busy = { msg: prefix, pct: typeof m.progress === 'number' ? m.progress : null }; updateBusy(); }
  };
}

function updateBusy() {
  const msg = $('#busy-msg'); const bar = $('#busy-bar');
  if (msg) msg.textContent = S.busy.msg;
  if (bar) { if (S.busy.pct == null) bar.removeAttribute('value'); else bar.value = S.busy.pct; }
}

async function openFile(file) {
  if (!file) return;
  S.tab = 'files';
  resetDoc();
  try {
    let doc;
    if (isPdf(file)) {
      busy(t('Abriendo el PDF…'));
      const r = await rasterize(await file.arrayBuffer());
      doc = { name: baseName(file.name), isPdf: true, type: 'application/pdf', pages: r.pages, sizes: r.sizes };
    } else {
      busy(t('Abriendo la imagen…'));
      let canvas;
      try { canvas = await loadImage(file); } catch (e) { throw new Error('image'); }
      doc = { name: baseName(file.name || 'imagen'), isPdf: false, type: /jpe?g/i.test(file.type) ? 'image/jpeg' : 'image/png', pages: [canvas], sizes: [{ w: canvas.width, h: canvas.height }] };
    }
    await scanDoc(doc, settings());
  } catch (e) {
    S.stage = 'empty'; render();
    if (e instanceof PdfError && e.code === 'locked') showError(t('Este PDF tiene contraseña. Ábrelo, quítale la contraseña y vuelve a intentarlo.'));
    else if (e instanceof PdfError && e.code === 'tooMany') showError(t('Este PDF tiene demasiadas páginas para el navegador (máximo %@). Divídelo en partes o usa la app de Mac.', MAX_PAGES));
    else if (e instanceof PdfError && e.code === 'empty') showError(t('Este PDF no tiene páginas.'));
    else if (e && e.message === 'image') showError(t('No pude abrir este archivo. Este navegador abre imágenes PNG, JPEG, WebP, GIF y BMP, y PDF. Las fotos HEIC del iPhone solo abren en Safari: expórtala a JPEG o PNG.'));
    else if (e instanceof PdfError) showError(t('No pude abrir este archivo. Este navegador abre imágenes PNG, JPEG, WebP, GIF y BMP, y PDF. Las fotos HEIC del iPhone solo abren en Safari: expórtala a JPEG o PNG.'));
    else { console.error(e); showError(t('Algo falló al leer el archivo. Vuelve a intentarlo; si pasa otra vez, prueba con otro navegador.')); }
  }
}

async function scanDoc(doc, cfg) {
  S.doc = doc; S.findings = []; S.page = 0; S.after = false; S.selected = null; S.afterCache = new Map();
  const n = doc.pages.length;
  for (let i = 0; i < n; i++) {
    const prefix = n > 1 ? t('Leyendo la página %@ de %@…', i + 1, n) : t('Leyendo el texto de la imagen…');
    S.busy = { msg: prefix, pct: null }; S.stage = 'busy'; render();
    const lines = await recognizeLines(doc.pages[i], { langs: langsFor(getLang()), progress: ocrProgress(prefix) });
    S.findings.push(...findingsFromLines(lines, cfg, i));
  }
  S.findings.sort((a, b) => a.page - b.page || a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  S.stage = 'review'; render();
}

function sampleCanvas() {
  const lines = ['Cliente: Constructora Andina Ltda.', 'Contacto: laura.mejia@andina.example.com', 'Celular 300 123 4567', 'NIT 900.123.456-8', 'Servidor 192.168.10.45 activo', 'Reunión mañana sobre el presupuesto anual'];
  const size = 38; const row = Math.round(size * 2.1);
  const c = document.createElement('canvas'); c.width = 1300; c.height = row * lines.length + 60;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#000'; ctx.font = `${size}px Helvetica, Arial, sans-serif`; ctx.textBaseline = 'top';
  lines.forEach((l, i) => ctx.fillText(l, 30, 30 + i * row));
  return c;
}

async function openSample() {
  S.tab = 'files'; resetDoc();
  const c = sampleCanvas();
  try {
    await scanDoc({ name: t('Ejemplo'), isPdf: false, type: 'image/png', pages: [c], sizes: [{ w: c.width, h: c.height }] },
      { kinds: S.kinds, terms: [...S.terms, { text: 'Constructora Andina Ltda', kind: 'company' }] });
  } catch (e) { console.error(e); S.stage = 'empty'; render(); showError(t('Algo falló al leer el archivo. Vuelve a intentarlo; si pasa otra vez, prueba con otro navegador.')); }
}

function resetDoc() {
  if (S.result && S.result.url) URL.revokeObjectURL(S.result.url);
  S.doc = null; S.findings = []; S.page = 0; S.after = false; S.selected = null; S.afterCache = new Map(); S.result = null; S.stage = 'empty';
}

async function pasteImage() {
  try {
    const items = await navigator.clipboard.read();
    for (const it of items) {
      const type = it.types.find((x) => x.startsWith('image/'));
      if (type) { const blob = await it.getType(type); return openFile(new File([blob], `${t('Imagen pegada')}.png`, { type })); }
    }
    toast(t('No hay ninguna imagen copiada'));
  } catch (e) { toast(t('No pude leer el portapapeles: pega con Ctrl+V (⌘V en Mac) estando en esta página.')); }
}

// ---------- hallazgos y resultado ----------

const enabledCount = () => S.findings.filter((f) => f.enabled).length;
function invalidateAfter() { S.afterCache = new Map(); }

function toggleFinding(id) { const f = S.findings.find((x) => x.id === id); if (f) { f.enabled = !f.enabled; invalidateAfter(); render(); } }
function setAll(on) { S.findings.forEach((f) => { f.enabled = on; }); invalidateAfter(); render(); }

async function anonymize() {
  const doc = S.doc;
  busy(t('Creando la copia…'));
  await new Promise((r) => setTimeout(r, 30));
  const red = doc.pages.map((p, i) => redactedCanvas(p, S.findings.filter((f) => f.page === i)));
  let blob; let ext;
  if (doc.isPdf) { blob = new Blob([await pdfFromCanvases(red, doc.sizes)], { type: 'application/pdf' }); ext = 'pdf'; }
  else { blob = await encode(red[0], doc.type, 0.92); ext = doc.type === 'image/jpeg' ? 'jpg' : 'png'; }
  if (S.result && S.result.url) URL.revokeObjectURL(S.result.url);
  S.result = { blob, url: URL.createObjectURL(blob), name: `${doc.name}-anonimizado.${ext}`, bytes: blob.size, hidden: enabledCount(), thumb: red[0] };
  S.stage = 'done'; render();
  toast(hiddenMessage(S.result.hidden));
}

function download() {
  const a = h('a', { href: S.result.url, download: S.result.name });
  document.body.append(a); a.click(); a.remove();
}

async function copyResult() {
  try {
    await navigator.clipboard.write([new ClipboardItem({ [S.result.blob.type]: S.result.blob })]);
    toast(t('Imagen copiada: pégala donde la necesites'));
  } catch (e) { toast(t('Este navegador no deja copiar la imagen: usa «Descargar».')); }
}

// ---------- vistas: archivos ----------

function dropView() {
  const input = h('input', { type: 'file', accept: 'image/*,application/pdf,.pdf,.heic,.heif', class: 'sr', hidden: true, onchange: (e) => { openFile(e.target.files[0]); e.target.value = ''; } });
  return h('div', { class: 'drop', id: 'drop' },
    h('h1', {}, t('Arrastra aquí una imagen o un PDF')),
    h('p', {}, t('La página busca correos, cédulas, NIT, teléfonos, claves, nombres de personas y lo que tengas en tu lista, y lo tapa con negro en una copia nueva. El original no se toca.')),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary big', onclick: () => input.click() }, t('Elegir archivo…')),
      h('button', { class: 'btn big', onclick: pasteImage }, t('Pegar imagen')),
      h('button', { class: 'btn big', onclick: openSample }, t('Probar con un ejemplo'))),
    h('div', { class: 'hero-note' }, t('Arrastra, revisa, copia.')),
    h('div', { class: 'hero-note' }, t('Tu archivo no sale de este navegador: no hay ningún servidor que lo reciba.'), ' ', h('button', { class: 'linkbtn', onclick: openVerify }, t('Compruébalo'))),
    input);
}

function busyView() {
  return h('div', { class: 'center', role: 'status' }, h('div', { class: 'spinner', 'aria-hidden': true }),
    h('p', { id: 'busy-msg' }, S.busy.msg), h('progress', { id: 'busy-bar', max: 1, value: S.busy.pct == null ? null : S.busy.pct }));
}

function drawStage(canvas) {
  const src = S.doc.pages[S.page];
  canvas.width = src.width; canvas.height = src.height;
  let draw = src;
  if (S.after) {
    if (!S.afterCache.has(S.page)) S.afterCache.set(S.page, redactedCanvas(src, S.findings.filter((f) => f.page === S.page)));
    draw = S.afterCache.get(S.page);
  }
  canvas.getContext('2d').drawImage(draw, 0, 0);
}

function stageView() {
  const src = S.doc.pages[S.page];
  const canvas = h('canvas', { role: 'img', 'aria-label': t('Vista previa de la página') });
  drawStage(canvas);
  const stage = h('div', { class: 'stage' }, canvas);
  const layer = (f, r) => h('div', { class: `box${f.enabled ? '' : ' off'}${S.selected === f.id ? ' sel' : ''}`, 'aria-hidden': true,
    style: `left:${(r.x / src.width) * 100}%;top:${(r.y / src.height) * 100}%;width:${(r.w / src.width) * 100}%;height:${(r.h / src.height) * 100}%` });
  const cajas = (f) => [f.rect, ...(f.more || [])];   // un dato partido en dos renglones tiene dos cajas
  if (!S.after) S.findings.filter((f) => f.page === S.page).forEach((f) => cajas(f).forEach((r) => stage.append(layer(f, r))));

  // arrastrar sobre la imagen = tapar a mano
  let start = null; let temp = null;
  const toImg = (e) => { const b = canvas.getBoundingClientRect(); return { x: ((e.clientX - b.left) / b.width) * src.width, y: ((e.clientY - b.top) / b.height) * src.height }; };
  stage.addEventListener('pointerdown', (e) => { if (S.after || e.button !== 0) return; start = toImg(e); stage.setPointerCapture(e.pointerId); });
  stage.addEventListener('pointermove', (e) => {
    if (!start) return;
    const p = toImg(e); const x = Math.min(start.x, p.x); const y = Math.min(start.y, p.y); const w = Math.abs(p.x - start.x); const hh = Math.abs(p.y - start.y);
    if (!temp) { temp = h('div', { class: 'box sel', 'aria-hidden': true }); stage.append(temp); }
    Object.assign(temp.style, { left: `${(x / src.width) * 100}%`, top: `${(y / src.height) * 100}%`, width: `${(w / src.width) * 100}%`, height: `${(hh / src.height) * 100}%` });
  });
  stage.addEventListener('pointerup', (e) => {
    if (!start) return;
    const p = toImg(e); const rect = { x: Math.max(0, Math.min(start.x, p.x)), y: Math.max(0, Math.min(start.y, p.y)), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
    start = null; if (temp) { temp.remove(); temp = null; }
    if (rect.w > 6 && rect.h > 6) { const f = manualFinding(rect, S.page); S.findings.push(f); S.selected = f.id; invalidateAfter(); render(); }
    else {
      const hit = S.findings.filter((f) => f.page === S.page).find((f) => cajas(f).some((r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h));
      if (hit) { S.selected = hit.id; render(); }
    }
  });
  return stage;
}

function reviewView() {
  const d = S.doc; const n = d.pages.length;
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': t('Ver antes o después') },
    h('button', { 'aria-pressed': String(!S.after), onclick: () => { S.after = false; render(); } }, t('Antes')),
    h('button', { 'aria-pressed': String(S.after), onclick: () => { S.after = true; render(); } }, t('Después')));
  const pager = n > 1 ? [
    h('button', { class: 'btn small', disabled: S.page === 0, 'aria-label': t('Página anterior'), onclick: () => { S.page--; render(); } }, '‹'),
    h('span', {}, t('Página %@ de %@', S.page + 1, n)),
    h('button', { class: 'btn small', disabled: S.page === n - 1, 'aria-label': t('Página siguiente'), onclick: () => { S.page++; render(); } }, '›')] : [];
  const bar = h('div', { class: 'bar' }, seg, pager, h('span', { class: 'spacer' }), h('span', { class: 'muted' }, d.name), h('button', { class: 'btn small', onclick: () => { resetDoc(); render(); } }, t('Cambiar archivo')));
  const wrap = h('div', { class: 'stage-wrap' }, stageView(), S.after ? null : h('div', { class: 'hint-pill' }, t('Arrastra sobre la imagen para tapar algo que no se detectó.')));

  const list = S.findings.length ? h('div', { class: 'list' }, S.findings.map((f) => h('label', { class: `item${S.selected === f.id ? ' sel' : ''}`, onclick: (e) => { if (e.target.tagName !== 'INPUT') { S.selected = f.id; if (f.page !== S.page) S.page = f.page; render(); } } },
    h('input', { type: 'checkbox', checked: f.enabled, 'aria-label': `${KIND_TITLE()[f.kind]}: ${f.manual ? t('Área marcada a mano') : f.hint}`, onchange: () => toggleFinding(f.id) }),
    h('span', {}, h('div', { class: 'hint' }, f.manual ? t('Área marcada a mano') : f.hint), h('div', { class: 'kind' }, n > 1 ? `${KIND_TITLE()[f.kind]} · ${t('pág. %@', f.page + 1)}` : KIND_TITLE()[f.kind]))))) : null;
  const side = h('div', { class: 'side' },
    S.findings.length
      ? [h('div', { class: 'bar', style: 'padding:0;border:0' }, h('h2', {}, t('%@ encontrados', S.findings.length)), h('span', { class: 'spacer' }), h('button', { class: 'linkbtn', onclick: () => setAll(true) }, t('Todos')), h('button', { class: 'linkbtn', onclick: () => setAll(false) }, t('Ninguno'))),
        h('p', { class: 'muted' }, t('Quita la marca de lo que no quieras tapar.')), list]
      : [h('h2', {}, t('No encontré datos sensibles')), h('p', { class: 'muted' }, t('Eso no significa que no haya: revisa la imagen. Si ves algo, arrastra sobre él para taparlo, o añade el término en Ajustes › Mi lista.'))],
    h('div', { class: 'spacer' }),
    h('button', { class: 'btn primary big', onclick: anonymize }, enabledCount() === 0 ? t('Guardar copia sin tapar nada') : t('Anonimizar (%@)', enabledCount())),
    h('p', { class: 'muted' }, d.isPdf ? t('Se crea una copia nueva; el PDF resultante es una imagen y no se podrá buscar ni copiar su texto.') : t('Se crea una copia nueva; el original no se toca.')));
  return h('div', { class: 'review' }, h('div', { class: 'preview-col' }, bar, wrap), side);
}

function resultView() {
  const r = S.result; const d = S.doc;
  const thumb = r.thumb; const img = h('canvas', { class: 'thumb', width: thumb.width, height: thumb.height, role: 'img', 'aria-label': t('Copia anonimizada; arrástrala a donde la necesites') });
  img.getContext('2d').drawImage(thumb, 0, 0);
  if (!d.isPdf) {
    img.draggable = true;
    img.addEventListener('dragstart', (e) => { e.dataTransfer.setData('DownloadURL', `${r.blob.type}:${r.name}:${r.url}`); });
  }
  return h('div', { class: 'result' },
    h('div', { class: 'ok', 'aria-hidden': true }, '✓'), h('h1', {}, hiddenMessage(r.hidden)), img,
    h('div', { class: 'mono' }, `${r.name} · ${sizeText(r.bytes)}`),
    d.isPdf ? h('p', { class: 'muted' }, t('Este PDF ahora es una imagen: ya no se puede buscar ni copiar su texto. Tamaño: %@', sizeText(r.bytes))) : null,
    h('div', { class: 'row' },
      h('button', { class: 'btn primary big', onclick: download }, t('Descargar')),
      d.isPdf ? null : h('button', { class: 'btn big', onclick: copyResult }, t('Copiar')),
      h('button', { class: 'btn big', onclick: () => { S.stage = 'review'; render(); } }, t('Volver a revisar')),
      h('button', { class: 'btn big', onclick: () => { resetDoc(); render(); } }, t('Anonimizar otro'))),
    h('p', { class: 'warnline' }, '⚠ ' + t('Revisa el resultado antes de compartirlo: la lectura del texto puede fallar y algún dato podría no taparse.')));
}

// ---------- vistas: texto y devolver ----------

// El mismo ejemplo que muestra la página de presentación. La empresa solo se tapa si está en la lista
// (las empresas no se adivinan), así que el ejemplo trae su propia lista, que no se guarda.
const TEXT_SAMPLE = 'Resuma este correo para mi jefe. Cliente: Constructora Andina Ltda. Contacto: laura.mejia@andina.example.com, celular 300 123 4567. NIT 900.123.456-8.';
const TEXT_SAMPLE_TERMS = [{ text: 'Constructora Andina Ltda', kind: 'company' }];

function scanText() {
  const text = S.text.input.normalize('NFC');
  const found = find(text, { ...settings(), terms: [...S.terms, ...S.text.sampleTerms] }).map((m) => {
    const original = text.slice(m.start, m.end);
    return { ...m, original, tag: S.ph.tag(m.kind, original), key: `${m.kind}|${Placeholders.normalize(original)}` };
  });
  found.forEach((f) => { f.enabled = !S.text.disabled.has(f.key); });
  S.text.findings = found; S.text.norm = text;
}
function textOutput() {
  let out = S.text.norm ?? ''; const fs = S.text.findings.filter((f) => f.enabled).sort((a, b) => b.start - a.start);
  for (const f of fs) out = out.slice(0, f.start) + f.tag + out.slice(f.end);
  return out;
}

function updateTextPanes() {
  scanText();
  const out = $('#text-out'); if (out) out.textContent = textOutput();
  const tags = $('#text-tags'); if (!tags) return;
  tags.replaceChildren();
  if (!S.text.findings.length) {
    tags.append(h('p', { class: 'muted' }, S.text.input ? t('No encontré datos sensibles en este texto. Revísalo igual.') : t('Pega un texto: se actualiza solo.')));
  } else {
    tags.append(h('h2', {}, t('%@ encontrados — quita la marca de lo que no quieras tapar', S.text.findings.length)),
      h('div', { class: 'tags' }, S.text.findings.map((f) => h('label', { class: 'item' },
        h('input', { type: 'checkbox', checked: f.enabled, 'aria-label': `${KIND_TITLE()[f.kind]}: ${f.original.slice(0, 2)}•••`, onchange: () => { if (f.enabled) S.text.disabled.add(f.key); else S.text.disabled.delete(f.key); updateTextPanes(); } }),
        h('span', { class: 'hint' }, `${f.original.slice(0, 2)}•••`), h('span', {}, '→'), h('span', { class: 'hint' }, f.tag), h('span', { class: 'spacer' }), h('span', { class: 'kind' }, KIND_TITLE()[f.kind])))));
  }
  const sample = $('#text-sample'); if (sample) sample.hidden = S.text.sampleTerms.length === 0;
  const mem = $('#text-mem'); if (mem) mem.textContent = S.ph.size === 0 ? t('Las equivalencias solo viven en esta sesión.') : t('Recuerdo %@ equivalencias (solo en memoria).', S.ph.size);
  const forget = $('#text-forget'); if (forget) forget.disabled = S.ph.size === 0;
}

function textView() {
  let timer = null;
  const ta = h('textarea', { class: 'txt', id: 'text-in', 'aria-label': t('Texto original'), placeholder: t('Pega aquí el texto que vas a enviar a una IA (⌘V) y verás al instante cómo queda.'), spellcheck: 'false',
    oninput: (e) => { S.text.input = e.target.value; clearTimeout(timer); timer = setTimeout(updateTextPanes, 120); } });
  ta.value = S.text.input;
  const left = h('div', { class: 'pane' }, h('div', { class: 'head' }, h('h2', {}, t('Texto original')), h('span', {}, h('button', { class: 'btn small', onclick: async () => { try { ta.value = await navigator.clipboard.readText(); S.text.input = ta.value; updateTextPanes(); } catch (e) { toast(t('No pude leer el portapapeles: pega con Ctrl+V (⌘V en Mac) estando en esta página.')); } } }, t('Pegar')), ' ',
    h('button', { class: 'btn small', onclick: () => { S.text.sampleTerms = TEXT_SAMPLE_TERMS; ta.value = TEXT_SAMPLE; S.text.input = TEXT_SAMPLE; updateTextPanes(); } }, t('Probar con un ejemplo')), ' ',
    h('button', { class: 'btn small', onclick: () => { ta.value = ''; S.text.input = ''; S.text.sampleTerms = []; updateTextPanes(); } }, t('Borrar')))), ta);
  const right = h('div', { class: 'pane' }, h('div', { class: 'head' }, h('h2', {}, t('Texto anonimizado')),
    h('button', { class: 'btn small primary', onclick: async () => { try { await navigator.clipboard.writeText(textOutput()); const n = S.text.findings.filter((f) => f.enabled).length; toast(n === 0 ? t('Texto copiado (no había nada que ocultar)') : t('Copiado: %@', hiddenMessage(n))); } catch (e) { toast(t('Este navegador no dejó copiar: selecciona el texto y cópialo a mano.')); } } }, t('Copiar resultado'))),
  h('div', { class: 'out', id: 'text-out', 'aria-label': t('Texto anonimizado'), tabindex: 0 }),
  h('p', { class: 'muted', id: 'text-sample', hidden: true }, t('En el ejemplo, «Constructora Andina Ltda» cuenta como una empresa de tu lista: las empresas solo se tapan si están en ella. Agrega las tuyas en Ajustes › Mi lista.')),
  h('div', { id: 'text-tags' }),
  h('div', { class: 'head' }, h('span', { class: 'muted', id: 'text-mem' }), h('button', { class: 'btn small', id: 'text-forget', onclick: () => { S.ph.forget(); S.text.disabled.clear(); updateTextPanes(); toast(t('Listo: se olvidaron todas las equivalencias')); } }, t('Olvidar todo'))));
  queueMicrotask(updateTextPanes);
  return h('div', { class: 'two' }, left, right);
}

function updateRestorePanes() {
  const r = S.ph.restore(S.answer.normalize('NFC'));
  const out = $('#rest-out'); if (out) out.textContent = r.text;
  const st = $('#rest-status'); if (!st) return;
  st.replaceChildren();
  if (S.ph.size === 0) st.append(h('p', { class: 'muted' }, t('No recuerdo ninguna equivalencia. Primero anonimiza un texto en la pestaña «Texto» y envíalo a la IA.')));
  else if (S.answer) {
    st.append(h('p', {}, t('Se devolvieron %@ datos.', r.restored)));
    if (r.unknown > 0) st.append(h('p', { class: 'warnline' }, t('Etiquetas que no reconozco: %@ (¿pulsaste «Olvidar todo» o vienen de otra sesión?).', r.unknown)));
  }
  st.append(h('div', { class: 'head' }, h('span', { class: 'muted' }, t('Recuerdo %@ equivalencias (solo en memoria).', S.ph.size)), h('button', { class: 'btn small', disabled: S.ph.size === 0, onclick: () => { S.ph.forget(); updateRestorePanes(); } }, t('Olvidar todo'))));
  S.restored = r.text;
}

function restoreView() {
  let timer = null;
  const ta = h('textarea', { class: 'txt', 'aria-label': t('Respuesta de la IA'), placeholder: t('Pega aquí la respuesta de la IA (⌘V): las etiquetas como [CORREO 1] volverán a ser los datos reales.'), spellcheck: 'false',
    oninput: (e) => { S.answer = e.target.value; clearTimeout(timer); timer = setTimeout(updateRestorePanes, 120); } });
  ta.value = S.answer;
  const left = h('div', { class: 'pane' }, h('div', { class: 'head' }, h('h2', {}, t('Respuesta de la IA')), h('button', { class: 'btn small', onclick: () => { ta.value = ''; S.answer = ''; updateRestorePanes(); } }, t('Borrar'))), ta);
  const right = h('div', { class: 'pane' }, h('div', { class: 'head' }, h('h2', {}, t('Con los datos reales')),
    h('button', { class: 'btn small primary', onclick: async () => { try { await navigator.clipboard.writeText(S.restored || ''); toast(t('Copiado con los datos reales: no lo compartas')); } catch (e) { toast(t('Este navegador no dejó copiar: selecciona el texto y cópialo a mano.')); } } }, t('Copiar resultado'))),
  h('div', { class: 'out', id: 'rest-out', tabindex: 0, 'aria-label': t('Con los datos reales') }), h('div', { id: 'rest-status' }));
  queueMicrotask(updateRestorePanes);
  return h('div', { class: 'col', style: 'display:flex;flex-direction:column;flex:1;min-height:0' },
    h('div', { class: 'alert' }, '⚠ ', t('Aquí aparecen los datos reales. Úsalo para ti: no compartas ni proyectes este resultado.')), h('div', { class: 'two' }, left, right));
}

// ---------- ajustes, ayuda, verificación, introducción ----------

function openSettings() {
  const body = h('div', { style: 'display:contents' });
  const draw = () => {
    body.replaceChildren(
      h('section', {}, h('h3', {}, t('Qué se oculta')), h('p', { class: 'muted' }, t('Marca lo que quieres que la página busque. Lo que quites no se tapa ni se cambia.')),
        h('div', { class: 'grid2' }, [...AUTOMATIC, ...LISTED].map((k) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: S.kinds.has(k), onchange: (e) => { if (e.target.checked) S.kinds.add(k); else S.kinds.delete(k); saveSettings(); if (S.tab === 'text') updateTextPanes(); } }), KIND_TITLE()[k])))),
      h('section', {}, h('h3', {}, t('Mi lista')), h('p', { class: 'muted' }, t('Empresas, clientes, personas o proyectos que siempre se ocultan. No importan mayúsculas ni tildes. Se guarda solo en este navegador.')),
        (() => {
          const inp = h('input', { type: 'text', 'aria-label': t('Nuevo término'), placeholder: t('Ej.: Constructora Andina') });
          const sel = h('select', { 'aria-label': t('Tipo de término') }, LISTED.map((k) => h('option', { value: k }, kindWord(k))));
          const add = () => { const v = inp.value.trim(); if (v.length < 2 || S.terms.some((x) => Placeholders.normalize(x.text) === Placeholders.normalize(v))) return; S.terms.push({ text: v, kind: sel.value }); saveSettings(); draw(); if (S.tab === 'text') updateTextPanes(); };
          inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
          return h('div', { class: 'row', style: 'justify-content:flex-start' }, inp, sel, h('button', { class: 'btn', onclick: add }, t('Añadir')));
        })(),
        S.terms.length ? S.terms.map((x, i) => h('div', { class: 'termrow' }, h('span', {}, x.text), h('span', { class: 'muted' }, kindWord(x.kind)), h('span', { class: 'spacer' }),
          h('button', { class: 'btn small', 'aria-label': t('Quitar %@', x.text), onclick: () => { S.terms.splice(i, 1); saveSettings(); draw(); } }, '✕'))) : h('p', { class: 'muted' }, t('Todavía no hay nada en tu lista.'))),
      h('section', {}, h('h3', {}, t('Idioma')),
        h('select', { 'aria-label': t('Idioma'), onchange: async (e) => { await setLang(e.target.value); document.querySelector('dialog')?.close(); render(); } },
          [['es', 'Español'], ['en', 'English'], ['pt', 'Português (Brasil)']].map(([v, n]) => h('option', { value: v, selected: getLang() === v }, n)))),
      h('section', {}, h('h3', {}, t('Privacidad')), h('p', { class: 'muted' }, t('La página no guarda lo que encuentra: ni en el navegador ni en ningún servidor. Solo recuerda tus ajustes y tu lista, en este navegador. Las equivalencias del texto viven en memoria hasta que pulses «Olvidar todo» o cierres la pestaña.')),
        h('button', { class: 'btn', onclick: () => { if (confirm(t('¿Borrar tus ajustes y tu lista de este navegador?'))) { try { localStorage.clear(); } catch (e) { /* ignorar */ } S.kinds = new Set([...AUTOMATIC, ...LISTED]); S.terms = []; draw(); } } }, t('Borrar mis ajustes y mi lista'))));
  };
  draw();
  dialog(t('Ajustes'), body);
}

const HELP = () => [
  [t('Cómo se usa'), t('Arrastra una imagen o un PDF a la ventana, o pega un texto. La página marca lo sensible; quita la marca de lo que no debe taparse y pulsa «Anonimizar». Sale una copia nueva lista para descargar, arrastrar a la IA o copiar.')],
  [t('Qué busca la página'), t('Correos, teléfonos (incluidos celulares y fijos de Colombia), tarjetas, documentos (cédula, NIT, RUT, CPF, DNI y otros), cuentas bancarias, direcciones IP, claves y tokens, contraseñas escritas con «clave:» o «password:», nombres de personas (por lo que los rodea, como «la señora…», «Nombre:» o la firma, o por un nombre común seguido de apellido) y los términos de tu lista.')],
  [t('Qué NO detecta'), t('Empresas que no estén en tu lista, nombres de personas sin nada que los anuncie (como «Reunión con Juan»), contraseñas escritas con puntos, texto muy pequeño o borroso, y números de documento sueltos sin ninguna palabra que los acompañe (como «cédula» o «NIT»). Por eso siempre hay que revisar.')],
  [t('Tapar a mano'), t('Si ves algo que la página no marcó, arrastra el ratón (o el dedo) sobre la imagen para dibujar un recuadro: se tapa igual que lo demás.')],
  [t('PDF: qué cambia'), t('Cada página se convierte en imagen, se tapa y se arma un PDF nuevo. Así lo tapado no se puede recuperar ni copiar. A cambio, el PDF nuevo ya no se puede buscar ni seleccionar texto, y pesa más. Se borran autor, título y demás metadatos.')],
  [t('Texto pegado y marcadores'), t('Cada dato se cambia por una etiqueta como [CORREO 1] o [EMPRESA 1]. El mismo dato recibe siempre la misma etiqueta mientras la pestaña esté abierta. «Olvidar todo» borra esa memoria.')],
  [t('Devolver los datos reales'), t('Después de enviar un texto anonimizado a la IA, pega su respuesta en la pestaña «Devolver»: las etiquetas como [CORREO 1] vuelven a ser los datos reales. Funciona solo mientras esta pestaña siga abierta. Ese resultado muestra datos reales: úsalo para ti.')],
  [t('Mi lista'), t('En Ajustes › Mi lista añade las empresas, clientes, personas o proyectos que siempre deben ocultarse. No importan las mayúsculas ni las tildes, pero sí que sea la palabra completa.')],
  [t('Privacidad y cómo comprobarla'), t('Todo se procesa dentro de tu navegador: no hay servidor que reciba archivos y el navegador bloquea cualquier envío a otros sitios. Puedes comprobarlo en «Verificar»: prepara la página para usarla sin conexión, desconecta internet y verás que todo sigue funcionando.')],
  [t('Navegadores y límites'), t('Funciona en Chrome, Edge, Firefox y Safari recientes, en computador y celular. La lectura del texto es menos precisa que en la app de escritorio para Mac, sobre todo con letra pequeña, borrosa o inclinada. Un PDF puede tener hasta %@ páginas. No abre vídeos ni fotos HEIC (fuera de Safari).', MAX_PAGES)],
  [t('Un recordatorio importante'), t('La página reduce el riesgo, no lo elimina. La lectura del texto puede fallar y alguna regla puede dejar pasar un dato. Mira siempre el resultado antes de compartirlo.')],
];

function openHelp() {
  const q = h('input', { type: 'search', 'aria-label': t('Buscar en la ayuda'), placeholder: t('Buscar en la ayuda') });
  const box = h('div', { style: 'display:flex;flex-direction:column;gap:16px' });
  const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const draw = () => {
    const words = fold(q.value).split(/\s+/).filter(Boolean);
    const found = HELP().filter(([a, b]) => { const hay = fold(`${a} ${b}`); return words.every((w) => hay.includes(w)); });
    box.replaceChildren(...(found.length ? found.map(([a, b]) => h('div', { class: 'help-item' }, h('h3', {}, a), h('p', { class: 'muted', style: 'margin:0' }, b))) : [h('p', { class: 'muted' }, t('No hay resultados.'))]));
  };
  q.addEventListener('input', draw); draw();
  dialog(t('Ayuda'), [h('div', { class: 'row', style: 'justify-content:flex-start' }, q, h('button', { class: 'btn', onclick: (e) => { e.target.closest('dialog').close(); openIntro(); } }, t('Ver la introducción'))), box]);
}

function openIntro() {
  store.set('intro', true);
  const close = (e) => e.target.closest('dialog').close();
  dialog(t('Arrastra, revisa, copia'), [
    h('p', {}, t('Tapa los datos sensibles antes de subir un archivo a una IA. Todo pasa en tu navegador.')),
    h('div', { class: 'steps' }, h('div', {}, h('strong', {}, '1. ' + t('Arrastra')), h('p', { class: 'muted' }, t('Una imagen, un PDF, o pega un texto.'))),
      h('div', {}, h('strong', {}, '2. ' + t('Revisa')), h('p', { class: 'muted' }, t('Quita la marca de lo que no deba taparse, o tapa a mano lo que falte.'))),
      h('div', {}, h('strong', {}, '3. ' + t('Copia')), h('p', { class: 'muted' }, t('Sale una copia nueva, lista para arrastrar a la IA. El original no se toca.')))),
    h('p', { class: 'warnline' }, t('La página reduce el riesgo; no lo elimina. Revisa siempre antes de compartir.')),
    h('div', { class: 'row' }, h('button', { class: 'btn big', onclick: (e) => { close(e); openSample(); } }, t('Probar con un ejemplo')), h('button', { class: 'btn primary big', onclick: close }, t('Empezar')))]);
}

function openVerify() {
  const box = h('div', { style: 'display:contents' });
  let offlineMsg = '';
  const draw = () => {
    const res = performance.getEntriesByType('resource').map((r) => r.name);
    const same = (u) => { try { return new URL(u).origin === location.origin; } catch (e) { return true; } };
    const outside = [...res, ...S.net.requests.map((r) => r.url)].filter((u) => !same(u));
    box.replaceChildren(
      h('p', {}, t('Esta página no tiene ningún servidor que reciba tus archivos: son solo archivos estáticos. Además, el navegador tiene una regla (política de seguridad del contenido) que le prohíbe enviar datos a cualquier otro sitio.')),
      h('section', {}, h('h3', {}, t('Lo que ha hecho esta página desde que la abriste')),
        h('ul', { class: 'plain' },
          h('li', {}, t('Archivos cargados de este mismo sitio: %@', res.length)),
          h('li', {}, outside.length === 0 ? h('span', { class: 'tag-ok' }, t('Conexiones a otros sitios: 0')) : h('span', { class: 'warnline' }, t('Conexiones a otros sitios: %@', outside.length))),
          h('li', {}, t('Envíos bloqueados por el navegador: %@', S.net.blocked)),
          h('li', {}, navigator.onLine ? t('Ahora estás en línea.') : t('Ahora estás sin conexión (y la página sigue funcionando).')))),
      h('section', {}, h('h3', {}, t('Compruébalo tú en 1 minuto')),
        h('ol', { class: 'plain' },
          h('li', {}, t('Pulsa «Preparar para usar sin conexión» (descarga el lector de texto, unos 10 MB, una sola vez).')),
          h('li', {}, t('Desconecta el internet de tu equipo (modo avión).')),
          h('li', {}, t('Carga una imagen o un PDF y anonimízalo: todo debe seguir funcionando.')),
          h('li', {}, t('Opcional: abre las herramientas del navegador (F12 › Red) y mira que no haya ninguna petición a otros dominios.'))),
        h('div', { class: 'row', style: 'justify-content:flex-start' }, h('button', { class: 'btn', id: 'prep', onclick: () => prepareOffline((m) => { offlineMsg = m; const p = $('#prep-msg'); if (p) p.textContent = m; }) }, t('Preparar para usar sin conexión')), h('span', { class: 'muted', id: 'prep-msg' }, offlineMsg))),
      h('section', {}, h('h3', {}, t('Lo que esto NO demuestra')), h('p', { class: 'muted' }, t('Demuestra lo que hace esta página en tu navegador. No controla lo que hagan las extensiones que tengas instaladas ni el equipo en el que la abras. Si tu empresa lo exige, puede pedirle a sistemas que revise el código o que aloje la página dentro de la red de la empresa.'))),
      h('p', { class: 'muted' }, `${t('Versión')} ${VERSION}`));
  };
  draw();
  dialog(t('Verifica que nada sale de tu equipo'), box);
}

function prepareOffline(report) {
  if (!('serviceWorker' in navigator)) { report(t('Este navegador no permite usar la página sin conexión.')); return; }
  navigator.serviceWorker.ready.then((reg) => {
    const onMsg = (e) => {
      if (!e.data || e.data.type !== 'offline-progress') return;
      report(e.data.done === e.data.total ? t('Listo: ya puedes usarla sin conexión.') : t('Descargando… %@ de %@', e.data.done, e.data.total));
      if (e.data.done === e.data.total) navigator.serviceWorker.removeEventListener('message', onMsg);
    };
    navigator.serviceWorker.addEventListener('message', onMsg);
    report(t('Descargando…'));
    (reg.active || navigator.serviceWorker.controller).postMessage({ type: 'prepare-offline' });
  });
}

// ---------- estructura y pintado ----------

// ¿Hay algo que se perdería al salir? (todo vive en memoria: archivo cargado, texto escrito, respuesta pegada)
const hayTrabajoAbierto = () => S.stage !== 'empty' || S.text.input.trim() !== '' || S.answer.trim() !== '';

function header() {
  const tab = (id, label) => h('button', { role: 'tab', 'aria-selected': String(S.tab === id), onclick: () => { S.tab = id; render(); } }, label);
  return h('header', { class: 'top' },
    // El logotipo lleva a la página de inicio, que está una carpeta más arriba (../): la herramienta vive en /herramienta/.
    h('a', { class: 'brand', href: '../', title: t('Volver a la página de inicio'),
      onclick: (e) => { if (hayTrabajoAbierto() && !confirm(t('¿Volver al inicio? Se cierra lo que tienes abierto; no se guarda nada.'))) e.preventDefault(); } },
      h('img', { src: 'icons/icon-192.png', alt: '' }), 'Anonimizador'),
    h('div', { class: 'tabs', role: 'tablist', 'aria-label': t('Qué quieres anonimizar') }, tab('files', t('Archivos')), tab('text', t('Texto')), tab('restore', t('Devolver'))),
    h('span', { class: 'spacer' }),
    h('button', { class: 'linkbtn', onclick: openVerify }, '🔒 ' + t('Verificar')),
    h('button', { class: 'linkbtn', onclick: openHelp }, t('Ayuda')),
    h('button', { class: 'linkbtn', onclick: openSettings }, t('Ajustes')));
}

function footer() {
  return h('footer', { class: 'bottom' },
    h('span', {}, '🔒 ' + t('Todo se procesa en tu navegador; nada se sube a internet.')),
    h('span', { class: 'strong' }, t('Puede dejar pasar algo: revisa antes de compartir.')),
    h('span', {}, `v${VERSION}`));
}

function render() {
  const app = $('#app');
  let view;
  if (S.tab === 'text') view = textView();
  else if (S.tab === 'restore') view = restoreView();
  else if (S.stage === 'busy') view = busyView();
  else if (S.stage === 'review') view = reviewView();
  else if (S.stage === 'done') view = resultView();
  else view = dropView();
  app.replaceChildren(...[header(),
    S.newVersion ? h('div', { class: 'banner', role: 'status' }, t('Hay una versión nueva de esta página.'), h('button', { class: 'btn small primary', onclick: () => location.reload() }, t('Actualizar'))) : null,
    h('main', { id: 'main' }, view), footer()].filter(Boolean));
}

// ---------- arrastrar y soltar en toda la ventana ----------

window.addEventListener('dragenter', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { S.dragDepth++; $('#drop')?.classList.add('over'); } });
window.addEventListener('dragleave', () => { S.dragDepth = Math.max(0, S.dragDepth - 1); if (!S.dragDepth) $('#drop')?.classList.remove('over'); });
window.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  S.dragDepth = 0; $('#drop')?.classList.remove('over');
  const files = e.dataTransfer && e.dataTransfer.files; if (!files || !files.length) return;
  e.preventDefault();
  if (files.length > 1) toast(t('Procesé solo el primer archivo: esta versión trabaja con uno a la vez.'));
  openFile(files[0]);
});
window.addEventListener('paste', (e) => {
  if (S.tab !== 'files' || ['TEXTAREA', 'INPUT'].includes(document.activeElement?.tagName)) return;
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/') || i.type === 'application/pdf');
  if (item) { e.preventDefault(); openFile(item.getAsFile()); }
});

// ---------- arranque: idioma, versión, sin conexión ----------

async function checkVersion() {
  try {
    const v = await (await fetch(new URL('../version.json', import.meta.url), { cache: 'no-store' })).json();
    if (v.version && v.version !== VERSION) { S.newVersion = true; render(); }
  } catch (e) { /* sin conexión: nada que comprobar */ }
}

function registerWorker() {
  if (!('serviceWorker' in navigator) || !/^https:|^http:\/\/(localhost|127\.0\.0\.1)/.test(location.href)) return;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (w) w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) { S.newVersion = true; render(); } });
    });
  }).catch(() => { /* la página funciona igual, solo no queda disponible sin conexión */ });
}

(async function start() {
  await setLang(detect(), { save: false });
  render();
  if (!store.get('intro', false)) setTimeout(openIntro, 300);
  registerWorker();
  checkVersion();
  window.__anon = { S, openFile, openSample, render };       // para las pruebas en el navegador
})();
window.addEventListener('pagehide', () => { stopOcr(); });
