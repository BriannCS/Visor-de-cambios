/**
 * ============================================================
 *  VISOR DE CAMBIOS VENEZUELA — Código.gs  v3.1
 * ============================================================
 *  Cambios frente a v3:
 *  - doGet(e) ahora tiene dos modos:
 *      · Sin parámetros       → sirve la web (Index.html) como siempre.
 *      · ?api=obtenerPaquete  → responde JSON para la app
 *        (PWA en iPhone/Android y APK). Ej:
 *        .../exec?api=obtenerPaquete&fecha=2026-10-08
 *  - Todo lo demás es idéntico a v3.
 *
 *  IMPORTANTE al publicar: Implementar → Gestionar implementaciones →
 *  ✏️ Editar → Versión: "Nueva versión". Así la URL /exec no cambia.
 *  Ejecutar como: "Yo" · Quién tiene acceso: "Cualquier usuario".
 *
 *  Cambios frente a v2:
 *  - obtenerPaquete(fecha): devuelve día actual + día previo en
 *    UNA sola llamada (antes el front hacía hasta 6 llamadas).
 *  - Lee las hojas una sola vez por llamada y solo la "cola"
 *    (últimas filas); lee completo solo si la fecha es antigua.
 *  - Caché del paquete: 60 s para hoy, 1 h para fechas pasadas.
 *  - Las APIs se consultan en paralelo con UrlFetchApp.fetchAll.
 *  - Caché también de respuestas fallidas (evita reintentos lentos).
 *  - Históricos de la API cacheados 6 h (no cambian).
 *  - limpiarCacheVisor(): invalida todo el caché al instante.
 *  - obtenerDatos(fecha) se mantiene por compatibilidad.
 * ============================================================
 */

const SPREADSHEET_ID = '1fByHYrGTMzsoS12pNr4Czs80-4BWnEfv73st4EROJnU';
const TIMEZONE       = 'America/Caracas';

const HOJA_BINANCE = 'Tasa_Binance'; // A: Fecha | B: — | C: Compra | D: Venta
const HOJA_BCV     = 'BCV';          // A: Fecha | B: USD | C: EUR

// --- Endpoints de respaldo (ve.dolarapi.com) ---
const API_BASE         = 'https://ve.dolarapi.com/v1';
const API_USD_OFICIAL  = API_BASE + '/dolares/oficial';
const API_EUR_OFICIAL  = API_BASE + '/euros/oficial';
const API_USD_PARALELO = API_BASE + '/dolares/paralelo';
const API_USD_HIST     = API_BASE + '/dolares/oficial/historico/'; // + YYYY-MM-DD
const API_EUR_HIST     = API_BASE + '/euros/oficial/historico/';   // + YYYY-MM-DD

// --- Tiempos de caché (segundos) ---
const CACHE_SECONDS      = 900;   // API actual (15 min)
const CACHE_API_HIST_SEG = 21600; // API histórica (6 h, no cambia)
const CACHE_API_FALLO_SEG = 600;  // Respuesta fallida de la API (10 min)
const CACHE_PKG_HOY_SEG  = 60;    // Paquete del día de hoy
const CACHE_PKG_PASADO_SEG = 3600; // Paquete de fechas pasadas

// --- Lectura de hojas ---
const FILAS_COLA  = 600; // Últimas filas que se leen primero
const DIAS_PREVIO = 7;   // Días hacia atrás para buscar la variación


/* =========================================================
 *  doGet — Sirve la app web, o JSON si viene ?api=
 * ========================================================= */
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.api) return responderAPI_(p);

  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Visor de Cambios 🇻🇪')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover')
    .addMetaTag('apple-mobile-web-app-capable', 'yes')
    .addMetaTag('mobile-web-app-capable', 'yes')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}


/* =========================================================
 *  responderAPI_ — JSON para la app (PWA / APK / iOS)
 *  Solo expone funciones de lectura (lista blanca).
 *  El CORS lo resuelve Google: la respuesta final llega con
 *  Access-Control-Allow-Origin: * para peticiones GET simples.
 * ========================================================= */
function responderAPI_(p) {
  let out;
  try {
    switch (p.api) {
      case 'obtenerPaquete': out = obtenerPaquete(p.fecha); break;
      case 'obtenerDatos':   out = obtenerDatos(p.fecha);   break;
      default:               out = { ok: false, error: 'Método no permitido: ' + p.api };
    }
  } catch (err) {
    out = { ok: false, error: String(err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}


/* =========================================================
 *  obtenerPaquete — Endpoint principal del front (v3)
 *  Devuelve: { ok, fecha, actual, previo, generado }
 * ========================================================= */
function obtenerPaquete(fechaInput) {
  const hoy   = hoyISO_();
  const fecha = validarISO_(fechaInput) || hoy;

  const cache = CacheService.getScriptCache();
  const key   = 'pkg_' + versionCache_() + '_' + fecha;
  const hit   = cache.get(key);
  if (hit) {
    try { return JSON.parse(hit); } catch (e) {}
  }

  try {
    const isoMin = desplazarISO_(fecha, -DIAS_PREVIO);
    const tablas = leerTablas_(isoMin);
    const actual = armarDia_(fecha, tablas, hoy, true);
    const previo = buscarPrevio_(fecha, tablas, hoy);

    const out = {
      ok: true,
      fecha: fecha,
      actual: actual,
      previo: previo,
      generado: new Date().toISOString()
    };

    if (actual.found) {
      cache.put(key, JSON.stringify(out), fecha === hoy ? CACHE_PKG_HOY_SEG : CACHE_PKG_PASADO_SEG);
    }
    return out;

  } catch (e) {
    const base = baseDia_();
    base.error = String(e);
    return { ok: false, fecha: fecha, actual: base, previo: null, error: String(e) };
  }
}


/* =========================================================
 *  obtenerDatos — Compatibilidad con v1/v2
 * ========================================================= */
function obtenerDatos(fechaInput) {
  return obtenerPaquete(fechaInput).actual;
}


/* =========================================================
 *  Lectura de hojas → mapas indexados por fecha ISO
 * ========================================================= */
function leerTablas_(isoMin) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);

  const binance = leerMapa_(ss.getSheetByName(HOJA_BINANCE), 4, isoMin, r => ({
    compra: parseMonto(r[2]),
    venta:  parseMonto(r[3]),
    fecha:  r[0]
  }));

  const bcv = leerMapa_(ss.getSheetByName(HOJA_BCV), 3, isoMin, r => ({
    usd:   parseMonto(r[1]),
    eur:   parseMonto(r[2]),
    fecha: r[0]
  }));

  return { binance: binance, bcv: bcv };
}

/**
 * Lee primero las últimas FILAS_COLA filas. Si la fecha mínima
 * necesaria es más antigua que esa cola, lee la hoja completa.
 * Si una fecha aparece varias veces, gana la última fila (igual que v2).
 */
function leerMapa_(sh, numCols, isoMin, mapear) {
  const mapa = {};
  if (!sh) return mapa;

  const last = sh.getLastRow();
  if (last < 2) return mapa;

  const desde = Math.max(2, last - FILAS_COLA + 1);
  let filas = sh.getRange(desde, 1, last - desde + 1, numCols).getDisplayValues();

  if (desde > 2) {
    const primera = primerISO_(filas);
    if (!primera || primera > isoMin) {
      filas = sh.getRange(2, 1, last - 1, numCols).getDisplayValues();
    }
  }

  for (let i = 0; i < filas.length; i++) {
    const iso = formatearFechaISO(filas[i][0]);
    if (iso && iso >= isoMin) mapa[iso] = mapear(filas[i]);
  }
  return mapa;
}

function primerISO_(filas) {
  for (let i = 0; i < filas.length; i++) {
    const iso = formatearFechaISO(filas[i][0]);
    if (iso) return iso;
  }
  return '';
}


/* =========================================================
 *  Armado de un día
 * ========================================================= */
function baseDia_() {
  return {
    found: false,
    binance: { tasa_compra: 0, tasa_venta: 0 },
    bcv: 0,
    euro: 0,
    paralelo: 0,
    brecha: { valor: 0, porcentaje: 0 },
    fechas: { binance: '', bcv: '' },
    fuente: { bcv: 'ninguna', euro: 'ninguna', binance: 'ninguna' },
    error: null
  };
}

function armarDia_(iso, tablas, hoy, usarApi) {
  const res = baseDia_();

  const b = tablas.binance[iso];
  if (b) {
    res.binance.tasa_compra = b.compra;
    res.binance.tasa_venta  = b.venta;
    res.fechas.binance      = b.fecha;
    res.fuente.binance      = 'hoja';
  }

  const c = tablas.bcv[iso];
  if (c) {
    res.bcv  = c.usd;
    res.euro = c.eur;
    res.fechas.bcv = c.fecha;
    if (res.bcv  > 0) res.fuente.bcv  = 'hoja';
    if (res.euro > 0) res.fuente.euro = 'hoja';
  }

  if (usarApi) completarConApi_(res, iso, hoy);

  res.found = (res.bcv > 0 || res.binance.tasa_compra > 0);

  if (res.bcv > 0 && res.binance.tasa_compra > 0) {
    const diff = res.binance.tasa_compra - res.bcv;
    res.brecha.valor      = diff;
    res.brecha.porcentaje = (diff / res.bcv) * 100;
  }
  return res;
}

/**
 * Completa BCV / EUR / paralelo desde la API, en paralelo.
 * Hoy → endpoints actuales. Fecha pasada → históricos. Futuro → nada.
 */
function completarConApi_(res, iso, hoy) {
  if (iso > hoy) return;
  const esHoy = (iso === hoy);
  const pedidos = [];

  if (!(res.bcv > 0)) {
    pedidos.push(esHoy
      ? { campo: 'bcv', url: API_USD_OFICIAL, key: 'usd_oficial', ttl: CACHE_SECONDS }
      : { campo: 'bcv', url: API_USD_HIST + iso, key: 'usd_hist_' + iso, ttl: CACHE_API_HIST_SEG });
  }
  if (!(res.euro > 0)) {
    pedidos.push(esHoy
      ? { campo: 'euro', url: API_EUR_OFICIAL, key: 'eur_oficial', ttl: CACHE_SECONDS }
      : { campo: 'euro', url: API_EUR_HIST + iso, key: 'eur_hist_' + iso, ttl: CACHE_API_HIST_SEG });
  }
  if (esHoy) {
    pedidos.push({ campo: 'paralelo', url: API_USD_PARALELO, key: 'usd_paralelo', ttl: CACHE_SECONDS });
  }
  if (!pedidos.length) return;

  const valores = fetchCotizaciones_(pedidos);

  pedidos.forEach((p, i) => {
    const v = valores[i];
    if (!v || !(v.valor > 0)) return;

    if (p.campo === 'bcv') {
      res.bcv = v.valor;
      if (!res.fechas.bcv) res.fechas.bcv = v.fecha;
      res.fuente.bcv = esHoy ? 'api' : 'api_historico';
    } else if (p.campo === 'euro') {
      res.euro = v.valor;
      res.fuente.euro = esHoy ? 'api' : 'api_historico';
    } else if (p.campo === 'paralelo') {
      res.paralelo = v.valor;
    }
  });
}

/**
 * Día previo con datos: primero busca en la hoja (sin red);
 * si no hay nada en DIAS_PREVIO días, intenta la API para 3 días.
 */
function buscarPrevio_(fecha, tablas, hoy) {
  for (let d = 1; d <= DIAS_PREVIO; d++) {
    const iso = desplazarISO_(fecha, -d);
    if (tablas.binance[iso] || tablas.bcv[iso]) {
      const dia = armarDia_(iso, tablas, hoy, true);
      if (tieneDatos_(dia)) return dia;
    }
  }
  for (let d = 1; d <= 3; d++) {
    const dia = armarDia_(desplazarISO_(fecha, -d), tablas, hoy, true);
    if (tieneDatos_(dia)) return dia;
  }
  return null;
}

function tieneDatos_(d) {
  return d && (d.bcv > 0 || d.euro > 0 || d.binance.tasa_compra > 0);
}


/* =========================================================
 *  API ve.dolarapi.com — consultas en paralelo con caché
 *  pedidos: [{ url, key, ttl }]  → [{ valor, fecha } | null]
 * ========================================================= */
function fetchCotizaciones_(pedidos) {
  const cache = CacheService.getScriptCache();
  const hits  = cache.getAll(pedidos.map(p => p.key));
  const out   = new Array(pedidos.length).fill(null);
  const faltan = [];

  pedidos.forEach((p, i) => {
    if (hits[p.key]) {
      try { out[i] = JSON.parse(hits[p.key]); return; } catch (e) {}
    }
    faltan.push(i);
  });
  if (!faltan.length) return out;

  let resps;
  try {
    resps = UrlFetchApp.fetchAll(faltan.map(i => ({
      url: pedidos[i].url,
      method: 'get',
      muteHttpExceptions: true,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    })));
  } catch (e) {
    console.error('fetchAll falló: ' + e);
    return out;
  }

  faltan.forEach((i, k) => {
    const p   = pedidos[i];
    const val = parseCotizacion_(resps[k], p.url);
    if (val) {
      out[i] = val;
      cache.put(p.key, JSON.stringify(val), p.ttl || CACHE_SECONDS);
    } else {
      cache.put(p.key, JSON.stringify({ valor: 0, fecha: '' }), CACHE_API_FALLO_SEG);
    }
  });
  return out;
}

function parseCotizacion_(resp, url) {
  try {
    if (!resp || resp.getResponseCode() !== 200) {
      console.log('API ' + url + ' devolvió ' + (resp ? resp.getResponseCode() : 'sin respuesta'));
      return null;
    }
    const json  = JSON.parse(resp.getContentText());
    const valor = Number(json.promedio || json.venta || json.compra || 0);
    if (!valor || isNaN(valor)) return null;

    const fecha = json.fechaActualizacion
      ? Utilities.formatDate(new Date(json.fechaActualizacion), TIMEZONE, 'dd/MM/yyyy')
      : '';
    return { valor: valor, fecha: fecha };
  } catch (e) {
    console.error('parseCotizacion_ ' + url + ': ' + e);
    return null;
  }
}

// Wrappers (compatibles con v2)
function _fetchCotizacion(url, cacheKey) {
  const v = fetchCotizaciones_([{ url: url, key: cacheKey, ttl: CACHE_SECONDS }])[0];
  return (v && v.valor > 0) ? v : null;
}
function obtenerUSDOficial()  { return _fetchCotizacion(API_USD_OFICIAL,  'usd_oficial');  }
function obtenerEUROficial()  { return _fetchCotizacion(API_EUR_OFICIAL,  'eur_oficial');  }
function obtenerUSDParalelo() { return _fetchCotizacion(API_USD_PARALELO, 'usd_paralelo'); }
function obtenerUSDOficialHistorico(fechaISO) {
  return _fetchCotizacion(API_USD_HIST + fechaISO, 'usd_hist_' + fechaISO);
}
function obtenerEUROficialHistorico(fechaISO) {
  return _fetchCotizacion(API_EUR_HIST + fechaISO, 'eur_hist_' + fechaISO);
}


/* =========================================================
 *  Refresca la hoja BCV con la API (trigger opcional diario)
 * ========================================================= */
function actualizarBCVDesdeAPI() {
  const usd = obtenerUSDOficial();
  const eur = obtenerEUROficial();

  if (!usd || !usd.valor) {
    console.log('API no devolvió USD válido — abortando.');
    return false;
  }

  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sh = ss.getSheetByName(HOJA_BCV);
  if (!sh) return false;

  const hoy     = new Date();
  const hoyStr  = Utilities.formatDate(hoy, TIMEZONE, 'yyyy-MM-dd');
  const lastRow = sh.getLastRow();
  const valEur  = (eur && eur.valor) ? eur.valor : '';

  let filaExistente = -1;
  if (lastRow > 1) {
    const desde  = Math.max(2, lastRow - 60 + 1);
    const fechas = sh.getRange(desde, 1, lastRow - desde + 1, 1).getDisplayValues();
    for (let i = fechas.length - 1; i >= 0; i--) {
      if (formatearFechaISO(fechas[i][0]) === hoyStr) {
        filaExistente = desde + i;
        break;
      }
    }
  }

  if (filaExistente > 0) {
    if (valEur) sh.getRange(filaExistente, 2, 1, 2).setValues([[usd.valor, valEur]]);
    else        sh.getRange(filaExistente, 2).setValue(usd.valor);
  } else {
    sh.appendRow([hoy, usd.valor, valEur]);
    const nueva = sh.getLastRow();
    sh.getRange(nueva, 1).setNumberFormat('dd/MM/yyyy');
    sh.getRange(nueva, 2, 1, 2).setNumberFormat('0.00000000');
  }

  limpiarCacheVisor();
  console.log('BCV refrescado vía API → USD ' + usd.valor + ' | EUR ' + valEur);
  return true;
}


/* =========================================================
 *  Caché: versión global para invalidar todo de una vez
 * ========================================================= */
function versionCache_() {
  return PropertiesService.getScriptProperties().getProperty('CACHE_VER') || '1';
}

/** Ejecútala si corriges datos en la hoja y quieres verlos ya. */
function limpiarCacheVisor() {
  const props = PropertiesService.getScriptProperties();
  const v = Number(props.getProperty('CACHE_VER') || '1') + 1;
  props.setProperty('CACHE_VER', String(v));
  console.log('Caché del visor invalidado → versión ' + v);
}


/* =========================================================
 *  Helpers de fecha y montos
 * ========================================================= */
function hoyISO_() {
  return Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd');
}

function validarISO_(s) {
  return (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)) ? s : '';
}

function desplazarISO_(iso, dias) {
  const p = iso.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2] + dias)).toISOString().slice(0, 10);
}

function formatearFechaISO(str) {
  if (!str) return '';
  const partes = String(str).trim().split(' ')[0].split(/[\/-]/);
  if (partes.length < 3) return '';
  if (partes[0].length === 4) {
    return partes[0] + '-' + partes[1].padStart(2, '0') + '-' + partes[2].padStart(2, '0');
  }
  return partes[2] + '-' + partes[1].padStart(2, '0') + '-' + partes[0].padStart(2, '0');
}

function parseMonto(str) {
  if (!str) return 0;
  if (typeof str === 'number') return str;
  let limpio = String(str).replace(/[^\d.,]/g, '');
  if (limpio.includes(',') && limpio.includes('.')) {
    limpio = limpio.replace(/\./g, '').replace(',', '.');
  } else if (limpio.includes(',')) {
    limpio = limpio.replace(',', '.');
  }
  return parseFloat(limpio) || 0;
}


/* =========================================================
 *  Diagnóstico — ejecútalas desde el editor
 * ========================================================= */
function probarAPI_USD()      { console.log(JSON.stringify(obtenerUSDOficial(),  null, 2)); }
function probarAPI_EUR()      { console.log(JSON.stringify(obtenerEUROficial(),  null, 2)); }
function probarAPI_Paralelo() { console.log(JSON.stringify(obtenerUSDParalelo(), null, 2)); }
function probarDatosHoy()     { console.log(JSON.stringify(obtenerDatos(hoyISO_()), null, 2)); }
function probarPaqueteHoy() {
  const t = Date.now();
  const pkg = obtenerPaquete(hoyISO_());
  console.log('Tiempo: ' + (Date.now() - t) + ' ms');
  console.log(JSON.stringify(pkg, null, 2));
}
/** Simula la llamada que hace la app: revisa que devuelva JSON. */
function probarDoGetAPI() {
  const r = doGet({ parameter: { api: 'obtenerPaquete', fecha: hoyISO_() } });
  console.log(r.getContent().slice(0, 500));
}
