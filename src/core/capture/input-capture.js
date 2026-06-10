// =============================================================================
// Input Capture: Change-Based Field Tracking with Memory Leak Prevention
// Captures input changes on blur with delta detection. Implements bounded map
// with LRU eviction (max 100 entries) and navigation cleanup to prevent memory
// leaks. Updates entries on blur instead of deleting to handle rapid focus changes.
// Dependencies: enrichElement from enricher, config.js
// =============================================================================

import { enrichElement } from '../enrichment/enricher.js';
import { isDebugEnabled, INPUT_CAPTURE_CONFIG } from '../shared/config.js';

const MODULE_DEBUG = false;
const DEBUG = isDebugEnabled(MODULE_DEBUG);

// Input capture with bounded map and navigation cleanup
// Prevents unbounded growth via size limit and pagehide listener
class InputCapture {
  constructor(mode) {
    this.isActive = false;
    this.sequenceCounter = 0;
    this.captureMode = mode || 'interactions';
    this.activeInputs = new Map();
    this.maxActiveInputs = INPUT_CAPTURE_CONFIG.MAX_ACTIVE_INPUTS;
    
    this.boundHandleFocus = this.handleFocus.bind(this);
    this.boundHandleBlur = this.handleBlur.bind(this);
    this.boundFlushAll = this.flushAll.bind(this);
    this.boundClearCache = this.clearCache.bind(this);
    this.boundClearOnNavigation = this.clearCache.bind(this);
  }

  // Attaches focus/blur listeners and navigation cleanup
  // Removes existing listeners before adding to prevent duplicates
  init() {
    if (this.isActive) return;
    
    document.removeEventListener('focus', this.boundHandleFocus, true);
    document.removeEventListener('blur', this.boundHandleBlur, true);
    window.removeEventListener('flush-pending-inputs', this.boundFlushAll);
    window.removeEventListener('clear-input-cache', this.boundClearCache);
    window.removeEventListener('pagehide', this.boundClearOnNavigation);
    
    document.addEventListener('focus', this.boundHandleFocus, true);
    document.addEventListener('blur', this.boundHandleBlur, true);
    window.addEventListener('flush-pending-inputs', this.boundFlushAll);
    window.addEventListener('clear-input-cache', this.boundClearCache);
    window.addEventListener('pagehide', this.boundClearOnNavigation);
    
    this.isActive = true;
    
    if (DEBUG) {
      console.debug('[InputCapture] Initialized');
    }
  }

  // Records initial value on focus with size limit enforcement
  // Evicts oldest entry if map exceeds max size to prevent unbounded growth
  handleFocus(event) {
    if (!this.isActive) return;
    
    const element = event.target;
    if (!this.shouldCaptureElement(element)) return;
    
    if (this.activeInputs.size >= this.maxActiveInputs && !this.activeInputs.has(element)) {
      const oldestKey = this.activeInputs.keys().next().value;
      this.activeInputs.delete(oldestKey);
      
      if (DEBUG) {
        console.debug('[InputCapture] Evicted oldest entry to prevent memory leak');
      }
    }
    
    this.activeInputs.set(element, {
      initialValue: this.getElementValue(element),
      focusTime: Date.now()
    });
  }

  // Captures input only if value changed and updates entry instead of deleting
  // Preserves entry for rapid focus changes to maintain correct initial value
  async handleBlur(event) {
    if (!this.isActive) return;
    
    const element = event.target;
    if (!this.shouldCaptureElement(element)) return;
    
    const tracking = this.activeInputs.get(element);
    if (!tracking) return;
    
    const currentValue = this.getElementValue(element);
    const valueChanged = currentValue !== tracking.initialValue;
    
    if (valueChanged) {
      await this.captureInput(element, currentValue, tracking);
    }
    
    tracking.initialValue = currentValue;
    tracking.lastBlurTime = Date.now();
  }

  // Enriches input element with event metadata and value change delta
  // Async to support enricher's parallel selector generation
  async captureInput(element, value, tracking) {
    try {
      const captureContext = {
        sessionId: window.__trackerSessionId || 'unknown',
        captureMode: this.captureMode,
        captureType: 'input',
        sequenceNumber: ++this.sequenceCounter,
        eventData: {
          input: {
            value: value,
            valueLength: value ? value.length : 0,
            eventType: 'blur',
            inputType: element.type || 'text',
            name: element.name || null,
            placeholder: element.placeholder || null,
            hasValue: !!value,
            checked: element.type === 'checkbox' || element.type === 'radio' ? element.checked : null,
            selectedIndex: element.tagName === 'SELECT' ? element.selectedIndex : null,
            selectedOptions: element.tagName === 'SELECT' && element.multiple ?
              Array.from(element.selectedOptions).map(opt => ({ value: opt.value, text: opt.text })) : null,
            focusDuration: tracking ? Date.now() - tracking.focusTime : null,
            initialValue: tracking ? tracking.initialValue : null,
            valueChanged: true
          }
        }
      };

      const enrichedInput = await enrichElement(element, captureContext);
      if (!enrichedInput) return;

      this.sendToEventManager(enrichedInput);
      
      if (DEBUG) {
        console.debug(`[InputCapture] Captured: ${element.name || element.tagName} (${value.length} chars)`);
      }
    } catch (error) {
      console.error('[InputCapture] Enrichment failed:', error);
    }
  }

  // Filters non-interactive input types and respects password settings
  // Returns false for elements that shouldn't be tracked
  shouldCaptureElement(element) {
    if (!element) return false;
    
    const tag = element.tagName?.toLowerCase();
    const type = element.type?.toLowerCase();
    
    const validTags = ['input', 'textarea', 'select'];
    if (!validTags.includes(tag)) return false;
    
    const ignoredTypes = ['hidden', 'submit', 'reset', 'button', 'image'];
    if (tag === 'input' && ignoredTypes.includes(type)) return false;
    
    if (type === 'password' && !window.__capturePasswordFields) return false;
    
    return true;
  }

  // Extracts value with type-specific logic
  // Redacts password fields to empty string for security
  getElementValue(element) {
    const tag = element.tagName?.toLowerCase();
    const type = element.type?.toLowerCase();
    
    if (type === 'password') return element.value ? '' : '';
    if (type === 'checkbox') return element.checked;
    if (type === 'radio') return element.checked ? element.value : null;
    if (tag === 'select' && !element.multiple) return element.value;
    if (tag === 'select' && element.multiple) {
      return Array.from(element.selectedOptions).map(opt => opt.value).join(', ');
    }
    if (type === 'file') {
      return element.files.length > 0 ? Array.from(element.files).map(f => f.name).join(', ') : '';
    }
    
    return element.value || '';
  }

  // Captures all pending inputs before navigation
  // Called by NavigationCapture to prevent data loss
  flushAll() {
    if (!this.isActive) return;
    
    this.activeInputs.forEach((tracking, element) => {
      const currentValue = this.getElementValue(element);
      if (currentValue !== tracking.initialValue) {
        this.captureInput(element, currentValue, tracking);
      }
    });
    
    this.activeInputs.clear();
    
    if (DEBUG) {
      console.debug('[InputCapture] Flushed pending inputs');
    }
  }

  // Clears map without capturing to prevent stale state
  // Called on navigation and pagehide to release element references
  clearCache() {
    this.activeInputs.clear();
    
    if (DEBUG) {
      console.debug('[InputCapture] Cleared input cache');
    }
  }

  // Dispatches custom event for EventManager aggregation
  // Uses window target for iframe compatibility
  sendToEventManager(enrichedInput) {
    window.dispatchEvent(new CustomEvent('interaction-captured', {
      detail: {
        type: 'input',
        timestamp: enrichedInput.timestamp,
        data: enrichedInput
      }
    }));
  }

  // Removes all listeners and clears map for clean shutdown
  // Nullifies bound references to prevent memory leaks
  destroy() {
    if (!this.isActive) return;
    
    document.removeEventListener('focus', this.boundHandleFocus, true);
    document.removeEventListener('blur', this.boundHandleBlur, true);
    window.removeEventListener('flush-pending-inputs', this.boundFlushAll);
    window.removeEventListener('clear-input-cache', this.boundClearCache);
    window.removeEventListener('pagehide', this.boundClearOnNavigation);
    
    this.activeInputs.clear();
    this.isActive = false;
    
    this.boundHandleFocus = null;
    this.boundHandleBlur = null;
    this.boundFlushAll = null;
    this.boundClearCache = null;
    this.boundClearOnNavigation = null;
    
    if (DEBUG) {
      console.debug('[InputCapture] Destroyed');
    }
  }
}

export default InputCapture;