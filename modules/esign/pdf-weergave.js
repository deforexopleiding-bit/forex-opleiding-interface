// modules/esign/pdf-weergave.js
//
// PDF tonen met pdf.js (vaste versie van cdn.jsdelivr — al toegestaan in de CSP).
// Elke pagina wordt een <div class="pw-pagina"> met een <canvas> erin en een
// lege laag (.pw-laag) waarin de editor/tekenpagina zijn velden zet. pdf.js
// past /Rotate en de CropBox toe — precies het "getoonde" vlak waarin
// esign-coords.js de fracties uitdrukt.

const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
const WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';

let _lib = null;
async function pdfjs() {
  if (_lib) return _lib;
  _lib = await import(PDFJS);
  _lib.GlobalWorkerOptions.workerSrc = WORKER;
  return _lib;
}

/**
 * Laad en render alle pagina's in `container`, op de breedte van de container.
 * @param {HTMLElement} container
 * @param {string|ArrayBuffer} bron   URL (signed) of bytes
 * @param {{ opPagina?: (info) => void }} opts  wordt per pagina aangeroepen na het tekenen
 * @returns {Promise<{ paginas: Array<{nummer, el, laag, breedte, hoogte}>, herteken: () => Promise<void> }>}
 */
export async function toonPdf(container, bron, { opPagina } = {}) {
  const lib = await pdfjs();
  const doc = await lib.getDocument(typeof bron === 'string' ? { url: bron } : { data: bron }).promise;
  const paginas = [];
  container.innerHTML = '';
  for (let n = 1; n <= doc.numPages; n++) {
    const el = document.createElement('div');
    el.className = 'pw-pagina';
    el.dataset.pagina = String(n);
    el.innerHTML = `<canvas aria-hidden="true"></canvas><div class="pw-laag"></div><div class="pw-nr">Pagina ${n} van ${doc.numPages}</div>`;
    container.appendChild(el);
    paginas.push({ nummer: n, el, laag: el.querySelector('.pw-laag'), breedte: 0, hoogte: 0 });
  }

  async function teken() {
    const beschikbaar = Math.max(280, Math.min(container.clientWidth - 2, 1000));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const p of paginas) {
      const page = await doc.getPage(p.nummer);
      const basis = page.getViewport({ scale: 1 });
      const schaal = beschikbaar / basis.width;
      const vp = page.getViewport({ scale: schaal * dpr });
      const canvas = p.el.querySelector('canvas');
      canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
      p.breedte = Math.round(basis.width * schaal); p.hoogte = Math.round(basis.height * schaal);
      p.el.style.width = p.breedte + 'px'; p.el.style.height = p.hoogte + 'px';
      canvas.style.width = p.breedte + 'px'; canvas.style.height = p.hoogte + 'px';
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      if (opPagina) opPagina(p);
    }
  }
  await teken();

  let timer = null; let laatsteBreedte = container.clientWidth;
  const ro = new ResizeObserver(() => {
    if (Math.abs(container.clientWidth - laatsteBreedte) < 24) return;
    laatsteBreedte = container.clientWidth;
    clearTimeout(timer); timer = setTimeout(() => { teken().catch((e) => console.error('[pdf] hertekenen:', e)); }, 200);
  });
  ro.observe(container);
  return { paginas, herteken: teken, aantal: doc.numPages };
}
