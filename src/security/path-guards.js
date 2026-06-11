'use strict';

const path = require('path');

function isPathContained(rootDir, candidateAbsolutePath) {
  if (typeof rootDir !== 'string' || typeof candidateAbsolutePath !== 'string') {return false;}
  const root = path.resolve(rootDir);
  const candidate = path.resolve(candidateAbsolutePath);
  if (candidate === root) {return true;}
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  return candidate.startsWith(rootWithSep);
}

function resolveContainedPath(rootDir, relativePath) {
  // decodeURIComponent throws URIError on malformed percent-encoding (a lone '%',
  // '%ZZ', a truncated '%E0', …). A containment guard must FAIL CLOSED on hostile
  // input — return null — not crash the caller with an uncaught URIError.
  let decoded;
  try {
    decoded = decodeURIComponent(String(relativePath ?? ''));
  } catch {
    return null;
  }
  const cleaned = decoded.replace(/^\/+/, '');
  const resolved = path.resolve(rootDir, cleaned);
  return isPathContained(rootDir, resolved) ? resolved : null;
}

module.exports = { isPathContained, resolveContainedPath };
