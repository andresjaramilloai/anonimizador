// Los navegadores detienen requestAnimationFrame cuando la pestaña no se ve; pdf.js lo usa para dibujar y se quedaría esperando
// si la persona cambia de pestaña mientras se procesa un PDF. Esta versión avisa por temporizador si el cuadro no llega a tiempo.
const raw = window.requestAnimationFrame.bind(window);
window.requestAnimationFrame = (cb) => {
  let done = false;
  const run = (t) => { if (done) return; done = true; cb(t); };
  raw(run);
  setTimeout(() => run(performance.now()), 50);
  return 0;
};
