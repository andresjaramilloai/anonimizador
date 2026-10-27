// Hallazgos sobre una imagen y tapado con negro sólido (puerto de Image/Redaction.swift y ImageTools.swift).
import { find, hint } from './rules.js';

/** La caja que cubre `[start,end)` dentro de `line` (las palabras tocadas aportan solo la parte cubierta). */
export function rectOf(start, end, line) {
  let pos = 0; let box = null;
  for (const w of line.words) {
    const ws = pos; const we = pos + w.text.length;
    pos = we + 1;                                   // el texto de la línea une las palabras con un espacio
    const a = Math.max(start, ws); const b = Math.min(end, we);
    if (b <= a) continue;
    const fa = (a - ws) / Math.max(w.text.length, 1); const fb = (b - ws) / Math.max(w.text.length, 1);
    const part = { x0: w.rect.x + w.rect.w * fa, y0: w.rect.y, x1: w.rect.x + w.rect.w * fb, y1: w.rect.y + w.rect.h };
    box = box ? { x0: Math.min(box.x0, part.x0), y0: Math.min(box.y0, part.y0), x1: Math.max(box.x1, part.x1), y1: Math.max(box.y1, part.y1) } : part;
  }
  return box ? { x: box.x0, y: box.y0, w: box.x1 - box.x0, h: box.y1 - box.y0 } : null;
}

let nextId = 1;
/** Hallazgos de las líneas leídas de una página. `text` solo vive en memoria; en pantalla se muestra `hint`. */
export function findingsFromLines(lines, settings, page = 0) {
  const out = [];
  for (const line of lines) {
    for (const m of find(line.text, { ...settings, ocr: true })) {
      const rect = rectOf(m.start, m.end, line);
      if (!rect) continue;
      const text = line.text.slice(m.start, m.end);
      out.push({ id: nextId++, kind: m.kind, text, hint: hint(text), rect, page, enabled: true, manual: false });
    }
  }
  return out;
}

export function manualFinding(rect, page) {
  return { id: nextId++, kind: 'custom', text: '', hint: '', rect, page, enabled: true, manual: true };
}

/** Un margen alrededor de la caja: las cajas del lector son ajustadas y podría quedar un trozo de letra fuera. */
export function padded(r, W, H) {
  const dx = Math.max(3, r.h * 0.15); const dy = Math.max(3, r.h * 0.18);
  const x0 = Math.max(0, r.x - dx); const y0 = Math.max(0, r.y - dy);
  const x1 = Math.min(W, r.x + r.w + dx); const y1 = Math.min(H, r.y + r.h + dy);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** Copia de `src` con rectángulos negros sólidos: los píxeles se reemplazan, no se tapan con una capa. El fondo transparente pasa a blanco. */
export function blackout(src, rects) {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(src, 0, 0);
  ctx.fillStyle = '#000';
  for (const r of rects) { const p = padded(r, c.width, c.height); if (p) ctx.fillRect(Math.floor(p.x), Math.floor(p.y), Math.ceil(p.w) + 1, Math.ceil(p.h) + 1); }
  return c;
}

export const redactedCanvas = (src, findings) => blackout(src, findings.filter((f) => f.enabled).map((f) => f.rect));

/** Codifica solo píxeles: el navegador no copia EXIF, GPS ni nombres de cámara al volver a dibujar. */
export function encode(canvas, type = 'image/png', quality = 0.92) {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No se pudo codificar la imagen.'))), type, quality));
}

/** Abre un archivo de imagen aplicando su orientación (una foto tomada de lado sale derecha). */
export async function loadImage(fileOrBlob) {
  const bmp = await createImageBitmap(fileOrBlob, { imageOrientation: 'from-image' });
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  return c;
}
