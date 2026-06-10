// =============================================================================
// Click Capture: Passive Click Event Listener with Guaranteed Cleanup
// Uses composedPath() to pierce shadow DOM boundaries and identify actual target.
// Implements AbortController pattern for guaranteed listener cleanup and prevents
// orphaned handlers from accumulating on repeated initialization.
// Dependencies: enrichElement from enricher, error-tracking, config.js
// =============================================================================

import { enrichElement } from '../enrichment/enricher.js';
import { errorTracker, ERROR_CODES } from '../shared/error-tracking.js';
import { isDebugEnabled } from '../shared/config.js';

const MODULE_DEBUG = false;
const DEBUG = isDebugEnabled(MODULE_DEBUG);

// Click capture with AbortController for guaranteed cleanup
// Prevents listener orphans via signal-based cancellation
class ClickCapture {
  constructor(mode) {
    this.isActive = false;
    this.sequenceCounter = 0;
    this.captureMode = mode || 'interactions';
    this.abortController = null;
    this.setupErrorListener();
  }

  // Listens for enrichment errors to correlate failures with click context
  // Enables RCA by linking errors to specific click coordinates
  setupErrorListener() {
    window.addEventListener('tracker-error', (event) => {
      if (event.detail.code === ERROR_CODES.ENRICHMENT_DETACHED ||
          event.detail.code === ERROR_CODES.ENRICHMENT_SELECTOR_FAILED) {
        if (DEBUG) {
          console.warn('[ClickCapture] Enrichment error detected:', event.detail);
        }
      }
    });
  }

  // Attaches click listener with AbortController for guaranteed cleanup
  // Aborts previous controller before creating new one to prevent orphans
  init() {
    if (this.isActive) return;
    
    if (this.abortController) {
      this.abortController.abort();
    }
    
    this.abortController = new AbortController();
    
    document.addEventListener('click', this.handleClick.bind(this), {
      capture: true,
      passive: true,
      signal: this.abortController.signal
    });
    
    this.isActive = true;
    
    if (DEBUG) {
      console.debug('[ClickCapture] Initialized');
    }
  }

  // Enriches click target with event metadata and coordinates
  // Uses composedPath()[0] to get actual target instead of shadow host
  async handleClick(event) {
    if (!this.isActive) return;
    
    try {
      const path = event.composedPath();
      const element = path && path.length > 0 ? path[0] : event.target;
      
      if (this.shouldIgnoreElement(element)) return;
      
      const captureContext = {
        sessionId: window.__trackerSessionId || 'unknown',
        captureMode: this.captureMode,
        captureType: 'click',
        sequenceNumber: ++this.sequenceCounter,
        eventData: {
          click: {
            x: event.clientX,
            y: event.clientY,
            pageX: event.pageX,
            pageY: event.pageY,
            button: event.button,
            timestamp: Date.now(),
            modifiers: {
              ctrl: event.ctrlKey,
              alt: event.altKey,
              shift: event.shiftKey,
              meta: event.metaKey
            }
          }
        }
      };
      
      const enrichedElement = await enrichElement(element, captureContext);
      
      if (!enrichedElement) {
        errorTracker.logError(
          ERROR_CODES.ENRICHMENT_SELECTOR_FAILED,
          'Click enrichment returned null',
          {
            tag: element.tagName,
            id: element.id,
            clickX: event.clientX,
            clickY: event.clientY
          }
        );
        return;
      }
      
      this.sendToEventManager(enrichedElement);
      
      if (DEBUG) {
        console.debug(`[ClickCapture] Captured: ${element.tagName} at (${event.clientX}, ${event.clientY})`);
      }
    } catch (error) {
      errorTracker.logError(
        ERROR_CODES.ENRICHMENT_SELECTOR_FAILED,
        `Click capture failed: ${error.message}`,
        {
          error: error.message,
          stack: error.stack
        }
      );
      
      console.error('[ClickCapture] Enrichment failed:', error);
    }
  }

  // Filters non-interactive infrastructure elements
  // Prevents noise from script tags and extension UI
  shouldIgnoreElement(element) {
    const ignoredTags = ['SCRIPT', 'STYLE', 'META', 'LINK', 'HEAD', 'HTML'];
    if (ignoredTags.includes(element.tagName)) return true;
    if (element.closest('#elements-tracker-host')) return true;
    return false;
  }

  // Dispatches custom event for EventManager aggregation
  // Uses window target for iframe compatibility
  sendToEventManager(enrichedElement) {
    window.dispatchEvent(new CustomEvent('interaction-captured', {
      detail: {
        type: 'click',
        timestamp: enrichedElement.timestamp,
        data: enrichedElement
      }
    }));
  }

  // Aborts signal-based listener and releases resources
  // AbortController ensures listener is removed even if reference is lost
  destroy() {
    if (!this.isActive) return;
    
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    
    this.isActive = false;
    
    if (DEBUG) {
      console.debug('[ClickCapture] Destroyed');
    }
  }
}

export default ClickCapture;