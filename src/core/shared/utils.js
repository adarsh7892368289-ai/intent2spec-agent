// =================================================================================
// Shared Utilities: Common Helper Functions
// Provides ID generation, timestamp formatting, and null/empty checking.
// Zero dependencies; usable across all extension contexts (background/content/popup).
// Dependencies: None (pure utility functions)
// =================================================================================

// Generates collision-resistant element ID via timestamp + random suffix.
// Format: elem_<timestamp>_<5-char-random> for chronological sorting.
export function generateElementId() {
  const timestamp = Date.now();
  const randomSuffix = Math.random().toString(36).substring(2, 7);
  return `elem_${timestamp}_${randomSuffix}`;
}

// Generates collision-resistant session ID via timestamp + random suffix.
// Format: session_<timestamp>_<9-char-random> for increased uniqueness vs elements.
export function generateSessionId() {
  const timestamp = Date.now();
  const randomSuffix = Math.random().toString(36).substring(2, 9);
  return `session_${timestamp}_${randomSuffix}`;
}

// Generates generic unique ID with customizable prefix.
// Default prefix 'cor' ensures no collision with element/session ID formats.
export function generateUniqueId(prefix = 'cor') {
  const timestamp = Date.now();
  const randomSuffix = Math.random().toString(36).substring(2, 9);
  return `${prefix}_${timestamp}_${randomSuffix}`;
}

// Returns ISO 8601 timestamp for consistent cross-system date serialization.
// Ensures timezone-aware timestamps for multi-region deployments.
export function getTimestamp() {
  return new Date().toISOString();
}

// Type-safe emptiness check supporting primitives, arrays, objects, and strings.
// Returns true for null, undefined, empty arrays/objects, and whitespace-only strings.
export function isEmpty(value) {
  if (value == null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  if (typeof value === 'string') return value.trim().length === 0;
  return false;
}