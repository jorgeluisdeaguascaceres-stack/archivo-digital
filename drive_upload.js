/**
 * drive_upload.js
 * Subida de archivos de soporte (PDF / JSON) a Google Drive con la librería
 * oficial `googleapis`.
 *
 * IMPORTANTE (Gmail de 15 GB):
 *  - Para guardar en TUS 15 GB personales hay que usar OAuth2 de USUARIO.
 *    Una cuenta de servicio NO tiene cuota en Drive de consumidor y produce
 *    el error storageQuotaExceeded, aunque compartas la carpeta como Editor.
 *  - Este archivo elige automáticamente:
 *      A) OAuth2 de usuario  -> si defines GOOGLE_OAUTH_* (RECOMENDADO, 15 GB)
 *      B) Cuenta de servicio -> solo útil en Unidades Compartidas (Workspace)
 *
 * SEGURIDAD: ninguna clave se escribe aquí; todo se lee de variables de entorno.
 *
 * Variables de entorno (Render):
 *   GOOGLE_OAUTH_CLIENT_ID        (OAuth2 de usuario)
 *   GOOGLE_OAUTH_CLIENT_SECRET    (OAuth2 de usuario)
 *   GOOGLE_OAUTH_REFRESH_TOKEN    (OAuth2 de usuario)
 *   GOOGLE_DRIVE_FOLDER_ID        (ID de la carpeta destino)
 *   -- respaldo (solo Workspace / Unidad Compartida) --
 *   GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY
 */
'use strict';

const { google } = require('googleapis');
const { Readable } = require('stream');

/**
 * Devuelve un cliente autenticado de Drive.
 * Prefiere OAuth2 de usuario (para los 15 GB personales) y cae a cuenta de
 * servicio solo si no hay credenciales OAuth2.
 */
function getDriveClient() {
  const oauthClientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const oauthClientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const oauthRefreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;

  // --- Opción A: OAuth2 de usuario (guarda en TUS 15 GB) ---
  if (oauthClientId && oauthClientSecret && oauthRefreshToken) {
    const oauth2 = new google.auth.OAuth2(oauthClientId, oauthClientSecret);
    oauth2.setCredentials({ refresh_token: oauthRefreshToken });
    return google.drive({ version: 'v3', auth: oauth2 });
  }

  // --- Opción B: cuenta de servicio (SOLO Unidades Compartidas/Workspace) ---
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  let privateKey = process.env.GOOGLE_PRIVATE_KEY;
  if (clientEmail && privateKey) {
    privateKey = privateKey.replace(/\\n/g, '\n');
    const auth = new google.auth.JWT({
      email: clientEmail,
      key: privateKey,
      scopes: ['https://www.googleapis.com/auth/drive.file'],
    });
    return google.drive({ version: 'v3', auth });
  }

  throw new Error(
    'Faltan credenciales. Define GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET y ' +
    'GOOGLE_OAUTH_REFRESH_TOKEN (recomendado para Gmail de 15 GB).'
  );
}

/**
 * Sube un archivo (Buffer) a Google Drive de forma silenciosa.
 *
 * @param {Object} opts
 * @param {Buffer} opts.buffer     Contenido binario del archivo.
 * @param {string} opts.nombre     Nombre del archivo en Drive.
 * @param {string} [opts.mimeType] Tipo MIME (por defecto octet-stream).
 * @param {string} [opts.carpetaId] ID de carpeta destino (si no, usa env).
 * @returns {Promise<{id:string,name:string,webViewLink:string}>}
 */
async function subirArchivoADrive({ buffer, nombre, mimeType, carpetaId, reemplazar }) {
  if (!buffer || !nombre) {
    throw new Error('subirArchivoADrive requiere "buffer" y "nombre".');
  }

  const drive = getDriveClient();
  const folderId = carpetaId || process.env.GOOGLE_DRIVE_FOLDER_ID;

  const media = {
    mimeType: mimeType || 'application/octet-stream',
    body: Readable.from(buffer),
  };

  // Si se pide "reemplazar", mantenemos UN solo archivo con ese nombre:
  // se actualiza el existente y se borran duplicados antiguos (p. ej. la
  // base única de pacientes). Para soportes (PDF) NO se usa, así cada
  // documento queda como archivo independiente.
  if (reemplazar) {
    const safe = String(nombre).replace(/'/g, "\\'");
    let q = "name = '" + safe + "' and trashed = false";
    if (folderId) q += " and '" + folderId + "' in parents";
    const lst = await drive.files.list({
      q,
      fields: 'files(id, name, modifiedTime)',
      orderBy: 'modifiedTime desc',
      pageSize: 100,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    const files = (lst.data && lst.data.files) || [];
    if (files.length) {
      const principal = files[0].id;
      for (let i = 1; i < files.length; i++) {
        try { await drive.files.delete({ fileId: files[i].id, supportsAllDrives: true }); } catch (_) {}
      }
      const upd = await drive.files.update({
        fileId: principal, media, fields: 'id, name, webViewLink', supportsAllDrives: true,
      });
      return upd.data;
    }
  }

  const requestBody = { name: nombre };
  if (folderId) requestBody.parents = [folderId];

  const res = await drive.files.create({
    requestBody,
    media,
    fields: 'id, name, webViewLink',
    supportsAllDrives: true,
  });

  return res.data;
}

module.exports = { subirArchivoADrive, getDriveClient };

/**
 * Descarga de Drive el contenido de un archivo por nombre exacto.
 * Devuelve { nombre, mimeType, base64 } o null si no existe.
 * Se usa para VER / DESCARGAR documentos desde cualquier PC (la copia
 * permanente vive en los 15 GB; el PC puede no tener el blob local).
 */
async function descargarArchivoDeDrive(nombre, carpetaId) {
  const fileId = await buscarArchivoPorNombre(nombre, carpetaId);
  if (!fileId) return null;
  const drive = getDriveClient();
  const meta = await drive.files.get({ fileId, fields: 'id, name, mimeType', supportsAllDrives: true });
  const res = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' }
  );
  const buffer = Buffer.from(res.data);
  return {
    nombre: (meta.data && meta.data.name) || nombre,
    mimeType: (meta.data && meta.data.mimeType) || 'application/pdf',
    base64: buffer.toString('base64'),
  };
}

/**
 * Lista TODOS los archivos (nombres) que hay en la carpeta de soportes de
 * Drive. Se usa para que CUALQUIER PC calcule el conteo real X/6 a partir de
 * lo que fisicamente existe en Drive, sin depender de la copia local del
 * navegador. Pagina hasta traerlos todos. Solo LEE; nunca borra.
 */
async function listarArchivosDeDrive(carpetaId) {
  const drive = getDriveClient();
  const folderId = carpetaId || process.env.GOOGLE_DRIVE_FOLDER_ID;
  let q = "trashed = false and mimeType != 'application/vnd.google-apps.folder'";
  if (folderId) q += " and '" + folderId + "' in parents";
  const nombres = [];
  let pageToken = null;
  do {
    const res = await drive.files.list({
      q,
      fields: 'nextPageToken, files(id, name)',
      pageSize: 1000,
      pageToken: pageToken || undefined,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    const files = (res.data && res.data.files) || [];
    files.forEach(function (f) { if (f && f.name) nombres.push(f.name); });
    pageToken = res.data && res.data.nextPageToken;
  } while (pageToken);
  return nombres;
}

/**
 * Busca un archivo por nombre exacto dentro de la carpeta destino.
 * Devuelve el id del primero que encuentre, o null si no existe.
 */
async function buscarArchivoPorNombre(nombre, carpetaId) {
  const drive = getDriveClient();
  const folderId = carpetaId || process.env.GOOGLE_DRIVE_FOLDER_ID;
  const safe = String(nombre).replace(/'/g, "\\'");
  let q = "name = '" + safe + "' and trashed = false";
  if (folderId) q += " and '" + folderId + "' in parents";
  const res = await drive.files.list({
    q,
    fields: 'files(id, name, modifiedTime)',
    orderBy: 'modifiedTime desc',
    pageSize: 10,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const files = (res.data && res.data.files) || [];
  return files.length ? files[0].id : null;
}

/**
 * Lee un archivo JSON de Drive por nombre. Devuelve el objeto parseado,
 * o null si no existe / no es JSON válido.
 */
async function leerJsonDeDrive(nombre, carpetaId) {
  const fileId = await buscarArchivoPorNombre(nombre, carpetaId);
  if (!fileId) return null;
  const drive = getDriveClient();
  const res = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'text' }
  );
  try { return JSON.parse(res.data); } catch (e) { return null; }
}

/**
 * Guarda un objeto como JSON en Drive con nombre fijo: actualiza el
 * archivo si ya existe (misma copia única) o lo crea si no.
 */
async function guardarJsonEnDrive(nombre, obj, carpetaId) {
  const drive = getDriveClient();
  const folderId = carpetaId || process.env.GOOGLE_DRIVE_FOLDER_ID;
  const buffer = Buffer.from(JSON.stringify(obj), 'utf8');
  const media = { mimeType: 'application/json', body: Readable.from(buffer) };
  const fileId = await buscarArchivoPorNombre(nombre, carpetaId);
  if (fileId) {
    const res = await drive.files.update({
      fileId, media, fields: 'id, name', supportsAllDrives: true,
    });
    return res.data;
  }
  const requestBody = { name: nombre };
  if (folderId) requestBody.parents = [folderId];
  const res = await drive.files.create({
    requestBody, media, fields: 'id, name', supportsAllDrives: true,
  });
  return res.data;
}

/**
 * Renombra en Drive un archivo (todas las copias con el nombre viejo quedan
 * reducidas a UNA sola, ya con el nombre nuevo). Útil cuando una carpeta pasa
 * de llamarse por Nº de admisión a Nº de factura: el documento que se radica
 * debe quedar renombrado también en los 15 GB.
 * Devuelve cuántos archivos se tocaron.
 */
async function renombrarArchivoEnDrive(viejoNombre, nuevoNombre, carpetaId) {
  if (!viejoNombre || !nuevoNombre) return 0;
  if (String(viejoNombre).trim() === String(nuevoNombre).trim()) return 0;
  const drive = getDriveClient();
  const folderId = carpetaId || process.env.GOOGLE_DRIVE_FOLDER_ID;
  function listar(nombre) {
    const safe = String(nombre).replace(/'/g, "\\'");
    let q = "name = '" + safe + "' and trashed = false";
    if (folderId) q += " and '" + folderId + "' in parents";
    return drive.files.list({
      q, fields: 'files(id, name, modifiedTime)', orderBy: 'modifiedTime desc',
      pageSize: 100, supportsAllDrives: true, includeItemsFromAllDrives: true,
    }).then(function (r) { return (r.data && r.data.files) || []; });
  }
  const viejos = await listar(viejoNombre);
  const nuevos = await listar(nuevoNombre);
  // Caso seguro: si ya existe el archivo con el NUEVO nombre, ese es el bueno
  // (el más reciente). Conservamos SOLO uno con el nuevo nombre y borramos
  // las copias viejas y las copias nuevas sobrantes. NO renombramos (evita
  // pisar contenido reciente con uno antiguo).
  if (nuevos.length) {
    for (let i = 1; i < nuevos.length; i++) {
      try { await drive.files.delete({ fileId: nuevos[i].id, supportsAllDrives: true }); } catch (_) {}
    }
    for (let j = 0; j < viejos.length; j++) {
      try { await drive.files.delete({ fileId: viejos[j].id, supportsAllDrives: true }); } catch (_) {}
    }
    return 1;
  }
  if (!viejos.length) return 0;
  // Solo existe con el nombre viejo: renombramos el más reciente y borramos el resto.
  const principal = viejos[0].id;
  for (let i = 1; i < viejos.length; i++) {
    try { await drive.files.delete({ fileId: viejos[i].id, supportsAllDrives: true }); } catch (_) {}
  }
  await drive.files.update({
    fileId: principal, requestBody: { name: nuevoNombre },
    fields: 'id, name', supportsAllDrives: true,
  });
  return 1;
}

/**
 * Elimina de Drive TODAS las copias de un archivo por nombre exacto (cuando un
 * documento se anula en el sistema, debe desaparecer también de los 15 GB).
 * Devuelve cuántos archivos se borraron.
 */
async function eliminarArchivoDeDrive(nombre, carpetaId) {
  if (!nombre) return 0;
  const drive = getDriveClient();
  const folderId = carpetaId || process.env.GOOGLE_DRIVE_FOLDER_ID;
  const safe = String(nombre).replace(/'/g, "\\'");
  let q = "name = '" + safe + "' and trashed = false";
  if (folderId) q += " and '" + folderId + "' in parents";
  const res = await drive.files.list({
    q, fields: 'files(id, name)', pageSize: 100,
    supportsAllDrives: true, includeItemsFromAllDrives: true,
  });
  const files = (res.data && res.data.files) || [];
  let n = 0;
  for (let i = 0; i < files.length; i++) {
    try { await drive.files.delete({ fileId: files[i].id, supportsAllDrives: true }); n++; } catch (_) {}
  }
  return n;
}

/**
 * Busca una carpeta por nombre exacto dentro de un padre (o en la raiz del
 * Drive si no se pasa padre). Si no existe, LA CREA. Devuelve el id de la
 * carpeta. Asi cada lote de ARCHIVO DIGITAL tiene su propia subcarpeta dentro
 * de la carpeta raiz de la app, sin que nadie inicie sesion con Gmail.
 */
async function asegurarCarpeta(nombre, parentId) {
  if (!nombre) throw new Error('asegurarCarpeta requiere "nombre".');
  const drive = getDriveClient();
  const padre = parentId || process.env.GOOGLE_DRIVE_FOLDER_ID || null;
  const safe = String(nombre).replace(/'/g, "\\'");
  let q = "mimeType = 'application/vnd.google-apps.folder' and trashed = false and name = '" + safe + "'";
  if (padre) q += " and '" + padre + "' in parents";
  const lst = await drive.files.list({
    q,
    fields: 'files(id, name)',
    pageSize: 10,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const files = (lst.data && lst.data.files) || [];
  if (files.length) return files[0].id;
  const requestBody = { name: nombre, mimeType: 'application/vnd.google-apps.folder' };
  if (padre) requestBody.parents = [padre];
  const res = await drive.files.create({ requestBody, fields: 'id, name', supportsAllDrives: true });
  return res.data.id;
}

module.exports = { subirArchivoADrive, getDriveClient, buscarArchivoPorNombre, leerJsonDeDrive, guardarJsonEnDrive, renombrarArchivoEnDrive, eliminarArchivoDeDrive, descargarArchivoDeDrive, listarArchivosDeDrive, asegurarCarpeta };
