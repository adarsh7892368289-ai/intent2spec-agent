// =====================================================================
// Data Schemas: Phase 3 Worker Message Protocol
// Added: Worker message types for main thread ↔ Worker communication
// Element snapshot schema for Worker serialization (DOM-independent)
// =====================================================================

import { isDebugEnabled } from './config.js';

const MODULE_DEBUG = false;
const DEBUG = isDebugEnabled(MODULE_DEBUG);

// Creates template for enriched element with all enrichment metadata fields
// Used for ensuring consistent data structure across enrichment pipeline
export function createEnrichedElement() {
  return {
    id: '',
    timestamp: '',
    url: '',
    pageTitle: '',
    sessionId: '',
    captureMode: '',
    captureType: '',
    sequenceNumber: 0,
    
    name: '',
    label: '',
    tagName: '',
    
    selectors: {
      xpath: {
        primary: '',
        fallback1: null,
        fallback2: null,
        tier: null,
        strategy: null,
        robustness: null,
        isShadowComposite: false,
        compositeType: null,
        executable: null
      },
      css: {
        selector: '',
        tier: null,
        strategy: null,
        isShadowComposite: false,
        executable: null
      }
    },
    
    shadowDOM: false,
    shadowDepth: 0,
    shadowHosts: [],
    shadowFramework: null,
    
    location: {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      visible: false,
      inViewport: false
    },
    
    description: '',
    
    hierarchy: {
      parents: [],
      depth: 0
    },
    
    context: [],
    
    metadata: {},
    
    eventData: null
  };
}

// Creates DOM-independent element snapshot for Worker serialization
// Captures essential element properties without direct DOM references
export function createElementSnapshot(element) {
  const attrs = {};
  
  try {
    for (const attr of element.attributes) {
      attrs[attr.name] = attr.value;
    }
  } catch (e) {
    if (DEBUG) console.warn('[Schemas] Failed to extract attributes:', e);
  }
  
  return {
    tag: element.tagName,
    text: element.textContent?.trim().substring(0, 200) || '',
    attributes: attrs
  };
}

// Validates enriched element has all required fields for valid tracking record
// Returns detailed error list for diagnostics
export function validateElement(element) {
  const errors = [];
  
  if (!element.id) errors.push('Missing id');
  if (!element.timestamp) errors.push('Missing timestamp');
  if (!element.sessionId) errors.push('Missing sessionId');
  if (!element.selectors?.xpath?.primary && !element.selectors?.css?.selector) {
    errors.push('Missing both XPath and CSS selectors');
  }
  if (!element.name) errors.push('Missing element name');
  if (!element.tagName) errors.push('Missing tagName');
  
  if (errors.length > 0 && DEBUG) {
    console.warn('[Schemas] Element validation failed:', { errors, element });
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

// Validates input event data contains required interaction fields
// Used for form fill and text input capture validation
export function validateInputEventData(eventData) {
  const errors = [];
  
  if (!eventData?.input) {
    errors.push('Missing input event data');
    return { valid: false, errors };
  }
  
  const input = eventData.input;
  
  if (!input.eventType) errors.push('Missing eventType');
  if (input.value === undefined && input.checked === undefined) {
    errors.push('Missing value or checked state');
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}

// Validates navigation event has required action and destination information
// Used for page navigation capture validation
export function validateNavigationEventData(eventData) {
  const errors = [];
  
  if (!eventData?.navigation) {
    errors.push('Missing navigation event data');
    return { valid: false, errors };
  }
  
  const nav = eventData.navigation;
  
  if (!nav.action) errors.push('Missing action');
  if (!nav.to) errors.push('Missing destination URL');
  if (!nav.method) errors.push('Missing navigation method');
  
  return {
    valid: errors.length === 0,
    errors
  };
}

// Enum for Worker message types for main thread ↔ Worker IPC protocol
// Maintains message type consistency across threaded enrichment
export const WORKER_MESSAGE_TYPES = {
  ENRICH_ELEMENT: 'ENRICH_ELEMENT',
  ENRICH_BATCH: 'ENRICH_BATCH',
  ENRICHMENT_RESULT: 'ENRICHMENT_RESULT',
  BATCH_RESULT: 'BATCH_RESULT',
  ENRICHMENT_ERROR: 'ENRICHMENT_ERROR'
};

// Schema for element snapshot passed to Workers (DOM-independent serializable format)
export const ELEMENT_SNAPSHOT_SCHEMA = {
  tag: 'string',
  text: 'string',
  attributes: 'object'
};

// Schema for Worker request message format (main → Worker)
export const WORKER_REQUEST_SCHEMA = {
  type: 'string',
  messageId: 'number',
  payload: {
    elementSnapshot: 'ElementSnapshot',
    timeout: 'number'
  }
};

// Schema for Worker response message format (Worker → main)
export const WORKER_RESPONSE_SCHEMA = {
  type: 'string',
  messageId: 'number',
  payload: {
    success: 'boolean',
    xpath: 'XPathResult',
    css: 'CSSResult'
  }
};

// Ranked attribute names for XPath strategy priority selection
// Used by XPathEngine and profiler to focus on stable identifiers
export const PRIORITY_ATTRIBUTES = [
  'data-testid',
  'data-test',
  'data-qa',
  'data-cy',
  'data-component-id',
  'id',
  'name',
  'aria-label',
  'aria-labelledby'
];

// HTML tags that represent interactive elements for capture filtering
// Used by page scanner to identify candidate elements
export const INTERACTIVE_TAGS = [
  'a',
  'button',
  'input',
  'select',
  'textarea',
  'label'
];

// HTML tags representing form input fields
// Used for form capture and input event handling
export const FORM_FIELD_TAGS = [
  'input',
  'select',
  'textarea'
];

// HTML tags representing semantic page structure containers
// Used by semantic ancestor strategy in XPath generation
export const SEMANTIC_TAGS = [
  'form',
  'main',
  'header',
  'footer',
  'nav',
  'section',
  'article',
  'aside'
];

// Schema for input event data from form fields and text inputs
// Defines fields extracted during input capture
export const INPUT_EVENT_SCHEMA = {
  eventType: 'string',
  inputType: 'string',
  value: 'any',
  hasValue: 'boolean',
  valueLength: 'number',
  checked: 'boolean|null',
  selectedIndex: 'number|null',
  selectedOptions: 'array|null',
  placeholder: 'string|null',
  name: 'string|null'
};

// Schema for page navigation event data (click, link, history, etc.)
// Captures navigation context and performance metrics
export const NAVIGATION_EVENT_SCHEMA = {
  action: 'string',
  from: 'string|null',
  to: 'string',
  method: 'string',
  historyAPI: 'boolean|null',
  loadTime: 'object|null',
  state: 'any|null'
};

// Schema for mouse click event data with modifier keys and coordinates
// Used for click interaction tracking
export const CLICK_EVENT_SCHEMA = {
  button: 'number',
  altKey: 'boolean',
  ctrlKey: 'boolean',
  shiftKey: 'boolean',
  metaKey: 'boolean',
  clientX: 'number',
  clientY: 'number',
  screenX: 'number',
  screenY: 'number'
};

// Schema for form submission event data including action and field info
// Used for form capture and submission tracking
export const FORM_EVENT_SCHEMA = {
  action: 'string|null',
  method: 'string|null',
  fieldCount: 'number',
  submissionType: 'string',
  formData: 'object|null'
};

// Schema for page scroll event data including direction and depth percentage
// Used for scroll behavior analysis and reach metrics
export const SCROLL_EVENT_SCHEMA = {
  scrollX: 'number',
  scrollY: 'number',
  scrollDirection: 'string',
  scrollDepth: 'number',
  documentHeight: 'number',
  viewportHeight: 'number'
};

// Migrates legacy selector format to current schema with Shadow DOM support
// Ensures backward compatibility for stored selectors
export function migrateSelectorFormat(oldSelector) {
  if (!oldSelector) return null;
  
  if (oldSelector.isShadowComposite) {
    return oldSelector;
  }
  
  return {
    primary: oldSelector.primary,
    fallback1: oldSelector.fallback1,
    fallback2: oldSelector.fallback2,
    tier: oldSelector.tier,
    strategy: oldSelector.strategy,
    robustness: oldSelector.robustness,
    isShadowComposite: false
  };
}