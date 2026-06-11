// =============================================================================
// Form Capture: Form Submission Listener with Deduplication
// Captures all form fields with type-aware value redaction. Implements WeakMap
// deduplication with timestamp tracking to prevent duplicate captures from rapid
// submit button clicks (double-click prevention pattern).
// Dependencies: enrichElement from enricher, config.js
// =============================================================================

import { enrichElement } from '../enrichment/enricher.js';
import { isDebugEnabled, FORM_CAPTURE_CONFIG } from '../shared/config.js';

const MODULE_DEBUG = false;
const DEBUG = isDebugEnabled(MODULE_DEBUG);

// Form capture with deduplication to prevent double-click captures
// Uses WeakMap with timestamp to filter rapid submissions
class FormCapture {
  constructor(mode) {
    this.isActive = false;
    this.sequenceCounter = 0;
    this.captureMode = mode || 'interactions';
    this.boundHandleSubmit = this.handleSubmit.bind(this);
    this.recentForms = new WeakMap();
    this.deduplicationWindow = FORM_CAPTURE_CONFIG.DEDUPLICATION_WINDOW_MS;
  }

  // Attaches submit listener in capture phase
  // Removes existing listener before adding to prevent duplicates
  init() {
    if (this.isActive) return;
    
    document.removeEventListener('submit', this.boundHandleSubmit, true);
    document.addEventListener('submit', this.boundHandleSubmit, true);
    
    this.isActive = true;
    
    if (DEBUG) {
      console.debug('[FormCapture] Initialized');
    }
  }

  // Enriches form element with deduplication check
  // Validates target is actual form element before processing
  async handleSubmit(event) {
    if (!this.isActive) return;
    
    try {
      const form = event.target;
      if (!form || form.tagName !== 'FORM') return;
      
      if (this.isDuplicateSubmission(form)) {
        if (DEBUG) {
          console.debug('[FormCapture] Duplicate submission ignored (within deduplication window)');
        }
        return;
      }
      
      this.markFormSubmitted(form);
      
      const formData = this.extractFormData(form);
      
      const captureContext = {
        sessionId: window.__trackerSessionId || 'unknown',
        captureMode: this.captureMode,
        captureType: 'form',
        sequenceNumber: ++this.sequenceCounter,
        eventData: {
          form: {
            action: form.action || null,
            method: form.method || 'get',
            fieldCount: formData.fields.length,
            submissionType: event.submitter ? 'button' : 'programmatic',
            formData: formData
          }
        }
      };
      
      const enrichedForm = await enrichElement(form, captureContext);
      if (!enrichedForm) return;
      
      this.sendToEventManager(enrichedForm);
      
      if (DEBUG) {
        console.debug(`[FormCapture] Captured: ${formData.fields.length} fields`);
      }
    } catch (error) {
      console.error('[FormCapture] Enrichment failed:', error);
    }
  }

  // Checks if form was submitted within deduplication window
  // Uses WeakMap to avoid memory leaks from form references
  isDuplicateSubmission(form) {
    const lastSubmission = this.recentForms.get(form);
    if (!lastSubmission) return false;
    
    const timeSinceLastSubmit = Date.now() - lastSubmission;
    return timeSinceLastSubmit < this.deduplicationWindow;
  }

  // Marks form as submitted with current timestamp
  // WeakMap automatically releases entries when form is garbage collected
  markFormSubmitted(form) {
    this.recentForms.set(form, Date.now());
  }

  // Iterates form.elements to extract field metadata
  // Skips unnamed fields to avoid noise from hidden infrastructure inputs
  extractFormData(form) {
    const fields = [];
    const formElements = form.elements;
    
    for (let i = 0; i < formElements.length; i++) {
      const element = formElements[i];
      if (!element.name) continue;
      
      fields.push({
        name: element.name,
        type: element.type || element.tagName.toLowerCase(),
        value: this.getFieldValue(element),
        required: element.required || false
      });
    }
    
    return { fields, fieldCount: fields.length };
  }

  // Extracts value with type-specific logic
  // Redacts passwords to empty string for security
  getFieldValue(element) {
    const type = element.type?.toLowerCase();
    
    if (type === 'password') return element.value ? '' : '';
    if (type === 'checkbox') return element.checked;
    if (type === 'radio') return element.checked ? element.value : null;
    if (element.tagName === 'SELECT' && element.multiple) {
      return Array.from(element.selectedOptions).map(opt => opt.value);
    }
    if (type === 'file') {
      return element.files.length > 0 ? Array.from(element.files).map(f => f.name) : [];
    }
    
    return element.value || '';
  }

  // Dispatches custom event for EventManager aggregation
  // Uses window target for iframe compatibility
  sendToEventManager(enrichedForm) {
    window.dispatchEvent(new CustomEvent('interaction-captured', {
      detail: {
        type: 'form',
        timestamp: enrichedForm.timestamp,
        data: enrichedForm
      }
    }));
  }

  // Removes listener and nullifies bound reference
  // Clears isActive flag to prevent post-destroy execution
  destroy() {
    if (!this.isActive) return;
    
    document.removeEventListener('submit', this.boundHandleSubmit, true);
    this.isActive = false;
    this.boundHandleSubmit = null;
    
    if (DEBUG) {
      console.debug('[FormCapture] Destroyed');
    }
  }
}

export default FormCapture;