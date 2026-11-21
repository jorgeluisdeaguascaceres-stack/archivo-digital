/**
 * get_refresh_token.js
 * Script de UN SOLO USO para obtener tu GOOGLE_OAUTH_REFRESH_TOKEN.
 * Se ejecuta en TU computador (no en Render). Autoriza con tu cuenta Gmail
 * y te imprime el refresh token en la terminal.
 *
 * Pasos:
 *  1) En Google Cloud Console crea credenciales OAuth 2.0 tipo "Aplicación web".
 *  2) Añade como "URI de redireccionamiento autorizado":
 *        http://localhost:53682/oauth2callback
 *  3) En la pantalla de consentimiento OAuth, agrega tu propio correo como
 *     "usuario de prueba" (modo Testing) para evitar la verificación.
 *  4) Exporta tus credenciales y ejecuta este script:
 *        GOOGLE_OAUTH_CLIENT_ID=xxx GOOGLE_OAUTH_CLIENT_SECRET=yyy node get_refresh_token.js
 *  5) Copia el refresh token impreso y guárdalo en Render como
 *     GOOGLE_OAUTH_REFRESH_TOKEN.
 */
'use strict';

const http = require('http');
const { google } = require('googleapis');

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const PORT = 53682;
const REDIRECT = 'http://localhost:' + PORT + '/oauth2callback';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Define GOOGLE_OAUTH_CLIENT_ID y GOOGLE_OAUTH_CLIENT_SECRET antes de ejecutar.');
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT);

const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',   // necesario para recibir refresh_token
  prompt: 'consent',        // fuerza a que devuelva refresh_token
  scope: ['https://www.googleapis.com/auth/drive'],
});

const server = http.createServer(async (req, res) => {
  if (req.url.indexOf('/oauth2callback') !== 0) {
    res.writeHead(404); res.end('No encontrado'); return;
  }
  const code = new URL(req.url, REDIRECT).searchParams.get('code');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<h2>Listo. Vuelve a la terminal para copiar tu refresh token.</h2>');
  try {
    const { tokens } = await oauth2.getToken(code);
    console.log('\n================= REFRESH TOKEN =================\n');
    console.log(tokens.refresh_token || '(no se recibió refresh_token: repite con prompt=consent)');
    console.log('\nGuárdalo en Render como GOOGLE_OAUTH_REFRESH_TOKEN\n');
  } catch (e) {
    console.error('Error al canjear el código:', e.message);
  }
  server.close();
});

server.listen(PORT, () => {
  console.log('1) Abre esta URL en tu navegador y autoriza con tu Gmail:\n');
  console.log(authUrl + '\n');
});
