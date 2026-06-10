// ======================================================================
// DOM Utilities: Foundational DOM Interrogation and Traversal Layer
// Provides DOM interrogation and traversal utilities with safety guards.
// Abstraction layer over native DOM APIs with cross-frame support.
// Dependencies: visibility-checker.js for complex visibility logic
// ======================================================================

import { isDebugEnabled } from '../shared/config.js';

const MODULE_DEBUG = false;
const DEBUG = isDebugEnabled(MODULE_DEBUG);

import { isElementInteractable, isElementTrulyVisible } from './visibility-checker.js';
import { errorTracker, ERROR_CODES, TrackerError } from '../shared/error-tracking.js';

// Verifies element remains attached to DOM at async boundaries
// Contract: Throws TrackerError if element detached; used at every await point to prevent race conditions
export function verifyNotDetached(element, stage) {
  if (!element || !element.isConnected) {
    const error = new TrackerError(
      ERROR_CODES.ENRICHMENT_DETACHED,
      `Element detached at ${stage}`,
      { stage, tag: element?.tagName }
    );
    throw error;
  }
}

// Ensures document readiness across frames, handling cross-origin restrictions and empty iframes.
// Contract: Returns true only when DOM is interactive/complete AND has valid body/documentElement.
export function isDOMReady(target) {
  try {
    let doc;
    
    if (target instanceof HTMLIFrameElement) {
      try {
        doc = target.contentDocument || target.contentWindow?.document;
      } catch (error) {
        if (DEBUG) console.warn('[DOMUtils] Cross-origin iframe blocked:', error);
        return false;
      }
      
      if (!doc) return false;
    } else if (target instanceof Document || target?.nodeType === 9) {
      doc = target;
    } else {
      return false;
    }
    
    if (doc.readyState === 'complete' || doc.readyState === 'interactive') {
      if (doc.body) return true;
      if (doc.documentElement && doc.documentElement.childNodes.length > 0) return true;
    }
    
    return false;
  } catch (error) {
    if (DEBUG) console.warn('[DOMUtils] isDOMReady check failed:', error);
    return false;
  }
}

// Calculates absolute page coordinates accounting for scroll offset.
// Contract: Returns comprehensive position object with 8 coordinate values; never throws.
export function getElementPosition(element) {
  if (!element?.getBoundingClientRect) {
    return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
  }

  const rect = element.getBoundingClientRect();
  const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
  const scrollTop = window.pageYOffset || document.documentElement.scrollTop;

  return {
    x: rect.left + scrollLeft,
    y: rect.top + scrollTop,
    width: rect.width,
    height: rect.height,
    top: rect.top + scrollTop,
    left: rect.left + scrollLeft,
    right: rect.right + scrollLeft,
    bottom: rect.bottom + scrollTop
  };
}

// Delegates to visibility-checker's comprehensive mode for production visibility checks.
// Contract: Wrapper for consistent API - delegates to external implementation.
export function isElementVisible(element) {
  return isElementTrulyVisible(element, 'complete');
}

// Delegates to visibility-checker's fast mode for performance-critical visibility checks.
// Contract: Wrapper for consistent API - delegates to external implementation.
export function isElementVisibleFast(element) {
  return isElementTrulyVisible(element, 'fast');
}

// Extracts dimensions from bounding rectangle without scroll offset.
// Contract: Returns viewport-relative dimensions; safe for null elements.
export function getElementSize(element) {
  if (!element) return { width: 0, height: 0 };
  const rect = element.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

// Traverses parent chain with configurable depth limit to prevent infinite loops.
// Contract: Returns array of ancestors up to maxDepth; stops at document boundary.
export function walkUpTree(element, maxDepth = 7) {
  const parents = [];
  let current = element?.parentElement;
  let depth = 0;

  while (current && depth < maxDepth) {
    parents.push(current);
    current = current.parentElement;
    depth++;
  }

  return parents;
}

// Retrieves computed styles with selective property extraction to minimize object size.
// Contract: Returns style object with requested properties; defaults to common visual properties.
export function getComputedStyles(element, properties = []) {
  if (!element) return {};

  const styles = window.getComputedStyle(element);
  const result = {};

  const defaultProps = properties.length === 0
    ? ['backgroundColor', 'color', 'fontSize', 'fontFamily', 'fontWeight', 'display']
    : properties;

  for (const prop of defaultProps) {
    try {
      result[prop] = styles[prop];
    } catch (error) {
      if (DEBUG) console.warn('[DOMUtils] Style access failed:', prop, error);
    }
  }

  return result;
}

// Delegates to visibility-checker for interactability determination.
// Contract: Wrapper for consistent API - delegates to external implementation.
export function isElementInteractive(element) {
  return isElementInteractable(element);
}

// Calculates element depth by traversing to document root.
// Contract: Returns integer depth; handles detached elements gracefully.
export function getElementDepth(element) {
  let depth = 0;
  let current = element;

  while (current?.parentElement) {
    depth++;
    current = current.parentElement;
  }

  return depth;
}

// Searches ancestor chain for first element with specified attribute within depth limit.
// Contract: Returns matching ancestor or null; depth limit prevents performance degradation.
export function findClosestWithAttribute(element, attribute, maxDepth = 5) {
  let current = element;
  let depth = 0;

  while (current && depth < maxDepth) {
    if (current.hasAttribute(attribute)) return current;
    current = current.parentElement;
    depth++;
  }

  return null;
}

// Validates element against form field tag whitelist.
// Contract: Returns boolean; handles null elements safely.
export function isFormField(element) {
  if (!element) return false;
  const formTags = ['INPUT', 'SELECT', 'TEXTAREA'];
  return formTags.includes(element.tagName?.toUpperCase());
}

// Normalizes tag name to lowercase for consistent comparisons.
// Contract: Returns lowercase string or empty string for invalid elements.
export function getTagName(element) {
  return element?.tagName?.toLowerCase() || '';
}

// Safely executes querySelector with error recovery to prevent selector syntax crashes.
// Contract: Returns element or null; never throws on invalid selectors.
export function safeQuerySelector(selector, context = document) {
  try {
    return context.querySelector(selector);
  } catch (error) {
    if (DEBUG) console.error(`[DOMUtils] Invalid selector: "${selector}"`, error);
    return null;
  }
}

// Safely executes querySelectorAll with error recovery and array conversion.
// Contract: Returns array (empty on error); never throws on invalid selectors.
export function safeQuerySelectorAll(selector, context = document) {
  try {
    return Array.from(context.querySelectorAll(selector));
  } catch (error) {
    if (DEBUG) console.error(`[DOMUtils] Invalid selector: "${selector}"`, error);
    return [];
  }
}

// Calculates element center position as viewport percentages with zone classification.
// Contract: Returns position object with zone label (e.g., "top-left"); handles null elements.
export function getViewportPosition(element) {
  if (!element) {
    return { x: 0, y: 0, percentX: 0, percentY: 0, zone: 'unknown' };
  }

  const rect = element.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;

  const percentX = (centerX / window.innerWidth) * 100;
  const percentY = (centerY / window.innerHeight) * 100;

  let zone = '';
  if (percentY < 33) zone = 'top';
  else if (percentY < 66) zone = 'middle';
  else zone = 'bottom';

  if (percentX < 33) zone += '-left';
  else if (percentX < 66) zone += '-center';
  else zone += '-right';

  return {
    x: centerX,
    y: centerY,
    percentX: Math.round(percentX),
    percentY: Math.round(percentY),
    zone
  };
}

// Calculates Euclidean distance between element centers using Pythagorean theorem.
// Contract: Returns distance in pixels or Infinity for null elements.
function calculateCenterPoint(element) {
  const pos = getElementPosition(element);
  return {
    x: pos.x + pos.width / 2,
    y: pos.y + pos.height / 2
  };
}

export function calculateDistance(elem1, elem2) {
  if (!elem1 || !elem2) return Infinity;

  const center1 = calculateCenterPoint(elem1);
  const center2 = calculateCenterPoint(elem2);

  return Math.sqrt(
    Math.pow(center2.x - center1.x, 2) + Math.pow(center2.y - center1.y, 2)
  );
}

// Finds visible, interactive elements within radius in specified cardinal direction.
// Contract: Returns sorted array by distance; filters by visibility and direction constraints.
export function findElementsInDirection(element, direction, radius = 300) {
  if (!element) return [];

  const rect = element.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;

  const allElements = Array.from(document.querySelectorAll('*'));
  const results = [];

  for (const el of allElements) {
    if (el === element || !isElementVisible(el) || !isElementInteractive(el)) continue;

    const elRect = el.getBoundingClientRect();
    const elCenterX = elRect.left + elRect.width / 2;
    const elCenterY = elRect.top + elRect.height / 2;

    const distance = Math.sqrt(
      Math.pow(elCenterX - centerX, 2) + Math.pow(elCenterY - centerY, 2)
    );

    if (distance > radius) continue;

    const isInDirection = (
      (direction === 'above' && elCenterY < centerY) ||
      (direction === 'below' && elCenterY > centerY) ||
      (direction === 'left' && elCenterX < centerX) ||
      (direction === 'right' && elCenterX > centerX)
    );

    if (isInDirection) {
      results.push({ element: el, distance, tag: el.tagName.toLowerCase() });
    }
  }

  return results.sort((a, b) => a.distance - b.distance);
}

// Finds nearest visible elements within radial proximity, sorted by distance.
// Contract: Returns up to maxCount elements; excludes source element and invisible elements.
export function getNearbyElements(element, maxDistance = 300, maxCount = 10) {
  if (!element) return [];

  const rect = element.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;

  const allElements = Array.from(document.querySelectorAll('*'));
  const nearby = [];

  for (const el of allElements) {
    if (el === element || !isElementVisible(el)) continue;

    const elRect = el.getBoundingClientRect();
    const elCenterX = elRect.left + elRect.width / 2;
    const elCenterY = elRect.top + elRect.height / 2;

    const distance = Math.sqrt(
      Math.pow(elCenterX - centerX, 2) + Math.pow(elCenterY - centerY, 2)
    );

    if (distance <= maxDistance && distance > 0) {
      nearby.push({ element: el, distance, tag: el.tagName.toLowerCase() });
    }
  }

  return nearby.sort((a, b) => a.distance - b.distance).slice(0, maxCount);
}

// Searches ancestor chain for semantically meaningful parent using heuristic rules.
// Contract: Returns first parent with ID, data attributes, or semantic tag; null if none found.
export function findMeaningfulParent(element) {
  const parents = walkUpTree(element, 7);
  
  for (const parent of parents) {
    if (parent.id) return parent;
    
    const dataAttr = Array.from(parent.attributes).find(a => a.name.startsWith('data-'));
    if (dataAttr) return parent;
    
    const semanticTags = ['form', 'nav', 'header', 'footer', 'main', 'section', 'article'];
    if (semanticTags.includes(parent.tagName.toLowerCase())) return parent;
  }
  
  return parents[0] || null;
}

// Calculates absolute center point including scroll offset.
// Contract: Returns page coordinates of element center; safe for null elements.
export function getElementCenter(element) {
  if (!element) return { x: 0, y: 0 };
  
  const rect = element.getBoundingClientRect();
  const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
  const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
  
  return {
    x: rect.left + scrollLeft + rect.width / 2,
    y: rect.top + scrollTop + rect.height / 2
  };
}

// Checks if element is fully within viewport bounds (not partially visible).
// Contract: Returns true only if all edges are within viewport; strict containment check.
export function isInViewport(element) {
  if (!element) return false;
  
  const rect = element.getBoundingClientRect();
  return (
    rect.top >= 0 &&
    rect.left >= 0 &&
    rect.bottom <= window.innerHeight &&
    rect.right <= window.innerWidth
  );
}

// Filters all document elements to only visible ones using comprehensive visibility check.
// Contract: Returns filtered array; performance scales with DOM size.
export function getAllVisibleElements(selector = '*') {
  const elements = Array.from(document.querySelectorAll(selector));
  return elements.filter(el => isElementVisible(el));
}

// Extracts all HTML attributes into key-value object for serialization.
// Contract: Returns attribute map; handles null elements safely.
export function getElementAttributes(element) {
  if (!element) return {};
  
  const attrs = {};
  for (const attr of element.attributes) {
    attrs[attr.name] = attr.value;
  }
  return attrs;
}

// Checks for presence of data-* attributes, optionally targeting specific name.
// Contract: Returns boolean; null attrName checks for any data-* attribute.
export function hasDataAttribute(element, attrName = null) {
  if (!element) return false;
  
  if (attrName) return element.hasAttribute(attrName);
  
  return Array.from(element.attributes).some(a => a.name.startsWith('data-'));
}

// Extracts only data-* attributes for selector generation and metadata.
// Contract: Returns filtered attribute map; excludes non-data attributes.
export function getDataAttributes(element) {
  if (!element) return {};
  
  const dataAttrs = {};
  for (const attr of element.attributes) {
    if (attr.name.startsWith('data-')) {
      dataAttrs[attr.name] = attr.value;
    }
  }
  return dataAttrs;
}

// Extracts only aria-* attributes for accessibility metadata.
// Contract: Returns filtered attribute map; excludes non-aria attributes.
export function getAriaAttributes(element) {
  if (!element) return {};
  
  const ariaAttrs = {};
  for (const attr of element.attributes) {
    if (attr.name.startsWith('aria-')) {
      ariaAttrs[attr.name] = attr.value;
    }
  }
  return ariaAttrs;
}

// Determines clickability using tag, event handler, role, and cursor heuristics.
// Contract: Returns boolean; multi-signal detection for robustness.
export function isClickable(element) {
  if (!element) return false;
  
  const clickableTags = ['A', 'BUTTON'];
  if (clickableTags.includes(element.tagName?.toUpperCase())) return true;
  
  if (element.onclick || element.hasAttribute('onclick')) return true;
  
  const role = element.getAttribute('role');
  if (role === 'button' || role === 'link') return true;
  
  const cursor = window.getComputedStyle(element).cursor;
  return cursor === 'pointer';
}

// Alias for getBoundingClientRect for consistent API.
// Contract: Returns DOMRect or null for invalid elements.
export function getElementRect(element) {
  if (!element) return null;
  return element.getBoundingClientRect();
}

// Checks if elem1 is positioned above elem2 using non-overlapping bottom/top edges.
// Contract: Returns boolean; handles null elements safely.
export function isElementAbove(elem1, elem2) {
  if (!elem1 || !elem2) return false;
  const rect1 = elem1.getBoundingClientRect();
  const rect2 = elem2.getBoundingClientRect();
  return rect1.bottom <= rect2.top;
}

// Checks if elem1 is positioned below elem2 using non-overlapping top/bottom edges.
// Contract: Returns boolean; handles null elements safely.
export function isElementBelow(elem1, elem2) {
  if (!elem1 || !elem2) return false;
  const rect1 = elem1.getBoundingClientRect();
  const rect2 = elem2.getBoundingClientRect();
  return rect1.top >= rect2.bottom;
}

// Checks if elem1 is positioned left of elem2 using non-overlapping right/left edges.
// Contract: Returns boolean; handles null elements safely.
export function isElementLeftOf(elem1, elem2) {
  if (!elem1 || !elem2) return false;
  const rect1 = elem1.getBoundingClientRect();
  const rect2 = elem2.getBoundingClientRect();
  return rect1.right <= rect2.left;
}

// Checks if elem1 is positioned right of elem2 using non-overlapping left/right edges.
// Contract: Returns boolean; handles null elements safely.
export function isElementRightOf(elem1, elem2) {
  if (!elem1 || !elem2) return false;
  const rect1 = elem1.getBoundingClientRect();
  const rect2 = elem2.getBoundingClientRect();
  return rect1.left >= rect2.right;
}