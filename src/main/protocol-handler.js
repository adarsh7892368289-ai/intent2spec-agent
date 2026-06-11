'use strict';

const { protocol, net } = require('electron');
const path = require('path');
const log = require('electron-log');
const { pathToFileURL } = require('url');
const { resolveContainedPath } = require('../security/path-guards.js');

const distRoot = path.join(__dirname, 'renderer');

const RENDERER_CSP = [
  "default-src 'self' app:",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: app:",
  "font-src 'self' data:",
  "connect-src 'self' app:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

function registerProtocolHandler() {
  protocol.handle('app', async (request) => {
    try {
      const url = new URL(request.url);
      const relativePath = url.pathname === '/' ? 'index.html' : url.pathname;
      const absolutePath = resolveContainedPath(distRoot, relativePath);

      if (!absolutePath) {
        log.warn('[Protocol] Path traversal attempt blocked', { relativePath });
        return new Response('Forbidden', { status: 403 });
      }

      const fileResponse = await net.fetch(pathToFileURL(absolutePath).href);
      const headers = new Headers(fileResponse.headers);
      headers.set('Content-Security-Policy', RENDERER_CSP);
      return new Response(fileResponse.body, {
        status: fileResponse.status,
        statusText: fileResponse.statusText,
        headers,
      });
    } catch (err) {
      log.error('[Protocol] Handler threw', { error: err.message, url: request.url });
      return new Response('Internal error', { status: 500 });
    }
  });

  log.info('[Protocol] app:// scheme handler registered', { distRoot });
}

module.exports = { registerProtocolHandler };
