// PDF irreversible: cada página se convierte en imagen (pdf.js), se tapa, y se arma un PDF nuevo solo con imágenes JPEG.
// Una caja negra sobre texto vivo dejaría el texto debajo; aquí no queda nada más que píxeles. Sin autor, título, anotaciones ni texto.
import { encode } from './redact.js';
import './raf.js';

const DPI = 200;
const MAX_SIDE = 4200;
export const MAX_PAGES = 40;                      // más páginas pesan demasiado para el navegador: la app de Mac no tiene este tope
const dpiFor = (pages) => (pages > 20 ? 150 : DPI);   // PDF largos: menos resolución para no agotar la memoria

function lib() {
  if (typeof pdfjsLib === 'undefined') throw new Error('No se cargó el lector de PDF.');
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.js', import.meta.url).href;
  return pdfjsLib;
}

export class PdfError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

/** @returns {Promise<{pages: HTMLCanvasElement[], sizes: Array<{w:number,h:number}>}>} tamaños en puntos PDF tal como se ven (rotación aplicada) */
export async function rasterize(data, onPage = null) {
  const L = lib();
  let doc;
  try { doc = await L.getDocument({ data: new Uint8Array(data), isEvalSupported: false, enableXfa: false }).promise; }
  catch (e) {
    if (e && e.name === 'PasswordException') throw new PdfError('locked', 'El PDF tiene contraseña.');
    throw new PdfError('unreadable', 'No se pudo abrir el PDF.');
  }
  if (doc.numPages < 1) throw new PdfError('empty', 'El PDF no tiene páginas.');
  if (doc.numPages > MAX_PAGES) { await doc.destroy(); throw new PdfError('tooMany', `El PDF tiene ${doc.numPages} páginas.`); }
  const dpi = dpiFor(doc.numPages);
  const pages = []; const sizes = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(dpi / 72, MAX_SIDE / Math.max(base.width, base.height));
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(vp.width)); c.height = Math.max(1, Math.round(vp.height));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    pages.push(c); sizes.push({ w: base.width, h: base.height });
    page.cleanup();
    if (onPage) onPage(i, doc.numPages);
  }
  await doc.destroy();
  return { pages, sizes };
}

const enc = new TextEncoder();
const num = (n) => (Math.round(n * 100) / 100).toString();

/** PDF mínimo: un objeto imagen JPEG por página. @param {{jpeg:Uint8Array,w:number,h:number,widthPt:number,heightPt:number}[]} pages */
export function buildPdf(pages) {
  const chunks = []; const offsets = []; let length = 0;
  const push = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; chunks.push(b); length += b.length; };
  const obj = (n, body) => { offsets[n] = length; push(`${n} 0 obj\n`); push(body); push('\nendobj\n'); };
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const total = 2 + pages.length * 3;                       // 1 = catálogo, 2 = páginas, luego imagen, contenido y página por cada una
  const kids = pages.map((_, i) => `${5 + i * 3} 0 R`).join(' ');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  pages.forEach((p, i) => {
    const img = 3 + i * 3; const content = 4 + i * 3; const page = 5 + i * 3;
    offsets[img] = length;
    push(`${img} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`);
    push(p.jpeg); push('\nendstream\nendobj\n');
    const stream = `q ${num(p.widthPt)} 0 0 ${num(p.heightPt)} 0 0 cm /Im0 Do Q`;
    obj(content, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    obj(page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(p.widthPt)} ${num(p.heightPt)}] /Resources << /XObject << /Im0 ${img} 0 R >> >> /Contents ${content} 0 R >>`);
  });
  const xref = length;
  let table = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= total; n++) table += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(length); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/** Páginas ya tapadas (canvas) + su tamaño en puntos → bytes del PDF nuevo. */
export async function pdfFromCanvases(canvases, sizes, quality = 0.85) {
  const pages = [];
  for (let i = 0; i < canvases.length; i++) {
    const blob = await encode(canvases[i], 'image/jpeg', quality);
    pages.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), w: canvases[i].width, h: canvases[i].height, widthPt: sizes[i].w, heightPt: sizes[i].h });
  }
  return buildPdf(pages);
}

/** Todo el texto que se puede extraer de un PDF (para pruebas). */
export async function extractText(bytes) {
  const doc = await lib().getDocument({ data: new Uint8Array(bytes) }).promise;
  let out = '';
  for (let i = 1; i <= doc.numPages; i++) { const t = await (await doc.getPage(i)).getTextContent(); out += t.items.map((x) => x.str).join(' ') + '\n'; }
  await doc.destroy();
  return out;
}
