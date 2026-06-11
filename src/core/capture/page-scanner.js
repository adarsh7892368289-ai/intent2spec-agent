// =============================================================================
// Page Scanner: DOM Element Discovery and Enrichment Engine
// Scans web pages for interactive elements, handles Shadow DOM traversal,
// and enriches elements with metadata for tracking and analysis.
// Supports both filtered and full-page scanning with adaptive batch processing.
// Dependencies: AttributeProfiler, config.js, error-tracking.js, heuristics-engine.js, utils.js, enricher.js, XPathEngine, ShadowDOMTraverser, visibility-checker.js
// =============================================================================

import { isDebugEnabled } from '../shared/config.js';
import { ERROR_CODES, errorTracker } from '../shared/error-tracking.js';
import heuristicsEngine from '../shared/heuristics-engine.js';
import { generateElementId, getTimestamp } from '../shared/utils.js';
import { batchEnrichElements, enrichElement } from '../enrichment/enricher.js';
import ShadowDOMTraverser from '../helpers/shadow-dom-traverser.js';
import { isElementInteractable, isElementTrulyVisible } from '../helpers/visibility-checker.js';

const MODULE_DEBUG = true;
const DEBUG = isDebugEnabled(MODULE_DEBUG);

const DOM_READY_TIMEOUT = 10000;
const DOM_READY_CHECK_INTERVAL = 100;
const MAX_SCROLL_STEPS = 50;
const JANK_PREVENTION_CHUNK_SIZE = 3;

class PageScanner {
  // Initializes scanner state tracking and error event listener setup
  // Sets up instance variables for session data and scan control
  constructor() {
    this.isActive = false;
    this.capturedInSession = new Set();
    this.isScanning = false;
    this.currentFilters = [];
    this.originalScrollPosition = 0;
    this.originalUrl = null;
    this.isSilentScan = false;
    this.setupErrorListener();
  }

  // Attaches listener for enrichment batch completion events
  // Logs debug info when batch enrichment finishes for troubleshooting
  setupErrorListener() {
    this.boundBatchCompleteHandler = (event) => {
      if (DEBUG) {
        console.log('[PageScanner] Batch enrichment complete:', event.detail);
      }
    };
    window.addEventListener('enrichment-batch-complete', this.boundBatchCompleteHandler);
  }

  // Marks scanner as active for subsequent page scans
  // Idempotent - safe to call multiple times
  init() {
    if (this.isActive) return;
    this.isActive = true;
    
    if (DEBUG) console.log('[PageScanner] Initialized');
  }

  // Stores element selectors/class names to filter collection during scanning
  // Enables targeted capture of specific UI elements instead of full-page scan
  setFilters(filters) {
    this.currentFilters = filters || [];
  }

  // Early optimization to skip scanning empty/invisible frames
  // Reduces wasted CPU on iframes with minimal content or hidden visibility
  isFrameWorthScanning() {
    const scrollHeight = document.documentElement.scrollHeight || document.body?.scrollHeight || 0;
    const childrenCount = document.body?.children?.length || 0;
    const hasInteractiveElements = document.querySelector('input, button, a, select, textarea') !== null;
    
    if (scrollHeight < 50 && childrenCount < 5 && !hasInteractiveElements) {
      if (DEBUG) {
        console.log('[PageScanner] Skipping empty/invisible frame', {
          scrollHeight,
          childrenCount,
          hasInteractiveElements
        });
      }
      return false;
    }
    
    return true;
  }

  // Main entry point for page scanning with optional filter or silent mode
  // Handles DOM readiness check, delegates to filtered or scrolling scan, triggers profiler
  async scanPage(filters = null, silent = false) {
    if (filters !== null) {
      this.setFilters(filters);
    }
    
    this.isSilentScan = silent;
    
    // Quick exit for empty/invisible frames to prevent DOM traversal overhead
    if (!this.isFrameWorthScanning()) {
      if (DEBUG) {
        console.log('[PageScanner] Scan aborted - frame not worth scanning (EMPTY_FRAME)');
      }
      
      return {
        type: 'page_scan',
        timestamp: getTimestamp(),
        scanId: generateElementId(),
        url: window.location.href,
        title: document.title,
        skipped: true,
        reason: 'EMPTY_FRAME',
        elements: [],
        duration: 0,
        statistics: {
          totalElements: 0,
          enrichedElements: 0,
          failedElements: 0,
          scanDuration: 0,
          byType: {}
        }
      };
    }
    
    if (DEBUG) {
      console.log('[PageScanner] Scan requested', {
        hasFilters: this.currentFilters.length > 0,
        willScroll: this.currentFilters.length === 0
      });
    }
    
    const isDOMReady = await this.waitForDOMReady();
    if (!isDOMReady) {
      errorTracker.logError(
        ERROR_CODES.ENRICHMENT_SELECTOR_FAILED,
        'DOM not ready after timeout',
        { timeout: DOM_READY_TIMEOUT }
      );
      console.warn('[PageScanner] DOM not ready after timeout, aborting scan');
      return null;
    }

    let scanResult;
    if(this.currentFilters.length > 0) {
      scanResult = await this.scanPageWithoutScrolling();
    } else {
      scanResult = await this.scanPageWithScrollingStreaming();
    }
    return scanResult;
  }

  // Polls document readiness state with exponential backoff
  // Returns false if DOM not ready after timeout to abort scanning
  async waitForDOMReady() {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      if (document.documentElement.scrollHeight > 0 && window.innerHeight > 0) {
        return true;
      }
    }

    if (DEBUG) {
      console.log('[PageScanner] Waiting for DOM ready', {
        readyState: document.readyState,
        scrollHeight: document.documentElement.scrollHeight,
        viewHeight: window.innerHeight
      });
    }

    const startTime = Date.now();
    let checkingInProgress = false;
    
    return new Promise((resolve) => {
      const checkReady = () => {
        if (checkingInProgress) return;
        checkingInProgress = true;

        const isDocReady = document.readyState === 'complete' || document.readyState === 'interactive';
        const hasValidDimensions = document.documentElement.scrollHeight > 0 && window.innerHeight > 0;
        const hasMinimumContent = document.body && document.body.childNodes.length > 0;
        
        if (isDocReady && hasValidDimensions && hasMinimumContent) {
          if (DEBUG) {
            const elapsed = Date.now() - startTime;
            console.log(`[PageScanner] DOM ready (waited ${elapsed}ms)`);
          }
          resolve(true);
          return;
        }

        if (Date.now() - startTime > DOM_READY_TIMEOUT) {
          if (DEBUG) {
            console.warn('[PageScanner] DOM ready timeout', {
              readyState: document.readyState,
              scrollHeight: document.documentElement.scrollHeight,
              viewHeight: window.innerHeight,
              hasBody: !!document.body
            });
          }
          resolve(false);
          return;
        }

        checkingInProgress = false;
        setTimeout(checkReady, DOM_READY_CHECK_INTERVAL);
      };

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
          setTimeout(checkReady, 50);
        }, { once: true });
      } else {
        checkReady();
      }
    });
  }

  // Scans current viewport without scrolling using stored filters
  // Best for modal dialogs or targeted element capture within fixed container
  async scanPageWithoutScrolling() {
    if (this.isScanning) {
      if (DEBUG) console.warn('[PageScanner] Scan already in progress');
      return null;
    }
    
    this.isScanning = true;
    
    if (DEBUG) console.log('[PageScanner] Starting filtered scan (no scroll)');

    try {
      const startTime = performance.now();
      const pageInfo = this.getPageInfo();
      const elementsToScan = this.collectShadowAwareElements();
      
      if (DEBUG) {
        console.log(`[PageScanner] Collected ${elementsToScan.length} elements`, {
          shadowElements: elementsToScan.filter(e => e.__shadowContext?.inShadowDOM).length,
          frameworks: pageInfo.shadowDOMInfo.frameworks
        });
      }

      const captureContext = {
        sessionId: window.__trackerSessionId || 'unknown',
        captureMode: window.__trackerMode || 'full_page',
        captureType: 'scan',
        scanId: generateElementId(),
      };

      let enrichedElements = await batchEnrichElements(elementsToScan, captureContext);

      if (captureContext.captureMode === 'hybrid') {
        enrichedElements = this.deduplicateHybridCaptures(enrichedElements);
      }

      const scanDuration = Math.round(performance.now() - startTime);

      const scanData = {
        type: 'page_scan',
        timestamp: getTimestamp(),
        scanId: captureContext.scanId,
        url: window.location.href,
        title: document.title,
        pageInfo: pageInfo,
        filters: this.currentFilters,
        elements: enrichedElements,
        duration: scanDuration,
        statistics: {
          totalElements: elementsToScan.length,
          enrichedElements: enrichedElements.length,
          failedElements: elementsToScan.length - enrichedElements.length,
          scanDuration: scanDuration,
          byType: this.categorizeElements(enrichedElements),
          shadowDOMDetected: pageInfo.shadowDOMInfo.totalShadowRoots > 0,
          shadowElements: pageInfo.shadowDOMInfo.elementsInShadowDOM,
        },
      };
      
      if (DEBUG) {
        console.log(`[PageScanner] Complete (${scanDuration}ms, ${enrichedElements.length} elements)`);
      }
      
      window.dispatchEvent(new CustomEvent('page-scan-completed', { detail: scanData }));
      return scanData;
    } catch (error) {
      errorTracker.logError(
        ERROR_CODES.ENRICHMENT_SELECTOR_FAILED,
        `Scan error: ${error.message}`,
        { error: error.message, stack: error.stack }
      );
      console.error('[PageScanner] Scan error:', error);
      return null;
    } finally {
      this.isScanning = false;
      this.isSilentScan = false;
    }
  }

  // Full-page scan with incremental scrolling and streaming enrichment
  // Collects unique elements across viewport while scrolling, prevents scroll capture conflicts
  async scanPageWithScrollingStreaming() {
    if (this.isScanning) {
      if (DEBUG) console.warn('[PageScanner] Scan already in progress');
      return null;
    }
    
    this.isScanning = true;
    this.originalScrollPosition = window.scrollY;
    this.originalUrl = window.location.href;
    
    const docHeight = document.documentElement.scrollHeight;
    const viewHeight = window.innerHeight;
    
    if (DEBUG) {
      console.log('[PageScanner] Starting streaming scan with scrolling', {
        docHeight: docHeight,
        viewHeight: viewHeight
      });
    }
    
    if (docHeight === 0 || viewHeight === 0) {
      errorTracker.logError(
        ERROR_CODES.ENRICHMENT_SELECTOR_FAILED,
        'Invalid dimensions, aborting scan',
        { docHeight, viewHeight, readyState: document.readyState }
      );
      console.error('[PageScanner] Invalid dimensions, aborting scan', {
        docHeight,
        viewHeight,
        readyState: document.readyState
      });
      this.isScanning = false;
      return null;
    }
    
    window.__isScanningPage = true;
    const scrollCaptureWasActive = window.__scrollCaptureActive;
    window.__scrollCaptureActive = false;

    try {
      const startTime = performance.now();
      const pageInfo = this.getPageInfo();
      const elementsToScan = await this.collectElementsWithScrolling();

      if (DEBUG) {
        console.log(`[PageScanner] Collected ${elementsToScan.length} elements (scrolled)`, {
          shadowElements: elementsToScan.filter(e => e.__shadowContext?.inShadowDOM).length
        });
      }

      const captureContext = {
        sessionId: window.__trackerSessionId || 'unknown',
        captureMode: window.__trackerMode || 'full_page',
        captureType: 'scan',
        scanId: generateElementId(),
      };

      const enrichedElements = await this.streamingEnrichment(elementsToScan, captureContext);

      if (captureContext.captureMode === 'hybrid') {
        const deduplicated = this.deduplicateHybridCaptures(enrichedElements);
        enrichedElements.length = 0;
        enrichedElements.push(...deduplicated);
      }

      const scanDuration = Math.round(performance.now() - startTime);

      const scanData = {
        type: 'page_scan',
        timestamp: getTimestamp(),
        scanId: captureContext.scanId,
        url: window.location.href,
        title: document.title,
        pageInfo: pageInfo,
        filters: null,
        elements: enrichedElements,
        duration: scanDuration,
        statistics: {
          totalElements: elementsToScan.length,
          enrichedElements: enrichedElements.length,
          failedElements: elementsToScan.length - enrichedElements.length,
          scanDuration: scanDuration,
          byType: this.categorizeElements(enrichedElements),
          shadowDOMDetected: pageInfo.shadowDOMInfo.totalShadowRoots > 0,
          shadowElements: pageInfo.shadowDOMInfo.elementsInShadowDOM,
        },
      };
      
      if (DEBUG) {
        console.log(`[PageScanner] Complete (${scanDuration}ms, ${enrichedElements.length} elements)`);
      }
      
      window.dispatchEvent(new CustomEvent('page-scan-completed', { detail: scanData }));
      return scanData;
    } catch (error) {
      errorTracker.logError(
        ERROR_CODES.ENRICHMENT_SELECTOR_FAILED,
        `Scan error: ${error.message}`,
        { error: error.message, stack: error.stack }
      );
      console.error('[PageScanner] Scan error:', error);
      return null;
    } finally {
      if (window.location.href === this.originalUrl) {
        window.scrollTo(0, this.originalScrollPosition);
      } else {
        if (DEBUG) {
          console.log('[PageScanner] Navigation detected, skipping scroll restore');
        }
      }
      
      window.__scrollCaptureActive = scrollCaptureWasActive;
      window.__isScanningPage = false;
      this.isScanning = false;
    }
  }

  // Enriches elements in adaptive chunks to balance throughput vs. UI jank
  // Uses requestIdleCallback for non-blocking execution, emits streaming progress events
  async streamingEnrichment(elements, captureContext) {
    const enriched = [];
    
    const adaptiveChunkSize = heuristicsEngine.computeBatchConcurrency({
      domNodeCount: elements.length
    });
    
    if (DEBUG) {
      console.log(`[PageScanner] Streaming with adaptive chunk size: ${adaptiveChunkSize}`);
    }
    
    for (let i = 0; i < elements.length; i += adaptiveChunkSize) {
      const chunk = elements.slice(i, i + adaptiveChunkSize);
      
      const chunkResults = await new Promise((resolve) => {
        const processChunk = async (chunkToProcess) => {
          try {
            const promises = chunkToProcess.map((el, idx) => 
              this.enrichSingleElement(el, {
                ...captureContext,
                sequenceNumber: i + idx
              }).catch(error => {
                if (DEBUG) {
                  console.warn('[PageScanner] Element enrichment failed:', error);
                }
                return null;
              })
            );
            
            const results = await Promise.all(promises);
            resolve(results.filter(r => r !== null));
          } catch (error) {
            resolve([]);
          }
        };
        
        if (typeof requestIdleCallback !== 'undefined') {
          requestIdleCallback((deadline) => {
            // Jank prevention - force smaller chunk if deadline exceeded
            if (deadline.didTimeout) {
              const reducedChunk = chunk.slice(0, JANK_PREVENTION_CHUNK_SIZE);
              processChunk(reducedChunk).then(() => {
                const remaining = chunk.slice(JANK_PREVENTION_CHUNK_SIZE);
                if (remaining.length > 0) {
                  requestIdleCallback(() => processChunk(remaining), { timeout: 1000 });
                }
              });
            } else {
              processChunk(chunk);
            }
          }, { timeout: 1000 });
        } else {
          setTimeout(() => processChunk(chunk), 0);
        }
      });
      
      enriched.push(...chunkResults);
      
      if (chunkResults.length > 0) {
        this.dispatchPartialScanResult({
          scanId: captureContext.scanId,
          chunk: chunkResults,
          progress: {
            processed: i + adaptiveChunkSize,
            total: elements.length,
            percentage: Math.round(((i + adaptiveChunkSize) / elements.length) * 100)
          }
        });
      }
      
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    
    return enriched;
  }

  // Wrapper for enricher module enrichElement function
  // Handles enrichment failures gracefully and returns enriched metadata
  async enrichSingleElement(element, captureContext) {
    return enrichElement(element, captureContext);
  }

  // Emits partial scan result event for streaming UI updates
  // Listeners can display real-time capture progress to user
  dispatchPartialScanResult(data) {
    window.dispatchEvent(new CustomEvent('page-scan-partial', { detail: data }));
  }

  // Scrolls page incrementally and collects unique interactive elements
  // Deduplicates elements by generated key to avoid capturing duplicates across viewports
  async collectElementsWithScrolling() {
    const allElements = new Map();
    const viewportHeight = window.innerHeight;
    let documentHeight = document.documentElement.scrollHeight;
    let currentScroll = 0;
    let scrollSteps = 0;

    if (documentHeight === 0 || viewportHeight === 0) {
      console.warn('[PageScanner] Invalid dimensions for scrolling', {
        documentHeight,
        viewportHeight
      });
      return [];
    }

    while (currentScroll < documentHeight) {
      window.scrollTo(0, currentScroll);
      await this.sleepAsync(300);
      scrollSteps++;

      const elementsInView = this.collectShadowAwareElements();

      for (const element of elementsInView) {
        const key = this.generateElementKey(element);
        if (!allElements.has(key)) {
          allElements.set(key, element);
        }
      }

      currentScroll += viewportHeight;

      // Re-read the height: lazy-loading / infinite-scroll pages grow as we
      // scroll, so a height captured once would stop us early and miss content.
      // MAX_SCROLL_STEPS below is the backstop against truly unbounded pages.
      documentHeight = document.documentElement.scrollHeight;

      // Note: the final loop iteration already scrolls to (and collects at) the
      // bottom-most reachable position, since the browser clamps scrollTo to
      // max-scroll. A separate scrollTo(documentHeight) + re-collect here would
      // re-query the identical clamped viewport — removed to avoid a redundant
      // full-document Shadow DOM traversal + 300ms wait per scan.

      if (scrollSteps > MAX_SCROLL_STEPS) {
        errorTracker.logError(
          ERROR_CODES.ENRICHMENT_TIMEOUT,
          `Max scroll steps reached (${MAX_SCROLL_STEPS})`,
          { scrollSteps, documentHeight }
        );
        
        if (DEBUG) {
          console.warn(`[PageScanner] Max scroll steps reached (${MAX_SCROLL_STEPS}), stopping`);
        }
        break;
      }
    }

    if (DEBUG) {
      console.log(`[PageScanner] Scrolled ${scrollSteps} steps, found ${allElements.size} unique elements`);
    }

    return Array.from(allElements.values());
  }

  // Collects candidate elements using filters or interactive selectors
  // Applies visibility and interactivity checks, enriches with Shadow DOM context
  collectShadowAwareElements() {
    const elements = [];
    const seenElements = new WeakSet();
    let shadowElementCount = 0;
    
    const candidates = this.currentFilters.length > 0 
      ? this.collectFilteredElementsWithShadowDOM()
      : this.collectInteractiveElements();

    for (const element of candidates) {
      if (seenElements.has(element)) continue;
      if (this.shouldSkipElement(element)) continue;
      if (!isElementTrulyVisible(element, 'complete')) continue;
      if (!isElementInteractable(element)) continue;
      
      const shadowPath = ShadowDOMTraverser.getShadowPath(element);
      element.__shadowContext = shadowPath;
      
      if (shadowPath.inShadowDOM) {
        shadowElementCount++;
      }
      
      elements.push(element);
      seenElements.add(element);
    }

    if (DEBUG) {
      console.log(`[PageScanner] Collected ${elements.length} elements`, {
        shadowElements: shadowElementCount,
        regularElements: elements.length - shadowElementCount,
        candidatesBeforeFiltering: candidates.length
      });
    }

    return elements;
  }

  // Finds all interactive elements using standard and Lightning component selectors
  // Uses Shadow DOM traverser to penetrate custom element shadow boundaries
  collectInteractiveElements() {
    const selector = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [onclick], [tabindex]';
    const lightningSelector = 'lightning-button, lightning-input, lightning-textarea, lightning-combobox, lightning-select, lightning-dual-listbox, lightning-checkbox, lightning-radio-group, lightning-slider, lightning-toggle';
    const combinedSelector = `${selector}, ${lightningSelector}`;
    
    return ShadowDOMTraverser.findAllElements(document, combinedSelector, 10);
  }

  // Collects elements matching filters and includes interactive descendants
  // Handles Shadow DOM traversal by checking if filter matches within shadow roots
  collectFilteredElementsWithShadowDOM() {
    const elements = [];
    const processedElements = new Set();

    for (const filter of this.currentFilters) {
      const trimmedFilter = filter.trim();
      if (!trimmedFilter) continue;

      let selector = trimmedFilter.startsWith('#') || trimmedFilter.startsWith('.') 
        ? trimmedFilter 
        : `.${trimmedFilter}`;

      try {
        const matches = ShadowDOMTraverser.findAllElements(document, selector, 10);
        
        for (const match of matches) {
          const key = this.generateElementKey(match);
          if (processedElements.has(key)) continue;
          
          if (this.isElementValidForCapture(match)) {
            elements.push(match);
            processedElements.add(key);
          }
          
          const interactiveSelector = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [onclick], [tabindex], lightning-button, lightning-input';
          const shadowPath = ShadowDOMTraverser.getShadowPath(match);
          
          let interactiveDescendants;
          if (shadowPath.inShadowDOM) {
            const rootNode = match.getRootNode();
            if (rootNode instanceof ShadowRoot || rootNode instanceof Document) {
              interactiveDescendants = ShadowDOMTraverser.findAllElements(rootNode, interactiveSelector, 5);
            } else {
              interactiveDescendants = [];
            }
          } else {
            interactiveDescendants = ShadowDOMTraverser.findAllElements(match, interactiveSelector, 5);
          }
          
          for (const desc of interactiveDescendants) {
            const descKey = this.generateElementKey(desc);
            if (processedElements.has(descKey)) continue;
            if (this.isElementValidForCapture(desc)) {
              elements.push(desc);
              processedElements.add(descKey);
            }
          }
        }
      } catch (e) {
        console.warn(`[PageScanner] Invalid selector "${selector}"`, e);
      }
    }

    return elements;
  }

  // Convenience method that delegates to Shadow DOM aware collection
  // Maintains backward compatibility with existing code paths
  collectFilteredElements() {
    return this.collectFilteredElementsWithShadowDOM();
  }

  // Validates element is suitable for capture and enrichment
  // Ensures element passes visibility, interactivity, and skip-list checks
  isElementValidForCapture(element) {
    if (this.shouldSkipElement(element)) return false;
    if (!isElementTrulyVisible(element, 'complete')) return false;
    if (!isElementInteractable(element)) return false;
    return true;
  }

  // Removes duplicates in hybrid mode based on XPath primary selector
  // Avoids double-counting elements already captured during event listeners
  deduplicateHybridCaptures(enrichedElements) {
    const deduplicated = [];
    for (const element of enrichedElements) {
      const xpath = element.selectors?.xpath?.primary;
      if (!xpath || !this.capturedInSession.has(xpath)) {
        deduplicated.push(element);
        if (xpath) this.capturedInSession.add(xpath);
      }
    }
    
    if (DEBUG && enrichedElements.length !== deduplicated.length) {
      console.log(`[PageScanner] Deduplicated ${enrichedElements.length - deduplicated.length} hybrid captures`);
    }
    
    return deduplicated;
  }

  markElementCaptured(xpath) {
    if (xpath) this.capturedInSession.add(xpath);
  }

  // Determines if element should be excluded from scanning
  // Skips infrastructure (script, style, meta) and extension UI elements
  shouldSkipElement(element) {
    const skipTags = ['SCRIPT', 'STYLE', 'META', 'LINK', 'NOSCRIPT', 'HEAD', 'TITLE'];
    if (skipTags.includes(element.tagName)) return true;
    
    const hostEl = document.getElementById('elements-tracker-host');
    if (hostEl && (hostEl.contains(element) || element === hostEl)) return true;
    
    return false;
  }

  // Collects comprehensive page metadata including dimensions and Shadow DOM analysis
  // Used for enrichment context and page-scan event payload
  getPageInfo() {
    const shadowDOMInfo = this.analyzeShadowDOM();
    
    return {
      url: window.location.href,
      title: document.title,
      domain: window.location.hostname,
      path: window.location.pathname,
      protocol: window.location.protocol,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
      document: {
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
        totalElements: this.countAllElements(),
      },
      shadowDOMInfo: shadowDOMInfo,
      language: document.documentElement.lang || 'unknown',
      charset: document.characterSet,
      meta: {
        description: document.querySelector('meta[name="description"]')?.content || null,
        keywords: document.querySelector('meta[name="keywords"]')?.content || null,
        author: document.querySelector('meta[name="author"]')?.content || null,
      },
    };
  }

  // Traverses DOM detecting Shadow DOM roots and framework patterns
  // Identifies Lightning, LWC, and Aura components for specialized enrichment
  analyzeShadowDOM() {
    let totalShadowRoots = 0;
    let maxDepth = 0;
    let elementsInShadowDOM = 0;
    const frameworks = new Set();
    
    const traverse = (root, depth = 0) => {
      if (!root || !root.querySelectorAll) return;
      
      const allElements = root.querySelectorAll('*');
      
      for (const el of allElements) {
        if (el.shadowRoot) {
          totalShadowRoots++;
          maxDepth = Math.max(maxDepth, depth + 1);
          
          const shadowElements = el.shadowRoot.querySelectorAll('*');
          elementsInShadowDOM += shadowElements.length;
          
          const tag = el.tagName.toLowerCase();
          if (tag.startsWith('lightning-')) frameworks.add('lightning');
          if (tag.startsWith('c-')) frameworks.add('lwc');
          if (el.hasAttribute('data-aura-rendered-by')) frameworks.add('aura');
          
          traverse(el.shadowRoot, depth + 1);
        } else if (el.tagName && el.tagName.includes('-')) {
          const closedRoot = ShadowDOMTraverser.tryAccessClosedShadowRoot(el);
          if (closedRoot) {
            totalShadowRoots++;
            maxDepth = Math.max(maxDepth, depth + 1);
            
            const shadowElements = closedRoot.querySelectorAll('*');
            elementsInShadowDOM += shadowElements.length;
            
            const tag = el.tagName.toLowerCase();
            if (tag.startsWith('lightning-')) frameworks.add('lightning');
            if (tag.startsWith('c-')) frameworks.add('lwc');
            
            traverse(closedRoot, depth + 1);
          }
        }
      }
    };
    
    traverse(document, 0);
    
    return {
      detected: totalShadowRoots > 0,
      totalShadowRoots: totalShadowRoots,
      maxDepth: maxDepth,
      elementsInShadowDOM: elementsInShadowDOM,
      frameworks: Array.from(frameworks),
    };
  }

  // Recursively counts all DOM elements including those in Shadow DOM trees
  // Used for page statistics in enrichment context
  countAllElements() {
    let count = 0;
    
    const traverse = (root) => {
      if (!root || !root.querySelectorAll) return;
      
      const elements = root.querySelectorAll('*');
      count += elements.length;
      
      for (const el of elements) {
        if (el.shadowRoot) {
          traverse(el.shadowRoot);
        } else if (el.tagName && el.tagName.includes('-')) {
          const closedRoot = ShadowDOMTraverser.tryAccessClosedShadowRoot(el);
          if (closedRoot) {
            traverse(closedRoot);
          }
        }
      }
    };
    
    traverse(document);
    return count;
  }

  // Generates unique key combining Shadow DOM path, tag, ID, class, and screen position
  // Key used for deduplication across multiple scrolls and captures
  generateElementKey(element) {
    try {
      const shadowPath = ShadowDOMTraverser.getShadowPath(element);
      
      const hostPath = shadowPath.hosts
        .map(h => `${h.hostTag}#${h.hostId || h.hostClasses || 'root'}`)
        .join('>>');
      
      const elementId = element.id || '';
      const elementTag = element.tagName.toLowerCase();
      const elementClass = element.className || '';
      
      const rect = element.getBoundingClientRect();
      const position = `${Math.round(rect.x)},${Math.round(rect.y)}`;
      
      return `${hostPath}::${elementTag}#${elementId}.${elementClass}@${position}`;
    } catch (e) {
      return `${element.tagName}_${Math.random()}`;
    }
  }

  // Categorizes enriched elements by HTML tag or Lightning component type
  // Returns counts for statistical reporting in scan results
  categorizeElements(enrichedElements) {
    const categories = {
      buttons: 0,
      links: 0,
      inputs: 0,
      selects: 0,
      textareas: 0,
      lightning: 0,
      other: 0,
    };

    for (const elem of enrichedElements) {
      const tag = elem.metadata?.tag?.toLowerCase();
      
      if (tag?.startsWith('lightning-')) {
        categories.lightning++;
      } else {
        switch (tag) {
          case 'button': categories.buttons++; break;
          case 'a': categories.links++; break;
          case 'input': categories.inputs++; break;
          case 'select': categories.selects++; break;
          case 'textarea': categories.textareas++; break;
          default: categories.other++; break;
        }
      }
    }
    return categories;
  }

  // Clears captured XPath set to reset session deduplication
  // Called when scan completes or session ends
  clearSessionCache() {
    this.capturedInSession.clear();
  }

  // Cleans up scanner state and caches on shutdown
  // Called before scanner instance is discarded
  destroy() {
    this.isActive = false;
    this.clearSessionCache();
    if (this.boundBatchCompleteHandler) {
      window.removeEventListener('enrichment-batch-complete', this.boundBatchCompleteHandler);
      this.boundBatchCompleteHandler = null;
    }

    if (DEBUG) console.log('[PageScanner] Destroyed');
  }

  // Non-blocking async sleep utility used for scroll delays and batch processing
  // Allows event loop to process other tasks during wait period
  sleepAsync(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default PageScanner;