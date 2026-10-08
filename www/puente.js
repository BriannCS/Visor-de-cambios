/* ============================================================
 *  PUENTE — permite usar el mismo Index.html fuera de Apps Script
 *  (PWA en iPhone/Android y APK con Capacitor).
 *
 *  1. Emula google.script.run con fetch → .../exec?api=<función>&fecha=…
 *     El código del Index no cambia: withSuccessHandler / withFailureHandler
 *     funcionan igual.
 *  2. Dentro de la APK (Capacitor) rellena lo que el WebView de Android
 *     no trae: navigator.share con archivos y portapapeles.
 *  3. En navegador registra el service worker (instalable + abre sin red).
 * ============================================================ */
(function () {
  const CFG = window.VISOR_CFG || {};
  // Capacitor solo existe dentro de la APK/app nativa (lo inyecta el contenedor antes que este script).
  const NATIVO = !!window.Capacitor;

  /* ---------- 1. google.script.run ---------- */
  function llamar(nombre, args, ok, fallo) {
    const falla = err => { if (fallo) fallo(err); else console.error(err); };

    if (!CFG.API_URL || CFG.API_URL.indexOf('PEGA_AQUI') === 0) {
      setTimeout(() => falla(new Error('Falta configurar API_URL en config.js')), 0);
      return;
    }

    // GET simple sin cabeceras propias: así no hay preflight CORS (Apps Script no lo soporta).
    const url = CFG.API_URL + '?api=' + encodeURIComponent(nombre) +
                '&fecha=' + encodeURIComponent(args[0] == null ? '' : String(args[0]));
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), CFG.TIMEOUT_MS || 20000);

    fetch(url, { cache: 'no-store', signal: ctrl.signal })
      .then(r => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(datos => { clearTimeout(t); if (ok) ok(datos); })
      .catch(err => { clearTimeout(t); falla(err); });
  }

  function runner(ok, fallo) {
    return new Proxy({}, {
      get(_, prop) {
        if (prop === 'then' || typeof prop !== 'string') return undefined;
        if (prop === 'withSuccessHandler') return fn => runner(fn, fallo);
        if (prop === 'withFailureHandler') return fn => runner(ok, fn);
        if (prop === 'withUserObject')     return () => runner(ok, fallo);
        return (...args) => llamar(prop, args, ok, fallo);
      }
    });
  }

  if (!(window.google && window.google.script)) {
    window.google = window.google || {};
    window.google.script = { run: runner(null, null) };
  }

  /* ---------- 2. APK: compartir y copiar con plugins nativos ---------- */
  if (NATIVO) {
    // Se buscan al usarlos: así funciona tanto con Capacitor.Plugins como con registerPlugin.
    const plugin = nombre => {
      const C = window.Capacitor;
      const p = (C.Plugins && C.Plugins[nombre]) || (C.registerPlugin && C.registerPlugin(nombre));
      if (!p) throw new Error('Plugin nativo no disponible: ' + nombre);
      return p;
    };

    const aBase64 = blob => new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result).split(',')[1]);
      fr.onerror = rej;
      fr.readAsDataURL(blob);
    });

    // El Index usa navigator.canShare/share para la captura: aquí van al menú nativo.
    navigator.canShare = () => true;
    navigator.share = async data => {
      data = data || {};
      let files;
      if (data.files && data.files.length) {
        files = [];
        for (const f of data.files) {
          const r = await plugin('Filesystem').writeFile({
            path: f.name || ('captura-' + Date.now() + '.png'),
            data: await aBase64(f),
            directory: 'CACHE'
          });
          files.push(r.uri);
        }
      }
      try {
        await plugin('Share').share({
          title: data.title, text: data.text, url: data.url,
          files: files, dialogTitle: 'Compartir'
        });
      } catch (e) {
        // Cancelar el menú nativo = AbortError, igual que en el navegador
        // (si no, compartirShot() intentaría "Descargar", que en la APK no hace nada).
        if (/cancel/i.test(String(e && (e.message || e)))) throw new DOMException('Cancelado', 'AbortError');
        throw e;
      }
    };

    // Respaldo del portapapeles (el Index intenta primero execCommand).
    const writeText = text => plugin('Clipboard').write({ string: String(text) });
    try {
      if (navigator.clipboard) navigator.clipboard.writeText = writeText;
      else Object.defineProperty(navigator, 'clipboard', { value: { writeText: writeText } });
    } catch (e) { /* si el WebView no deja, queda execCommand */ }
  }

  /* ---------- 3. PWA: service worker ---------- */
  if (!NATIVO && 'serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW:', e));
    });
  }
})();
