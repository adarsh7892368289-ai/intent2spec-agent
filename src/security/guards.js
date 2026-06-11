'use strict';

const _FORBIDDEN_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isHttpUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

function assertHttpUrl(value, label = 'URL') {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    const err = new Error(`${label} must use http:// or https:// (got ${parsed.protocol})`);
    err.code = 'INVALID_URL';
    throw err;
  }
  return parsed.href;
}

// Only allow launching a system browser (channel/executablePath) when it appears
// in the trusted detection set. Playwright-managed engines (channel == null &&
// executablePath == null) are always allowed.
function isBrowserDescriptorAllowed(descriptor, detectedBrowsers) {
  if (!descriptor || typeof descriptor !== 'object') {
    return false;
  }
  const browserType = descriptor.browserType ?? null;
  const channel = descriptor.channel ?? null;
  const executablePath = descriptor.executablePath ?? null;

  if (channel == null && executablePath == null) {
    return true;
  }

  if (!Array.isArray(detectedBrowsers)) {
    return false;
  }
  return detectedBrowsers.some(
    (d) =>
      d &&
      d.browserType === browserType &&
      (d.channel ?? null) === channel &&
      (d.executablePath ?? null) === executablePath &&
      d.isLaunchable !== false
  );
}

function isSafeBasename(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 255) {
    return false;
  }
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    return false;
  }
  if (name === '.' || name.includes('\0')) {
    return false;
  }
  return true;
}

function stripPollutionKeys(value, depth = 0) {
  if (value == null || typeof value !== 'object') {
    return value;
  }
  // Anti-recursion guard. Past the depth budget we cannot recurse to strip
  // forbidden keys, so FAIL CLOSED: drop the over-deep subtree entirely rather
  // than passing it through un-sanitized (which would let a __proto__/constructor
  // own-key buried >64 levels deep survive). 64 levels far exceeds any legitimate
  // element-descriptor nesting.
  if (depth > 64) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((v) => stripPollutionKeys(v, depth + 1));
  }
  const clean = {};
  for (const key of Object.keys(value)) {
    if (_FORBIDDEN_PROTO_KEYS.has(key)) {
      continue;
    }
    clean[key] = stripPollutionKeys(value[key], depth + 1);
  }
  return clean;
}

module.exports = {
  isHttpUrl,
  assertHttpUrl,
  isBrowserDescriptorAllowed,
  isSafeBasename,
  stripPollutionKeys,
};
