/*
 * ARCHIVO DIGITAL - ROBOT SERVIDOR (independiente)
 * -----------------------------------------------------------------------------
 * Este "robot" guarda los soportes (PDF) y los datos compartidos en TU Google
 * Drive de 15 GB usando UNA sola llave (refresh token) guardada en Render.
 * Asi NINGUN usuario tiene que iniciar sesion con Gmail en su PC: el robot hace
 * todo el trabajo con Drive por ellos, y todos los PC ven lo mismo.
 *
 * Es TOTALMENTE independiente de NEXUSMED: su propia app, su propia carpeta de
 * Drive, su propio despliegue en Render. No comparte datos con ningun otro
 * sistema.
 *
 * NINGUNA clave se escribe aqui: todo se lee de variables de entorno en Render.
 */
'use strict';

const express = require('express');
const cors = require('cors');
const {
  subirArchivoADrive, leerJsonDeDrive, guardarJsonEnDrive,
  renombrarArchivoEnDrive, eliminarArchivoDeDrive, descargarArchivoDeDrive,
  listarArchivosDeDrive, asegurarCarpeta,
} = require('./drive_upload');

const app = express();
app.use(cors());
app.use(express.json({ limit: '80mb' })); // PDFs grandes van en base64

const PORT = process.env.PORT || 10000;
// Token opcional para que terceros no usen tu robot. Si lo defines en Render
// (DRIVE_UPLOAD_TOKEN), la app debe mandarlo en la cabecera Authorization.
const DRIVE_UPLOAD_TOKEN = process.env.DRIVE_UPLOAD_TOKEN || '';

// Traduce los errores crudos de Google a un mensaje claro en espanol.
function mensajeDriveError(e) {
  var raw = ((e && e.message) || '') + '';
  var reason = '';
  try { reason = (e && e.errors && e.errors[0] && e.errors[0].reason) || (e && e.code) || ''; } catch (_) {}
  var s = (raw + ' ' + reason).toLowerCase();
  if (s.indexOf('invalid_grant') >= 0)
    return 'El permiso de Google (refresh token) vencio o fue revocado. Pasa cada 7 dias cuando la app de Google esta en modo "Prueba/Testing". Solucion: en Google Cloud Console publica la pantalla de consentimiento ("En produccion") y genera un nuevo GOOGLE_OAUTH_REFRESH_TOKEN; luego actualizalo en Render.';
  if (s.indexOf('storagequota') >= 0 || s.indexOf('quota') >= 0)
    return 'Google rechazo la subida por cuota de almacenamiento. Usa OAuth2 de tu Gmail (15 GB), no una cuenta de servicio, o libera espacio en Drive.';
  if (s.indexOf('invalid_client') >= 0 || s.indexOf('unauthorized_client') >= 0)
    return 'Las credenciales de Google (Client ID / Client Secret) no son validas. Actualiza GOOGLE_OAUTH_CLIENT_ID y GOOGLE_OAUTH_CLIENT_SECRET y vuelve a generar el refresh token.';
  if (s.indexOf('insufficient') >= 0 || s.indexOf('permission') >= 0 || String(reason).indexOf('403') >= 0)
    return 'Permisos insuficientes sobre la carpeta de Drive. Verifica GOOGLE_DRIVE_FOLDER_ID y que la cuenta tenga acceso de edicion.';
  return raw || 'Error desconocido al guardar en Google Drive.';
}

function chkToken(req) {
  if (!DRIVE_UPLOAD_TOKEN) return true;
  return (req.headers['authorization'] || '') === 'Bearer ' + DRIVE_UPLOAD_TOKEN;
}

// ===========================================================================
// BASE COMPARTIDA · /datos/cargar y /datos/guardar
// Guarda TODO (lotes, facturas, usuarios, etc.) en UN solo JSON en Drive, para
// que todos los PC vean lo mismo. La fusion es aditiva (registro por registro)
// y no pierde datos: si dos PC guardan a la vez, se conservan ambos.
// ===========================================================================
const DB_NOMBRE = 'ARCHIVO_DIGITAL_BASE_COMPARTIDA.json';
let _dbCache = null;
let _dbCadena = Promise.resolve(); // serializa escrituras (evita pisarse)

// Clave estable de un registro, para fusionar sin duplicar.
function recKey(r) {
  if (!r || typeof r !== 'object') return null;
  if (r.id !== undefined && r.id !== null && r.id !== '') return 'id:' + r.id;
  if (r.lote) return 'lote:' + String(r.lote).trim();
  if (r.documento) return 'doc:' + String(r.documento).trim();
  if (r.codigo) return 'cod:' + String(r.codigo).trim();
  try { return 'js:' + JSON.stringify(r); } catch (e) { return null; }
}
function ts(r) { return (r && Number(r._sm)) || 0; }

// Fusion aditiva de dos documentos maestros (el guardado + lo que llega).
function fusionar(master, entrada) {
  const out = { version: (master.version || 0) + 1, actualizado: new Date().toISOString(), stores: {}, tombstones: {} };
  const tomb = Object.assign({}, master.tombstones || {}, entrada.tombstones || {});
  out.tombstones = tomb;
  const keys = {};
  Object.keys(master.stores || {}).forEach(k => keys[k] = 1);
  Object.keys(entrada.stores || {}).forEach(k => keys[k] = 1);
  Object.keys(keys).forEach((store) => {
    const a = (master.stores && master.stores[store]) || [];
    const b = (entrada.stores && entrada.stores[store]) || [];
    const mapa = {};
    const orden = [];
    [a, b].forEach((arr) => {
      (Array.isArray(arr) ? arr : []).forEach((r) => {
        const k = recKey(r);
        if (!k) return;
        const tb = (tomb[store] && tomb[store][k]) || 0;
        if (tb && ts(r) <= tb) return; // borrado mas nuevo que el registro
        if (!(k in mapa)) { mapa[k] = r; orden.push(k); }
        else if (ts(r) >= ts(mapa[k])) { mapa[k] = r; }
      });
    });
    out.stores[store] = orden.map(k => mapa[k]);
  });
  return out;
}

async function cargarMaestro() {
  if (_dbCache) return _dbCache;
  try { _dbCache = await leerJsonDeDrive(DB_NOMBRE); } catch (e) { _dbCache = null; }
  if (!_dbCache || typeof _dbCache !== 'object') {
    _dbCache = { version: 0, actualizado: null, stores: {}, tombstones: {} };
  }
  return _dbCache;
}

app.get('/', (_req, res) => res.json({ ok: true, service: 'archivo-digital-robot', status: 'ready' }));

app.get('/datos/cargar', async (req, res) => {
  if (!chkToken(req)) return res.status(401).json({ ok: false, error: 'No autorizado' });
  try {
    const m = await cargarMaestro();
    return res.json({ ok: true, version: m.version, actualizado: m.actualizado, stores: m.stores || {}, tombstones: m.tombstones || {} });
  } catch (e) {
    console.error('[datos/cargar]', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/datos/guardar', async (req, res) => {
  if (!chkToken(req)) return res.status(401).json({ ok: false, error: 'No autorizado' });
  const entrada = req.body || {};
  const op = _dbCadena.then(async () => {
    const master = await cargarMaestro();
    const fusionado = fusionar(master, entrada);
    await guardarJsonEnDrive(DB_NOMBRE, fusionado);
    _dbCache = fusionado;
    return fusionado;
  });
  _dbCadena = op.catch(() => {});
  try {
    const m = await op;
    return res.json({ ok: true, version: m.version, actualizado: m.actualizado, stores: m.stores || {}, tombstones: m.tombstones || {} });
  } catch (e) {
    console.error('[datos/guardar]', e);
    return res.status(500).json({ ok: false, error: mensajeDriveError(e), detalle: e.message });
  }
});

// ===========================================================================
// GOOGLE DRIVE · /drive/upload -> sube un soporte (PDF/JSON) a la carpeta.
// El frontend manda el archivo en base64; el robot lo sube en silencio.
// ===========================================================================
app.post('/drive/upload', async (req, res) => {
  try {
    if (!chkToken(req)) return res.status(401).json({ ok: false, error: 'No autorizado' });
    const { nombre, mimeType, contenidoBase64, carpetaId, reemplazar } = req.body || {};
    if (!nombre || !contenidoBase64) {
      return res.status(400).json({ ok: false, error: 'Faltan "nombre" o "contenidoBase64".' });
    }
    const buffer = Buffer.from(contenidoBase64, 'base64');
    const archivo = await subirArchivoADrive({ buffer, nombre, mimeType, carpetaId, reemplazar: !!reemplazar });
    return res.json({ ok: true, archivo });
  } catch (e) {
    console.error('[drive/upload]', e);
    return res.status(500).json({ ok: false, error: mensajeDriveError(e), detalle: e.message });
  }
});

// ===========================================================================
// GOOGLE DRIVE · /drive/carpeta -> crea (o devuelve) la subcarpeta de un lote.
// body: { nombre, padreId? }  ->  { ok, id }
// Cada lote queda en su propia subcarpeta dentro de la carpeta raiz de la app.
// ===========================================================================
app.post('/drive/carpeta', async (req, res) => {
  try {
    if (!chkToken(req)) return res.status(401).json({ ok: false, error: 'No autorizado' });
    const { nombre, padreId } = req.body || {};
    if (!nombre) return res.status(400).json({ ok: false, error: 'Falta "nombre".' });
    const id = await asegurarCarpeta(nombre, padreId);
    return res.json({ ok: true, id });
  } catch (e) {
    console.error('[drive/carpeta]', e);
    return res.status(500).json({ ok: false, error: mensajeDriveError(e), detalle: e.message });
  }
});

// ===========================================================================
// GOOGLE DRIVE · /drive/renombrar -> renombra un archivo (y borra copias
// sobrantes). Se usa en el "Cambio masivo (Excel)".
// ===========================================================================
app.post('/drive/renombrar', async (req, res) => {
  try {
    if (!chkToken(req)) return res.status(401).json({ ok: false, error: 'No autorizado' });
    const { viejoNombre, nuevoNombre, carpetaId } = req.body || {};
    if (!viejoNombre || !nuevoNombre) return res.status(400).json({ ok: false, error: 'Faltan "viejoNombre" o "nuevoNombre".' });
    const n = await renombrarArchivoEnDrive(viejoNombre, nuevoNombre, carpetaId);
    return res.json({ ok: true, renombrados: n });
  } catch (e) {
    console.error('[drive/renombrar]', e);
    return res.status(500).json({ ok: false, error: mensajeDriveError(e), detalle: e.message });
  }
});

// ===========================================================================
// GOOGLE DRIVE · /drive/eliminar -> borra de Drive todas las copias por nombre.
// ===========================================================================
app.post('/drive/eliminar', async (req, res) => {
  try {
    if (!chkToken(req)) return res.status(401).json({ ok: false, error: 'No autorizado' });
    const { nombre, carpetaId } = req.body || {};
    if (!nombre) return res.status(400).json({ ok: false, error: 'Falta "nombre".' });
    const n = await eliminarArchivoDeDrive(nombre, carpetaId);
    return res.json({ ok: true, eliminados: n });
  } catch (e) {
    console.error('[drive/eliminar]', e);
    return res.status(500).json({ ok: false, error: mensajeDriveError(e), detalle: e.message });
  }
});

// ===========================================================================
// GOOGLE DRIVE · /drive/descargar -> contenido (base64) de un documento por
// nombre, para VER/DESCARGAR desde cualquier PC aunque no tenga la copia local.
// ===========================================================================
async function manejarDescarga(req, res) {
  try {
    const nombre = (req.query && req.query.nombre) || (req.body && req.body.nombre);
    const carpetaId = (req.query && req.query.carpetaId) || (req.body && req.body.carpetaId);
    if (!nombre) return res.status(400).json({ ok: false, error: 'Falta "nombre".' });
    const archivo = await descargarArchivoDeDrive(nombre, carpetaId);
    if (!archivo) return res.status(404).json({ ok: false, error: 'No existe en Drive: ' + nombre });
    return res.json({ ok: true, archivo });
  } catch (e) {
    console.error('[drive/descargar]', e);
    return res.status(500).json({ ok: false, error: mensajeDriveError(e), detalle: e.message });
  }
}
app.get('/drive/descargar', manejarDescarga);
app.post('/drive/descargar', manejarDescarga);

// ===========================================================================
// GOOGLE DRIVE · /drive/listar -> nombres de archivos dentro de una carpeta.
// Permite que CUALQUIER PC calcule el conteo real X/6 desde lo que existe en
// Drive. Solo LEE; nunca borra. GET o POST { carpetaId }.
// ===========================================================================
async function manejarListar(req, res) {
  try {
    const carpetaId = (req.query && req.query.carpetaId) || (req.body && req.body.carpetaId);
    const archivos = await listarArchivosDeDrive(carpetaId);
    return res.json({ ok: true, archivos });
  } catch (e) {
    console.error('[drive/listar]', e);
    return res.status(500).json({ ok: false, error: mensajeDriveError(e), detalle: e.message });
  }
}
app.get('/drive/listar', manejarListar);
app.post('/drive/listar', manejarListar);

// ===========================================================================
// DIAGNOSTICO · /drive/diag -> dice EXACTAMENTE por que no sube a Drive, sin
// revelar ninguna clave. Hace una subida real de prueba y la borra.
// ===========================================================================
app.get('/drive/diag', async (req, res) => {
  if (!chkToken(req)) return res.status(401).json({ ok: false, error: 'No autorizado: falta o no coincide el token.' });
  const tieneOAuth = !!(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET && process.env.GOOGLE_OAUTH_REFRESH_TOKEN);
  const cfg = {
    servicio: 'archivo-digital-robot',
    tieneClientId: !!process.env.GOOGLE_OAUTH_CLIENT_ID,
    tieneClientSecret: !!process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    tieneRefreshToken: !!process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
    tieneCarpetaRaiz: !!process.env.GOOGLE_DRIVE_FOLDER_ID,
    modo: tieneOAuth ? 'oauth2_usuario (15 GB)' : 'sin credenciales',
  };
  try {
    const prueba = Buffer.from('prueba archivo digital ' + new Date().toISOString(), 'utf8');
    const sub = await subirArchivoADrive({ buffer: prueba, nombre: '_PRUEBA_ROBOT_ARCHIVO_DIGITAL.txt', mimeType: 'text/plain' });
    try { await eliminarArchivoDeDrive('_PRUEBA_ROBOT_ARCHIVO_DIGITAL.txt'); } catch (_) {}
    const lista = await listarArchivosDeDrive();
    return res.json({ ok: true, configuracion: cfg, subidaPrueba: { ok: true, id: sub && sub.id }, archivosEnCarpetaRaiz: lista.length, mensaje: 'Todo listo: el robot SI puede guardar en Drive.' });
  } catch (e) {
    return res.json({ ok: false, configuracion: cfg, mensaje: mensajeDriveError(e), detalle: e.message });
  }
});

app.listen(PORT, () => console.log('ARCHIVO DIGITAL robot escuchando en puerto ' + PORT));
