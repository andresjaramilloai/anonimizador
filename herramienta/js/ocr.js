// Lector de texto de imágenes (Tesseract compilado a WebAssembly, corre en el navegador; los archivos del lector viven en vendor/).
// Devuelve líneas con sus palabras y cajas en píxeles de la imagen original (origen arriba-izquierda), como el OCR de Mac.

const here = new URL('../', import.meta.url);
const url = (p) => new URL(p, here).href;

let worker = null;
let workerLangs = '';
let loading = null;
let onProgress = null;

/** Idiomas del lector: español e inglés siempre (los datos suelen estar en uno de los dos); portugués si la interfaz está en portugués. */
export function langsFor(uiLang) { return uiLang === 'pt' ? 'por+spa+eng' : 'spa+eng'; }

export async function getWorker(langs = 'spa+eng', progress = null) {
  onProgress = progress;
  if (worker && workerLangs === langs) return worker;
  if (loading) await loading;
  if (worker && workerLangs === langs) return worker;
  loading = (async () => {
    if (worker) { await worker.terminate(); worker = null; }
    if (typeof Tesseract === 'undefined') throw new Error('No se cargó el lector de texto.');
    worker = await Tesseract.createWorker(langs, 1, {
      workerPath: url('vendor/tesseract/worker.min.js'),
      corePath: url('vendor/tesseract/'),
      langPath: url('vendor/tessdata/'),
      workerBlobURL: false,
      cacheMethod: 'none',
      logger: (m) => { if (onProgress) onProgress(m); },
    });
    workerLangs = langs;
  })();
  try { await loading; } finally { loading = null; }
  return worker;
}

/** Amplía las imágenes pequeñas: el lector acierta mucho más con letra de 20 px o más. */
export function prepare(canvas, minSide = 2000) {
  const big = Math.max(canvas.width, canvas.height);
  if (big >= minSide) return { canvas, scale: 1 };
  const scale = Math.min(3, Math.ceil((minSide / big) * 2) / 2);
  const c = document.createElement('canvas');
  c.width = Math.round(canvas.width * scale); c.height = Math.round(canvas.height * scale);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, c.width, c.height);
  return { canvas: c, scale };
}

/** @returns {Promise<Array<{text:string, rect:{x:number,y:number,w:number,h:number}, words:Array<{text:string, rect:object}>}>>} */
export async function recognizeLines(canvas, { langs = 'spa+eng', progress = null, minSide = 2000, psm = null } = {}) {
  const w = await getWorker(langs, progress);
  if (psm !== null) await w.setParameters({ tessedit_pageseg_mode: String(psm) });
  const { canvas: src, scale } = prepare(canvas, minSide);
  const { data } = await w.recognize(src, {}, { blocks: true });
  const toRect = (b) => ({ x: b.x0 / scale, y: b.y0 / scale, w: (b.x1 - b.x0) / scale, h: (b.y1 - b.y0) / scale });
  const lines = [];
  // `para` y `n`: el párrafo de cada renglón y su orden dentro de él (para unir datos partidos en dos renglones).
  (data.blocks || []).forEach((block, bi) => (block.paragraphs || []).forEach((para, pi) => {
    let n = 0;
    for (const line of para.lines || []) {
      const words = (line.words || []).filter((x) => x.text && x.text.trim()).map((x) => ({ text: x.text.trim(), rect: toRect(x.bbox), conf: x.confidence }));
      if (!words.length) continue;
      lines.push({ text: words.map((x) => x.text).join(' '), rect: toRect(line.bbox), words, para: `${bi}.${pi}`, n: n++ });
    }
  }));
  lines.sort((a, b) => (Math.abs(a.rect.y + a.rect.h / 2 - (b.rect.y + b.rect.h / 2)) > Math.min(a.rect.h, b.rect.h) * 0.5 ? a.rect.y - b.rect.y : a.rect.x - b.rect.x));
  return lines;
}

export const linesText = (lines) => lines.map((l) => l.text).join('\n');

export async function stopOcr() { if (worker) { await worker.terminate(); worker = null; workerLangs = ''; } }
