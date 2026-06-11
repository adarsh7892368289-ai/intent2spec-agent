// =====================================================================
// Enrichment Utilities: Performance Layer with Concurrent-Safe Caching
//
// Provides timeout-protected execution, payload sanitization, and page context caching.
// Thread-safe page context creation prevents race conditions in parallel enrichment.
// Cache invalidation hooks called by navigation-capture on route changes.
// Dependencies: config.js for timeout/cache settings, utils.js for validation
// =====================================================================

import { isDebugEnabled } from '../shared/config.js';

const MODULE_DEBUG = false;
const DEBUG = isDebugEnabled(MODULE_DEBUG);

import { ENRICHMENT_CONFIG } from '../shared/config.js';
import { isEmpty } from '../shared/utils.js';

let pageContextCache = null;
let cachePromise = null;

// Retrieves page context with promise-based deduplication to prevent race conditions
// Multiple concurrent callers receive same context instance via shared promise
// TTL-based cache invalidation ensures fresh data without redundant DOM queries
export function getPageContext() {
  if (!ENRICHMENT_CONFIG.ENABLE_PAGE_CONTEXT_CACHE) {
    return createPageContext();
  }

  const currentUrl = window.location.href;
  
  // Fast path: return cached context if valid and URL matches
  if (pageContextCache && 
      pageContextCache.url === currentUrl &&
      Date.now() - pageContextCache.timestamp < ENRICHMENT_CONFIG.CACHE_EXPIRY_MS) {
    return pageContextCache;
  }

  // Deduplication: if context creation in progress, wait for completion
  // Prevents race where Thread A creates context while Thread B also starts creation
  if (cachePromise) {
    return cachePromise;
  }

  // Create promise that concurrent callers will share
  // Ensures single context creation even with 10+ parallel enrichments
  cachePromise = Promise.resolve().then(() => {
    const context = createPageContext();
    pageContextCache = context;
    cachePromise = null;
    return context;
  });

  return cachePromise;
}

// Creates fresh page context snapshot with URL, title, and timestamp
// Called on cache miss or when caching disabled via config flag
function createPageContext() {
  return {
    url: window.location.href,
    pageTitle: document.title || 'Untitled Page',
    timestamp: Date.now()
  };
}

// Invalidates page context cache to prevent stale metadata post-navigation
// Called by navigation-capture on pushState/replaceState/popstate/hashchange
// Clears both cache and in-flight promise to ensure full reset
export function clearPageContextCache() {
  if (DEBUG) console.log('[EnrichmentUtils] Page context cache cleared');
  pageContextCache = null;
  cachePromise = null;
}

// Executes enrichment task with timeout racing to prevent UI blocking
// Returns fallback value on timeout or error to maintain enrichment pipeline
// Uses PARALLEL_TIMEOUT config (50ms default) to prevent cascading delays
export async function safeExecute(fn, fallback) {
  try {
    const result = await Promise.race([
      Promise.resolve(fn()),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Timeout')), ENRICHMENT_CONFIG.PARALLEL_TIMEOUT)
      )
    ]);
    return result;
  } catch (error) {
    if (DEBUG) console.warn(`[EnrichmentUtils] Safe execution failed: ${error.message}`);
    return fallback;
  }
}

// Reduces parent hierarchy to essential fields for storage efficiency
// Limits array to MAX_PARENTS (3) and classes per element to MAX_CLASSES_PER_ELEMENT (2)
// Strips non-serializable properties to prevent JSON.stringify failures
export function sanitizeParents(parents) {
  if (!parents || parents.length === 0) return [];
  
  return parents
    .slice(0, ENRICHMENT_CONFIG.MAX_PARENTS)
    .map(p => {
      const sanitized = {
        level: p.level,
        tag: p.tag
      };
      
      if (p.id) sanitized.id = p.id;
      if (p.classes?.length > 0) {
        sanitized.classes = p.classes.slice(0, ENRICHMENT_CONFIG.MAX_CLASSES_PER_ELEMENT);
      }
      
      return sanitized;
    });
}

// Reduces context array to prevent payload bloat in storage
// Limits to MAX_CONTEXT_ITEMS (4) and truncates labels to 30 chars
// Preserves xpath fields for selector reconstruction if present
export function sanitizeContext(context) {
  if (!context || context.length === 0) return [];
  
  return context
    .slice(0, ENRICHMENT_CONFIG.MAX_CONTEXT_ITEMS || 4)
    .map(item => {
      const sanitized = {
        element: item.element,
        label: item.label ? item.label.substring(0, 30) : null,
        direction: item.direction,
        distance: item.distance
      };
      
      if (item.xpath) {
        sanitized.xpath = item.xpath;
        sanitized.xpathTier = item.xpathTier;
        sanitized.xpathStrategy = item.xpathStrategy;
      }
      
      return sanitized;
    });
}

// Filters metadata to core automation-relevant fields.
// Whitelists essential attributes while limiting classes array. Preserves the
// locator-critical attributes (data-* test ids, ARIA role/label) that the
// Playwright locator projection relies on — dropping these silently regresses
// getByTestId / getByRole / getByLabel quality.
export function sanitizeMetadata(metadata) {
  if (!metadata) return {};

  const essential = {};
  const essentialFields = [
    'tag', 'id', 'type', 'name', 'role',
    'width', 'height', 'placeholder', 'title', 'alt', 'href',
    'value', 'currentValue', 'checked', 'required', 'disabled'
  ];

  for (const field of essentialFields) {
    if (metadata[field] !== null && metadata[field] !== undefined) {
      essential[field] = metadata[field];
    }
  }

  if (metadata.classes?.length > 0) {
    essential.classes = metadata.classes.slice(0, ENRICHMENT_CONFIG.MAX_CLASSES_PER_ELEMENT);
  }

  // data-* attributes — needed for getByTestId (data-testid/test/qa/cy/...).
  if (metadata.dataAttributes && typeof metadata.dataAttributes === 'object') {
    const data = {};
    for (const [k, v] of Object.entries(metadata.dataAttributes)) {
      if (v != null) {
        data[k] = String(v).slice(0, 256);
      }
    }
    if (Object.keys(data).length > 0) {
      essential.dataAttributes = data;
    }
  }

  // aria-* attributes — needed for getByRole(name) / getByLabel and role inference.
  if (metadata.ariaAttributes && typeof metadata.ariaAttributes === 'object') {
    const aria = {};
    for (const [k, v] of Object.entries(metadata.ariaAttributes)) {
      if (v != null) {
        aria[k] = String(v).slice(0, 256);
      }
    }
    if (Object.keys(aria).length > 0) {
      essential.ariaAttributes = aria;
    }
  }

  return essential;
}

// Removes circular references and non-serializable properties from event data
// Blocks DOM nodes, Window objects, and functions to prevent JSON serialization errors
// Silently skips unserializable fields to maintain pipeline flow
export function sanitizeEventData(eventData) {
  if (!eventData) return null;

  const sanitized = {};
  const blocklist = ['target', 'currentTarget', 'srcElement', 'view', 'path', 'composedPath'];

  for (const [key, value] of Object.entries(eventData)) {
    if (blocklist.includes(key)) continue;
    if (value instanceof Node || value instanceof Window) continue;
    if (typeof value === 'function') continue;
    
    // Test serializability before including in result
    try {
      JSON.stringify(value);
      sanitized[key] = value;
    } catch {
      if (DEBUG) console.warn(`[EnrichmentUtils] Cannot serialize event key: "${key}"`);
      continue;
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

// Removes empty/default fields from enriched element to reduce storage footprint
// Conditional compression based on ENABLE_COMPRESSION config flag
// Mutates element object in-place for performance
export function compressElement(element) {
  if (!ENRICHMENT_CONFIG.ENABLE_COMPRESSION) return;

  if (isEmpty(element.context)) delete element.context;
  if (isEmpty(element.hierarchy?.parents)) element.hierarchy.parents = [];
  
  if (element.eventData === null) delete element.eventData;
  
  if (element.shadowDOM === false) {
    delete element.shadowDOM;
    delete element.shadowPath;
  }
  
  if (isEmpty(element.metadata)) element.metadata = {};
}