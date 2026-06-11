// =====================================================================
// Metadata Collector: Comprehensive Metadata Extraction Layer
// Collects metadata including form values with security redaction.
// Type-specific value handling for forms, links, visual properties.
// Dependencies: dom-utils for attribute/style extraction
// =====================================================================

import { isDebugEnabled } from '../shared/config.js';
import {
  getAriaAttributes,
  getComputedStyles,
  getDataAttributes,
  getElementAttributes,
  getTagName
} from '../helpers/dom-utils.js';

const MODULE_DEBUG = false;
const DEBUG = isDebugEnabled(MODULE_DEBUG);

// Collects comprehensive metadata including current form values
// Contract: Returns {metadata, executionTime}; never throws, returns partial data on error
export default function collectMetadata(element) {
  const startTime = performance.now();

  if (!element) {
    return {
      metadata: {},
      executionTime: 0
    };
  }

  try {
    const metadata = {};

    metadata.tag = getTagName(element);
    metadata.id = element.id || null;
    metadata.classes = Array.from(element.classList || []);
    
    if (element.name) metadata.name = element.name;
    if (element.type) metadata.type = element.type;

    const styles = getComputedStyles(element, [
      'color',
      'backgroundColor',
      'fontSize',
      'fontFamily',
      'fontWeight'
    ]);
    
    Object.assign(metadata, styles);

    const rect = element.getBoundingClientRect();
    metadata.width = Math.round(rect.width);
    metadata.height = Math.round(rect.height);

    const dataAttrs = getDataAttributes(element);
    if (Object.keys(dataAttrs).length > 0) {
      metadata.dataAttributes = dataAttrs;
    }

    const ariaAttrs = getAriaAttributes(element);
    if (Object.keys(ariaAttrs).length > 0) {
      metadata.ariaAttributes = ariaAttrs;
    }

    addFormAttributes(element, metadata);
    addLinkAttributes(element, metadata);
    addOtherAttributes(element, metadata);

    const executionTime = Math.round(performance.now() - startTime);

    return {
      metadata,
      executionTime
    };

  } catch (error) {
    console.error('[MetadataCollector] Error collecting metadata:', error);
    return {
      metadata: { tag: getTagName(element) },
      executionTime: Math.round(performance.now() - startTime)
    };
  }
}

// Adds form-specific attributes and current value with security redaction
// Contract: Redacts password values; handles checkbox/radio/select/file inputs; captures current state
function addFormAttributes(element, metadata) {
  const tag = getTagName(element);
  
  if (['input', 'select', 'textarea'].includes(tag)) {
    const currentValue = extractFormValue(element);
    if (currentValue !== null && currentValue !== undefined) {
      metadata.currentValue = currentValue;
    }
    
    if (element.placeholder) metadata.placeholder = element.placeholder;
    if (element.required !== undefined) metadata.required = element.required;
    if (element.disabled !== undefined) metadata.disabled = element.disabled;
    if (element.readOnly !== undefined) metadata.readOnly = element.readOnly;
    if (element.maxLength && element.maxLength !== -1) metadata.maxLength = element.maxLength;
    if (element.min) metadata.min = element.min;
    if (element.max) metadata.max = element.max;
    if (element.pattern) metadata.pattern = element.pattern;
    if (element.autocomplete) metadata.autocomplete = element.autocomplete;
    
    if (element.checked !== undefined) metadata.checked = element.checked;
    if (element.selectedIndex !== undefined) metadata.selectedIndex = element.selectedIndex;
    
    if (tag === 'select' && element.multiple) {
      metadata.selectedOptions = Array.from(element.selectedOptions).map(opt => ({
        value: opt.value,
        text: opt.text,
        index: opt.index
      }));
    }
  }
}

// Extracts current value from form element with type-specific handling and security redaction
// Contract: Returns '***' for passwords; handles checkbox (boolean), radio (value if checked), select, file (names)
function extractFormValue(element) {
  const tag = element.tagName.toLowerCase();
  const type = element.type?.toLowerCase();
  
  if (type === 'password') {
    return element.value ? '***' : null;
  }
  
  if (type === 'checkbox') {
    return element.checked;
  }
  
  if (type === 'radio') {
    return element.checked ? element.value : null;
  }
  
  if (tag === 'select' && !element.multiple) {
    return element.value;
  }
  
  if (tag === 'select' && element.multiple) {
    return Array.from(element.selectedOptions).map(opt => opt.value);
  }
  
  if (type === 'file') {
    return element.files.length > 0 
      ? Array.from(element.files).map(f => f.name).join(', ')
      : null;
  }
  
  return element.value || null;
}

// Adds link-specific attributes (href, target, rel, download)
// Contract: Only processes anchor tags; captures full href, target window, rel flags
function addLinkAttributes(element, metadata) {
  const tag = getTagName(element);
  
  if (tag === 'a') {
    if (element.href) metadata.href = element.href;
    if (element.target) metadata.target = element.target;
    if (element.rel) metadata.rel = element.rel;
    if (element.download !== undefined) metadata.download = element.download;
  }
}

// Adds other common attributes (title, alt, role, tabIndex, contentEditable)
// Contract: Filters tabIndex=-1 (default); converts contentEditable to boolean
function addOtherAttributes(element, metadata) {
  if (element.title) metadata.title = element.title;
  if (element.alt) metadata.alt = element.alt;
  if (element.role) metadata.role = element.role;
  if (element.tabIndex !== undefined && element.tabIndex !== -1) {
    metadata.tabIndex = element.tabIndex;
  }
  if (element.contentEditable === 'true') {
    metadata.contentEditable = true;
  }
}

// Collects detailed metadata with expanded style properties for deep inspection
// Contract: Returns {metadata, executionTime}; includes full computed styles, all attributes
export function collectMetadataDetailed(element) {
  const startTime = performance.now();

  if (!element) {
    return {
      metadata: {},
      executionTime: 0
    };
  }

  try {
    const metadata = {};

    metadata.tag = getTagName(element);
    metadata.id = element.id || null;
    metadata.classes = Array.from(element.classList || []);
    
    if (element.name) metadata.name = element.name;
    if (element.type) metadata.type = element.type;

    const styles = getComputedStyles(element, [
      'color',
      'backgroundColor',
      'fontSize',
      'fontFamily',
      'fontWeight',
      'display',
      'position',
      'zIndex',
      'opacity',
      'visibility',
      'cursor',
      'borderColor',
      'borderWidth',
      'borderStyle',
      'padding',
      'margin'
    ]);
    
    metadata.styles = styles;

    const rect = element.getBoundingClientRect();
    metadata.dimensions = {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      x: Math.round(rect.left),
      y: Math.round(rect.top)
    };

    const dataAttrs = getDataAttributes(element);
    if (Object.keys(dataAttrs).length > 0) {
      metadata.dataAttributes = dataAttrs;
    }

    const ariaAttrs = getAriaAttributes(element);
    if (Object.keys(ariaAttrs).length > 0) {
      metadata.ariaAttributes = ariaAttrs;
    }

    metadata.formAttributes = {};
    addFormAttributes(element, metadata.formAttributes);
    if (Object.keys(metadata.formAttributes).length === 0) {
      delete metadata.formAttributes;
    }

    metadata.linkAttributes = {};
    addLinkAttributes(element, metadata.linkAttributes);
    if (Object.keys(metadata.linkAttributes).length === 0) {
      delete metadata.linkAttributes;
    }

    metadata.otherAttributes = {};
    addOtherAttributes(element, metadata.otherAttributes);
    if (Object.keys(metadata.otherAttributes).length === 0) {
      delete metadata.otherAttributes;
    }

    metadata.allAttributes = getElementAttributes(element);

    const executionTime = Math.round(performance.now() - startTime);

    return {
      metadata,
      executionTime
    };

  } catch (error) {
    console.error('[MetadataCollector] Error collecting detailed metadata:', error);
    return {
      metadata: { tag: getTagName(element) },
      executionTime: Math.round(performance.now() - startTime)
    };
  }
}