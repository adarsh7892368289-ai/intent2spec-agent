// =====================================================================
// Scroll Capture: Throttled Scroll Position Tracker
// Captures scroll events after 500ms idle to avoid excessive firing during continuous scrolling.
// Enforces 50px minimum delta to filter noise; calculates scroll depth percentage.
// Dependencies: generateElementId, getTimestamp from utils
// =====================================================================

import { generateElementId, getTimestamp } from '../shared/utils.js';

import { isDebugEnabled } from '../shared/config.js';

const MODULE_DEBUG = false;
const DEBUG = isDebugEnabled(MODULE_DEBUG);

class ScrollCapture {
  constructor(mode) {
    this.isActive = false;
    this.scrollTimeout = null;
    this.lastScrollY = window.scrollY;
    this.sequenceCounter = 0;
    this.throttleDelay = 500;
    this.captureMode = mode || 'interactions';
    this.boundHandleScroll = this.handleScroll.bind(this);
  }

  // Attaches passive scroll listener to avoid blocking scroll performance.
  // Removes existing listener before adding to prevent double-binding on re-init.
  init() {
    if (this.isActive) return;
    
    window.removeEventListener('scroll', this.boundHandleScroll, { passive: true });
    window.addEventListener('scroll', this.boundHandleScroll, { passive: true });
    
    this.isActive = true;
    
    if (DEBUG) console.log('[ScrollCapture] Initialized');
  }

  // Throttles capture via setTimeout to batch rapid scroll events into single capture.
  // Guards against page scanner interference to prevent double-capturing during scans.
  handleScroll() {
    if (window.__isScanningPage) return;
    if (!this.isActive) return;
    if (this.scrollTimeout) return;
    
    this.scrollTimeout = setTimeout(() => {
      this.captureScroll();
      this.scrollTimeout = null;
    }, this.throttleDelay);
  }

  // Captures scroll position with direction and percentage metrics.
  // Enforces 50px minimum delta to filter micro-scrolls and reduce capture noise.
  captureScroll() {
    if (!this.isActive) return;
    
    try {
      const scrollY = window.scrollY;
      const direction = scrollY > this.lastScrollY ? 'down' : 'up';
      const scrollDelta = Math.abs(scrollY - this.lastScrollY);
      
      if (scrollDelta < 50) return;
      
      const scrollData = {
        id: generateElementId(),
        timestamp: getTimestamp(),
        url: window.location.href,
        sessionId: window.__trackerSessionId || 'unknown',
        captureMode: this.captureMode,
        captureType: 'scroll',
        sequenceNumber: ++this.sequenceCounter,
        eventData: {
          scroll: {
            x: window.scrollX,
            y: scrollY,
            direction: direction,
            percentage: this.getScrollPercentage(),
            scrollDelta: scrollDelta,
            viewportHeight: window.innerHeight,
            documentHeight: document.documentElement.scrollHeight
          }
        }
      };
      
      this.sendToEventManager(scrollData);
      this.lastScrollY = scrollY;
      
      if (DEBUG) {
        console.log(`[ScrollCapture] Captured: ${direction} to ${this.getScrollPercentage()}%`);
      }
    } catch (error) {
      console.error('[ScrollCapture] Capture failed:', error);
    }
  }

  // Calculates scroll depth as percentage of total scrollable area.
  // Returns 100% for documents shorter than viewport to avoid division by zero.
  getScrollPercentage() {
    const scrollTop = window.scrollY;
    const docHeight = document.documentElement.scrollHeight;
    const winHeight = window.innerHeight;
    
    if (docHeight <= winHeight) return 100;
    
    const scrollPercent = scrollTop / (docHeight - winHeight);
    return Math.min(100, Math.max(0, Math.round(scrollPercent * 100)));
  }

  // Dispatches custom event for EventManager to aggregate with other capture types.
  // Uses window target to ensure event bubbles to top frame in iframe contexts.
  sendToEventManager(scrollData) {
    window.dispatchEvent(new CustomEvent('interaction-captured', {
      detail: {
        type: 'scroll',
        timestamp: scrollData.timestamp,
        data: scrollData
      }
    }));
  }

  // Removes listener, clears pending timeout, and nullifies bound reference for GC.
  // Timeout clearing prevents orphaned captures after destroy.
  destroy() {
    if (!this.isActive) return;
    
    window.removeEventListener('scroll', this.boundHandleScroll, { passive: true });
    
    if (this.scrollTimeout) {
      clearTimeout(this.scrollTimeout);
      this.scrollTimeout = null;
    }
    
    this.isActive = false;
    this.boundHandleScroll = null;
    
    if (DEBUG) console.log('[ScrollCapture] Destroyed');
  }
}

export default ScrollCapture;