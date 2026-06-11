// =============================================================================
// Navigation Capture: SPA-Aware Route Change Detection with Single History Patch
//
// Captures page entry/exit, hash changes, and browser navigation events.
// Patches History API exactly once to prevent nested closure memory leaks.
// Clears page context cache on navigation to prevent stale element metadata.
// Dependencies: utils.js for ID/timestamp generation, enrichment-utils for cache clearing
// =============================================================================

import { isDebugEnabled } from '../shared/config.js';
import { generateElementId, getTimestamp } from '../shared/utils.js';
import { clearPageContextCache } from '../helpers/enrichment-utils.js';
import heuristicsEngine from '../shared/heuristics-engine.js';

const MODULE_DEBUG = false;
const DEBUG = isDebugEnabled(MODULE_DEBUG);

class NavigationCapture {
  constructor(mode) {
    this.isActive = false;
    this.lastUrl = window.location.href;
    this.sequenceCounter = 0;
    this.pageEntryCapture = null;
    this.captureMode = mode || 'interactions';
    
    // Store original History API methods exactly once
    // Prevents nested wrapper accumulation on multiple init() calls
    this.originalPushState = null;
    this.originalReplaceState = null;
    this.historyPatched = false;
    
    this.boundHandleBeforeUnload = this.handleBeforeUnload.bind(this);
    this.boundHandleHashChange = this.handleHashChange.bind(this);
    this.boundHandlePopState = this.handlePopState.bind(this);
  }

  // Captures initial page entry, patches History API, and attaches navigation listeners
  // History API patched exactly once per instance to prevent closure leak
  // Listeners removed before re-attachment to prevent duplicates
  init() {
    if (this.isActive) return;
    
    this.capturePageEntry();
    
    window.removeEventListener('beforeunload', this.boundHandleBeforeUnload);
    window.removeEventListener('hashchange', this.boundHandleHashChange);
    window.removeEventListener('popstate', this.boundHandlePopState);
    
    window.addEventListener('beforeunload', this.boundHandleBeforeUnload);
    window.addEventListener('hashchange', this.boundHandleHashChange);
    window.addEventListener('popstate', this.boundHandlePopState);
    
    // Only patch History API once to prevent nested wrappers
    // Each wrapper adds 5KB closure overhead; 100 init() calls = 500KB leak
    if (!this.historyPatched) {
      this.interceptHistoryAPI();
    }
    
    this.isActive = true;
    
    if (DEBUG) console.log('[NavigationCapture] Initialized');
  }

  // Captures initial page load with performance timing metrics
  // Stores reference for time-on-page calculation in beforeunload handler
  // ReadyState indicates document parsing completion status
  capturePageEntry() {
    try {
      const navigationData = {
        id: generateElementId(),
        timestamp: getTimestamp(),
        url: window.location.href,
        sessionId: window.__trackerSessionId || 'unknown',
        captureMode: this.captureMode,
        captureType: 'navigation',
        sequenceNumber: ++this.sequenceCounter,
        eventData: {
          navigation: {
            action: 'page_entry',
            from: document.referrer || null,
            to: window.location.href,
            method: 'page_load',
            timestamp: Date.now(),
            readyState: document.readyState,
            loadTime: this.getLoadTime()
          },
          page: {
            title: document.title,
            domain: window.location.hostname,
            path: window.location.pathname,
            protocol: window.location.protocol,
            search: window.location.search,
            hash: window.location.hash
          }
        }
      };
      
      this.pageEntryCapture = navigationData;
      this.sendToEventManager(navigationData);
      
      if (DEBUG) console.log('[NavigationCapture] Page entry captured');
    } catch (error) {
      console.error('[NavigationCapture] Page entry capture failed:', error);
    }
  }

  // Captures page exit event before unload with time-on-page metric
  // Flushes pending inputs to prevent data loss during hard navigation
  // Calculates session duration from stored pageEntryCapture timestamp
  handleBeforeUnload() {
    if (!this.isActive) return;
    
    try {
      this.flushPendingInputs();
      
      const navigationData = {
        id: generateElementId(),
        timestamp: getTimestamp(),
        url: window.location.href,
        sessionId: window.__trackerSessionId || 'unknown',
        captureMode: this.captureMode,
        captureType: 'navigation',
        sequenceNumber: ++this.sequenceCounter,
        eventData: {
          navigation: {
            action: 'page_exit',
            from: window.location.href,
            method: 'beforeunload',
            timeOnPage: this.pageEntryCapture ? 
              Date.now() - new Date(this.pageEntryCapture.timestamp).getTime() : null
          }
        }
      };
      
      this.sendToEventManager(navigationData);
      
      if (DEBUG) console.log('[NavigationCapture] Page exit captured');
    } catch (error) {
      console.error('[NavigationCapture] Page exit capture failed:', error);
    }
  }

  // Monkey-patches History API to intercept SPA navigation
  // Stores original methods exactly once and creates single wrapper layer
  // Active flag check prevents execution when capture disabled
  interceptHistoryAPI() {
    if (this.historyPatched) {
      if (DEBUG) console.warn('[NavigationCapture] History API already patched, skipping');
      return;
    }
    
    // Store native methods exactly once
    // Prevents wrapper-around-wrapper accumulation
    this.originalPushState = history.pushState;
    this.originalReplaceState = history.replaceState;
    
    const self = this;
    
    // Create wrapper functions with isActive guard
    // Allows disable/enable without re-patching
    history.pushState = function(...args) {
      if (self.isActive) {
        self.flushPendingInputs();
      }
      const result = self.originalPushState.apply(this, args);
      if (self.isActive) {
        setTimeout(() => self.handleHistoryChange('pushState', args[2]), 0);
      }
      return result;
    };
    
    history.replaceState = function(...args) {
      if (self.isActive) {
        self.flushPendingInputs();
      }
      const result = self.originalReplaceState.apply(this, args);
      if (self.isActive) {
        setTimeout(() => self.handleHistoryChange('replaceState', args[2]), 0);
      }
      return result;
    };
    
    this.historyPatched = true;
    
    if (DEBUG) console.log('[NavigationCapture] History API patched');
  }

  // Handles programmatic route changes via pushState/replaceState
  // Clears page context cache to prevent stale element metadata
  // Clears heuristics cache to recompute DOM complexity for new page
  handleHistoryChange(method, url) {
    if (!this.isActive) return;
    
    try {
      const newUrl = url ? new URL(url, window.location.href).href : window.location.href;
      if (newUrl === this.lastUrl) return;
      
      // Clear caches to prevent stale data post-navigation
      clearPageContextCache();
      heuristicsEngine.clearCache();

      if (this.captureMode === 'hybrid' && window.__trackerActive) {
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('hybrid-url-changed', {
            detail: { url: newUrl }
          }));
        }, 100);
      }
      
      const navigationData = {
        id: generateElementId(),
        timestamp: getTimestamp(),
        url: newUrl,
        sessionId: window.__trackerSessionId || 'unknown',
        captureMode: this.captureMode,
        captureType: 'navigation',
        sequenceNumber: ++this.sequenceCounter,
        eventData: {
          navigation: {
            action: 'route_change',
            from: this.lastUrl,
            to: newUrl,
            method: method,
            historyAPI: true
          },
          page: {
            title: document.title,
            domain: window.location.hostname,
            path: window.location.pathname
          }
        }
      };
      
      this.sendToEventManager(navigationData);
      this.lastUrl = newUrl;
      this.clearInputCache();
      
      if (DEBUG) console.log(`[NavigationCapture] Route change: ${method} -> ${newUrl}`);
    } catch (error) {
      console.error('[NavigationCapture] History change handler failed:', error);
    }
  }

  // Handles hash-based navigation without full page reload
  // Clears caches to reset enrichment context for new DOM state
  handleHashChange(event) {
    if (!this.isActive) return;
    
    try {
      clearPageContextCache();
      heuristicsEngine.clearCache();
      
      const navigationData = {
        id: generateElementId(),
        timestamp: getTimestamp(),
        url: event.newURL,
        sessionId: window.__trackerSessionId || 'unknown',
        captureMode: this.captureMode,
        captureType: 'navigation',
        sequenceNumber: ++this.sequenceCounter,
        eventData: {
          navigation: {
            action: 'hash_change',
            from: event.oldURL,
            to: event.newURL,
            method: 'hashchange'
          }
        }
      };
      
      this.sendToEventManager(navigationData);
      
      if (DEBUG) console.log(`[NavigationCapture] Hash change: ${event.newURL}`);
    } catch (error) {
      console.error('[NavigationCapture] Hash change handler failed:', error);
    }
  }

  // Handles browser back/forward navigation via popstate event
  // Flushes inputs and clears caches to ensure clean state restoration
  handlePopState(event) {
    if (!this.isActive) return;
    
    try {
      this.flushPendingInputs();
      clearPageContextCache();
      heuristicsEngine.clearCache();
      
      const navigationData = {
        id: generateElementId(),
        timestamp: getTimestamp(),
        url: window.location.href,
        sessionId: window.__trackerSessionId || 'unknown',
        captureMode: this.captureMode,
        captureType: 'navigation',
        sequenceNumber: ++this.sequenceCounter,
        eventData: {
          navigation: {
            action: 'browser_navigation',
            from: this.lastUrl,
            to: window.location.href,
            method: 'popstate',
            state: event.state
          }
        }
      };
      
      this.sendToEventManager(navigationData);
      this.lastUrl = window.location.href;
      this.clearInputCache();
      
      if (DEBUG) console.log('[NavigationCapture] Browser navigation (popstate)');
    } catch (error) {
      console.error('[NavigationCapture] Popstate handler failed:', error);
    }
  }

  // Dispatches custom event to trigger InputCapture.flushAll() before navigation
  // Silently fails if InputCapture not initialized to avoid blocking navigation
  flushPendingInputs() {
    try {
      window.dispatchEvent(new CustomEvent('flush-pending-inputs'));
    } catch (error) {
      // InputCapture may not be initialized
    }
  }

  // Dispatches custom event to trigger InputCapture.clearCache() after navigation
  // Resets input tracking state to prevent cross-route data contamination
  clearInputCache() {
    try {
      window.dispatchEvent(new CustomEvent('clear-input-cache'));
    } catch (error) {
      // InputCapture may not be initialized
    }
  }

  // Extracts Performance Timing API metrics for page load analysis
  // Returns null if API unavailable or load incomplete to avoid partial data
  // Metrics: total load time, DOM ready, DNS lookup, TCP connect, request/response
  getLoadTime() {
    try {
      if (!performance || !performance.timing) return null;
      const timing = performance.timing;
      if (timing.loadEventEnd === 0) return null;
      
      return {
        total: timing.loadEventEnd - timing.navigationStart,
        domReady: timing.domContentLoadedEventEnd - timing.navigationStart,
        dns: timing.domainLookupEnd - timing.domainLookupStart,
        tcp: timing.connectEnd - timing.connectStart,
        request: timing.responseStart - timing.requestStart,
        response: timing.responseEnd - timing.responseStart
      };
    } catch (error) {
      return null;
    }
  }

  // Dispatches navigation event to EventManager for aggregation
  // Uses window target for iframe compatibility
  sendToEventManager(navigationData) {
    window.dispatchEvent(new CustomEvent('interaction-captured', {
      detail: {
        type: 'navigation',
        timestamp: navigationData.timestamp,
        data: navigationData
      }
    }));
  }

  // Removes listeners and nullifies bound references for garbage collection
  // Does NOT restore original History API methods (permanent global patch)
  // History wrappers remain but check isActive flag before execution
  destroy() {
    if (!this.isActive) return;
    
    window.removeEventListener('beforeunload', this.boundHandleBeforeUnload);
    window.removeEventListener('hashchange', this.boundHandleHashChange);
    window.removeEventListener('popstate', this.boundHandlePopState);
    
    this.isActive = false;
    
    // Leave History API wrappers in place (permanent patch)
    // Wrappers check isActive flag before executing
    
    this.boundHandleBeforeUnload = null;
    this.boundHandleHashChange = null;
    this.boundHandlePopState = null;
    
    if (DEBUG) console.log('[NavigationCapture] Destroyed');
  }
}

export default NavigationCapture;