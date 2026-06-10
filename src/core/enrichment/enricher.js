// =====================================================================
// Enricher: Main-Thread Element Enrichment with Adaptive Batching
//
// Enriches DOM elements with selectors, labels, hierarchy, and metadata.
// Uses requestIdleCallback for UI responsiveness during batch operations.
// Adaptive timeouts and concurrency via HeuristicsEngine prevent blocking.
// Dependencies: DI container for engine resolution, enrichment-utils for sanitization
// =====================================================================

import { ENRICHMENT_CONFIG } from '../shared/config.js';
import { globalContainer } from '../shared/di-container.js';
import { ERROR_CODES, errorTracker } from '../shared/error-tracking.js';
import { safeExecute as safeExecuteWithRetry } from '../shared/safe-execute.js';
import { generateElementId, getTimestamp } from '../shared/utils.js';
import { isElementVisible, isInViewport, verifyNotDetached } from '../helpers/dom-utils.js';
import {
  compressElement,
  getPageContext,
  sanitizeContext,
  sanitizeEventData,
  sanitizeMetadata,
  sanitizeParents
} from '../helpers/enrichment-utils.js';

import { isDebugEnabled } from '../shared/config.js';
import heuristicsEngine from '../shared/heuristics-engine.js';
import ShadowDOMTraverser from '../helpers/shadow-dom-traverser.js';

const MODULE_DEBUG = false;
const DEBUG = isDebugEnabled(MODULE_DEBUG);

// Resolves enrichment engines from DI container with fallback to direct imports
// Fallback prevents catastrophic failure if DI bootstrap fails
// Returns object with all required engine references
function getEngines() {
  try {
    return {
      xpathEngine: globalContainer.resolve('xpathEngine'),
      cssEngine: globalContainer.resolve('cssEngine'),
      labelExtractor: globalContainer.resolve('labelExtractor'),
      parentBuilder: globalContainer.resolve('parentBuilder'),
      metadataCollector: globalContainer.resolve('metadataCollector'),
      nearbyFinder: globalContainer.resolve('nearbyFinder'),
      descriptionBuilder: globalContainer.resolve('descriptionBuilder')
    };
  } catch (error) {
    if (DEBUG) {
      console.warn('[Enricher] DI resolution failed, using direct imports:', error);
    }
    
    const XPathEngine = require('./xpath-engine.js').default;
    const CSSEngine = require('./css-engine.js').default;
    const LabelExtractor = require('./label-extractor.js').default;
    const buildParentChain = require('./parent-builder.js').default;
    const collectMetadata = require('./metadata-collector.js').default;
    const findNearbyElements = require('./nearby-finder.js').default;
    const buildDescription = require('./description-builder.js').default;
    
    return {
      xpathEngine: XPathEngine,
      cssEngine: CSSEngine,
      labelExtractor: LabelExtractor,
      parentBuilder: buildParentChain,
      metadataCollector: collectMetadata,
      nearbyFinder: findNearbyElements,
      descriptionBuilder: buildDescription
    };
  }
}

// Extracts shadow DOM context safely with fallback to empty context
// Prevents enrichment failure if shadow traversal throws error
// Returns default context structure on error for pipeline continuity
function getShadowContextSafely(element) {
  try {
    const shadowPath = ShadowDOMTraverser.getShadowPath(element);
    
    if (!shadowPath || typeof shadowPath !== 'object') {
      return {
        inShadowDOM: false,
        hosts: [],
        depth: 0,
        isLightning: false,
        isAura: false,
        framework: 'none'
      };
    }
    
    return shadowPath;
    
  } catch (error) {
    if (DEBUG) {
      console.warn('[Enricher] Shadow context extraction failed (non-critical):', error);
    }
    
    return {
      inShadowDOM: false,
      hosts: [],
      depth: 0,
      isLightning: false,
      isAura: false,
      framework: 'none'
    };
  }
}

// Checks if element is detached from DOM tree
// Detached elements throw errors during enrichment operations
function isElementDetached(element) {
  return !element || !element.isConnected;
}

// Type guard for shadow-composite selector results
// Shadow selectors have different structure requiring special serialization
function isShadowComposite(result) {
  return result && 
         typeof result === 'object' && 
         result.type && 
         result.type.includes('shadow-composite');
}

// Serializes XPath result for JSON storage
// Handles shadow-composite selectors with nested host chains
// Returns structure with primary/fallback selectors and robustness metrics
function serializeXPathResult(xpathResult, shadowContext) {
  if (!xpathResult || typeof xpathResult !== 'object') {
    return {
      primary: null,
      fallback1: null,
      fallback2: null,
      tier: 99,
      strategy: 'none',
      robustness: 0
    };
  }

  const primary = xpathResult.primary;
  
  if (isShadowComposite(primary)) {
    const isNested = primary.type === 'shadow-composite-nested';
    
    return {
      primary: primary.toString(),
      fallback1: xpathResult.fallback1 
        ? (isShadowComposite(xpathResult.fallback1) 
            ? xpathResult.fallback1.toString() 
            : xpathResult.fallback1)
        : null,
      fallback2: xpathResult.fallback2 
        ? (isShadowComposite(xpathResult.fallback2) 
            ? xpathResult.fallback2.toString() 
            : xpathResult.fallback2)
        : null,
      tier: xpathResult.tier || 99,
      strategy: xpathResult.strategy || 'shadow-composite',
      robustness: xpathResult.robustness || primary.robustness || 0,
      
      executable: {
        type: primary.type,
        ...(isNested ? {
          hostChain: primary.hostChain || [],
          internal: primary.internal || null
        } : {
          host: primary.host || null,
          internal: primary.internal || null
        })
      }
    };
  }

  return {
    primary: primary,
    fallback1: xpathResult.fallback1 || null,
    fallback2: xpathResult.fallback2 || null,
    tier: xpathResult.tier || 99,
    strategy: xpathResult.strategy || 'none',
    robustness: xpathResult.robustness || 0
  };
}

// Serializes CSS result for JSON storage
// Handles shadow-composite selectors with host chain extraction
// Returns structure with selector string and executable metadata
function serializeCSSResult(cssResult, shadowContext) {
  if (!cssResult || typeof cssResult !== 'object') {
    return {
      selector: null,
      tier: 0,
      strategy: 'none'
    };
  }

  const selector = cssResult.selector;
  
  if (isShadowComposite(selector)) {
    const isNested = selector.type === 'shadow-composite-nested';
    
    return {
      selector: selector.toString(),
      tier: cssResult.tier || 0,
      strategy: cssResult.strategy || 'shadow-composite',
      
      executable: {
        type: selector.type,
        ...(isNested ? {
          hostChain: selector.hostChain || [],
          internalSelector: selector.internalSelector || null
        } : {
          hostSelector: selector.hostSelector || null,
          internalSelector: selector.internalSelector || null
        })
      }
    };
  }

  return {
    selector: selector,
    tier: cssResult.tier || 0,
    strategy: cssResult.strategy || 'none'
  };
}

// Serializes shadow host for storage efficiency
// Extracts only essential attributes for selector reconstruction
// Filters class/id to separate fields for query optimization
function serializeShadowHost(host) {
  const serialized = {
    tag: host.hostTag
  };
  
  if (host.hostId) {
    serialized.id = host.hostId;
  }
  
  if (host.hostClasses) {
    const classes = typeof host.hostClasses === 'string' 
      ? host.hostClasses.split(' ').filter(c => c.trim())
      : host.hostClasses;
    
    if (classes.length > 0) {
      serialized.classes = classes;
    }
  }
  
  if (host.hostAttributes && typeof host.hostAttributes === 'object') {
    for (const [key, value] of Object.entries(host.hostAttributes)) {
      if (key === 'class' || key === 'id') continue;
      serialized[key] = value;
    }
  }
  
  return serialized;
}

// Enriches single element with selectors, labels, hierarchy, and metadata
// Returns null for detached elements or invisible elements in interactions mode
// Executes parallel enrichment with adaptive timeouts via HeuristicsEngine
export async function enrichElement(element, captureContext = {}) {
  const startTime = performance.now();
  const captureType = captureContext.captureType || 'unknown';
  
  // Event-based captures (navigation, scroll) only need basic metadata
  const eventBasedCaptures = ['navigation', 'scroll'];
  
  if (eventBasedCaptures.includes(captureType)) {
    const pageContext = getPageContext();
    
    return {
      id: generateElementId(),
      timestamp: getTimestamp(),
      url: pageContext.url,
      pageTitle: pageContext.pageTitle,
      sessionId: captureContext.sessionId || null,
      captureMode: captureContext.captureMode || 'interactions',
      captureType: captureType,
      ...(captureContext.captureMode === 'interactions' && {
        sequenceNumber: captureContext.sequenceNumber || 0
      }),
      eventData: sanitizeEventData(captureContext.eventData)
    };
  }
  
  if (!element || isElementDetached(element)) {
    errorTracker.logError(
      ERROR_CODES.ENRICHMENT_INVALID_ELEMENT,
      'Element null or detached on entry',
      { captureType }
    );
    return null;
  }

  try {
    verifyNotDetached(element, 'ENTRY');
    
    // Extract shadow DOM context for selector generation
    const shadowContext = getShadowContextSafely(element);
    captureContext.shadowContext = shadowContext;
    
    verifyNotDetached(element, 'AFTER_SHADOW_CONTEXT');
    
    const visible = isElementVisible(element);
    
    // Skip invisible elements in interactions mode to reduce noise
    if (captureContext.captureMode === 'interactions' && 
        heuristicsEngine.shouldSkipInvisibleInInteractions() && 
        !visible) {
      return null;
    }

    verifyNotDetached(element, 'AFTER_VISIBILITY_CHECK');

    const pageContext = getPageContext();
    const engines = getEngines();

    // Compute adaptive timeouts based on page complexity and memory pressure
    const adaptiveEnrichmentTimeout = heuristicsEngine.computeEnrichmentTimeout({
      shadowRootCount: shadowContext.depth
    });
    
    const adaptiveParallelTimeout = Math.min(
      heuristicsEngine.getParallelTimeout(),
      adaptiveEnrichmentTimeout / 2
    );

    // Execute XPath, CSS, and label generation in parallel with timeout protection
    // Each operation gets half the total enrichment timeout to prevent cascading delays
    const xpathResult = await safeExecuteWithRetry(
      () => {
        verifyNotDetached(element, 'BEFORE_XPATH');
        return engines.xpathEngine.generate(element);
      },
      { primary: null, fallback1: null, fallback2: null, tier: 99, strategy: 'error', robustness: 0 },
      {
        timeout: adaptiveParallelTimeout,
        errorCode: ERROR_CODES.XPATH_GENERATION_FAILED,
        context: { tag: element.tagName, captureType }
      }
    );
    
    const cssResult = await safeExecuteWithRetry(
      () => {
        verifyNotDetached(element, 'BEFORE_CSS');
        return engines.cssEngine.generate(element, shadowContext);
      },
      { selector: null, tier: 0, strategy: 'none' },
      {
        timeout: adaptiveParallelTimeout,
        errorCode: ERROR_CODES.CSS_GENERATION_FAILED,
        context: { tag: element.tagName, captureType }
      }
    );

    const labelResult = await safeExecuteWithRetry(
      () => engines.labelExtractor.extract(element),
      { displayName: 'Unknown', label: '', confidence: 0 },
      {
        timeout: adaptiveParallelTimeout,
        errorCode: ERROR_CODES.ENRICHMENT_SELECTOR_FAILED,
        context: { tag: element.tagName }
      }
    );

    const parentResult = await safeExecuteWithRetry(
      () => engines.parentBuilder(element),
      { parents: [], fullDomPath: '', depth: 0 },
      {
        timeout: adaptiveParallelTimeout,
        errorCode: ERROR_CODES.ENRICHMENT_SELECTOR_FAILED,
        context: { tag: element.tagName }
      }
    );

    const metadataResult = await safeExecuteWithRetry(
      () => engines.metadataCollector(element),
      { metadata: {} },
      {
        timeout: adaptiveParallelTimeout,
        errorCode: ERROR_CODES.ENRICHMENT_SELECTOR_FAILED,
        context: { tag: element.tagName }
      }
    );

    verifyNotDetached(element, 'AFTER_PARALLEL_ENRICHMENT');

    // Execute context and description generation sequentially
    // Lower priority operations executed after critical selectors/labels
    const nearbyResult = await safeExecuteWithRetry(
      () => engines.nearbyFinder(element),
      { context: [] },
      {
        timeout: adaptiveParallelTimeout,
        errorCode: ERROR_CODES.ENRICHMENT_SELECTOR_FAILED
      }
    );

    const descriptionResult = await safeExecuteWithRetry(
      () => engines.descriptionBuilder(element, labelResult.label, parentResult.parents[0]?.tag || null),
      { description: '' },
      {
        timeout: adaptiveParallelTimeout,
        errorCode: ERROR_CODES.ENRICHMENT_SELECTOR_FAILED
      }
    );

    verifyNotDetached(element, 'BEFORE_RECT_CALCULATION');

    const rect = element.getBoundingClientRect();

    // Serialize selector results for JSON storage
    const serializedCSS = serializeCSSResult(cssResult, shadowContext);
    const serializedXPath = shadowContext.inShadowDOM 
      ? null 
      : serializeXPathResult(xpathResult, shadowContext);

    // Deduplicate displayName and label to reduce storage
    const displayName = labelResult.displayName || '';
    const labelText = labelResult.label || '';
    const nameToStore = (displayName === labelText && displayName) ? displayName : displayName;
    const labelToStore = (displayName === labelText) ? '' : labelText;

    const enriched = {
      id: generateElementId(),
      timestamp: getTimestamp(),
      url: pageContext.url,
      pageTitle: pageContext.pageTitle,
      sessionId: captureContext.sessionId || null,
      captureMode: captureContext.captureMode || 'interactions',
      captureType: captureType,
      ...(captureContext.captureMode === 'interactions' && {
        sequenceNumber: captureContext.sequenceNumber || 0
      }),

      name: nameToStore,
      ...(labelToStore && { label: labelToStore }),
      tagName: element.tagName.toLowerCase(),

      selectors: shadowContext.inShadowDOM 
        ? { css: serializedCSS }
        : {
            xpath: serializedXPath,
            css: serializedCSS
          },

      ...(shadowContext.inShadowDOM && {
        shadowDOM: true,
        shadowDepth: shadowContext.depth,
        shadowHosts: shadowContext.hosts.map(serializeShadowHost)
      }),

      location: {
        x: Math.round(rect.left + window.pageXOffset),
        y: Math.round(rect.top + window.pageYOffset),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        visible: visible,
        inViewport: isInViewport(element)
      },

      description: descriptionResult.description || '',

      hierarchy: {
        parents: sanitizeParents(parentResult.parents),
        depth: parentResult.depth || 0,
        fullDomPath: parentResult.fullDomPath || ''
      },

      context: sanitizeContext(nearbyResult.context),

      metadata: sanitizeMetadata(metadataResult.metadata),

      eventData: sanitizeEventData(captureContext.eventData)
    };

    compressElement(enriched);

    const totalTime = Math.round(performance.now() - startTime);
    if (totalTime > adaptiveEnrichmentTimeout && 
        ENRICHMENT_CONFIG.ENABLE_PERFORMANCE_TRACKING) {
      if (DEBUG) {
        console.warn(`[Enricher] Slow enrichment ${totalTime}ms for ${enriched.name || enriched.tagName}`);
      }
    }

    return enriched;

  } catch (error) {
    if (error.code === ERROR_CODES.ENRICHMENT_DETACHED) {
      errorTracker.logError(
        ERROR_CODES.ENRICHMENT_DETACHED,
        error.message,
        { tag: element?.tagName, captureType, stage: error.context?.stage }
      );
      return null;
    }
    
    errorTracker.logError(
      ERROR_CODES.ENRICHMENT_SELECTOR_FAILED,
      `Critical enrichment error: ${error.message}`,
      { tag: element?.tagName, id: element?.id, class: element?.className, captureType }
    );
    
    if (DEBUG) {
      console.error('[Enricher] Critical enrichment error:', error);
    }
    
    return null;
  }
}

// Enriches array of elements with adaptive batching and concurrency
// Uses requestIdleCallback to yield to main thread between batches
// Skips detached elements and logs batch metrics for monitoring
export async function batchEnrichElements(elements, captureContext = {}) {
  const startTime = performance.now();
  const enriched = [];
  
  if (!Array.isArray(elements) || elements.length === 0) {
    if (DEBUG) {
      console.warn('[Enricher] batchEnrichElements called with invalid input');
    }
    return enriched;
  }
  
  // Filter detached elements before batch processing
  const validElements = elements.filter(el => !isElementDetached(el));
  const skippedInitial = elements.length - validElements.length;
  
  if (skippedInitial > 0 && DEBUG) {
    console.log(`[Enricher] Skipped ${skippedInitial} detached elements before batch`);
  }
  
  // Compute adaptive concurrency based on DOM complexity and memory pressure
  const adaptiveConcurrency = heuristicsEngine.computeBatchConcurrency({
    domNodeCount: validElements.length
  });
  
  const maxTime = heuristicsEngine.getMaxBatchTime();

  // Process elements in batches with concurrency limit
  for (let i = 0; i < validElements.length; i += adaptiveConcurrency) {
    if (performance.now() - startTime > maxTime) {
      errorTracker.logError(
        ERROR_CODES.ENRICHMENT_TIMEOUT,
        `Batch timeout at ${i}/${validElements.length} elements`,
        { processed: i, total: validElements.length }
      );
      
      if (DEBUG) {
        console.warn(`[Enricher] Batch timeout at ${i}/${validElements.length} elements`);
      }
      break;
    }

    const batch = validElements.slice(i, i + adaptiveConcurrency);
    const promises = batch.map((el, idx) => 
      enrichElement(el, {
        ...captureContext,
        sequenceNumber: i + idx
      }).catch(error => {
        if (DEBUG) {
          console.warn('[Enricher] Batch element enrichment failed:', error);
        }
        return null;
      })
    );

    const results = await Promise.all(promises);
    enriched.push(...results.filter(r => r !== null));

    // Yield to main thread via requestIdleCallback for UI responsiveness
    await new Promise(resolve => {
      if (typeof requestIdleCallback !== 'undefined') {
        requestIdleCallback(() => resolve(), { timeout: 100 });
      } else {
        setTimeout(resolve, 0);
      }
    });
  }

  const totalTime = Math.round(performance.now() - startTime);
  const totalFailed = validElements.length - enriched.length;
  
  // Dispatch batch completion event for analytics
  window.dispatchEvent(new CustomEvent('enrichment-batch-complete', {
    detail: {
      requested: elements.length,
      enriched: enriched.length,
      failed: totalFailed,
      skippedInitial: skippedInitial,
      duration: totalTime,
      concurrency: adaptiveConcurrency
    }
  }));
  
  if (DEBUG) {
    console.log(`[Enricher] Batch complete - ${enriched.length} enriched, ${totalFailed} failed, ${totalTime}ms (concurrency: ${adaptiveConcurrency})`);
  }

  return enriched;
}

export default enrichElement;