// =============================================================================
// Label Extractor: Semantic Element Identification with LRU Caching
// 
// Extracts human-readable labels from DOM elements using 12-tier priority cascade.
// Uses scroll-independent cache keys to maintain consistent hit rates across page interactions.
// Cache: LRU policy with 500-entry limit prevents unbounded memory growth.
// Dependencies: dom-utils for element queries, text-utils for normalization
// =============================================================================

import { isDebugEnabled } from '../shared/config.js';
import {
  getNearbyElements,
  getTagName,
  isFormField
} from '../helpers/dom-utils.js';
import {
  getAllText,
  getDirectText,
  isEmpty,
  normalizeWhitespace,
  titleCase,
  truncateText
} from '../helpers/text-utils.js';

const MODULE_DEBUG = false;
const DEBUG = isDebugEnabled(MODULE_DEBUG);

// Least-Recently-Used cache implementation for O(1) get/set operations
// Maintains insertion order via Map, evicts oldest entry when size exceeded
class LRUCache {
  constructor(maxSize = 500) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  // Retrieves value and promotes to most-recently-used position
  // Returns null on cache miss to distinguish from stored null values
  get(key) {
    if (!this.cache.has(key)) return null;
    
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    
    return value;
  }

  // Stores value and evicts least-recently-used entry if at capacity
  // Promotes existing key to most-recently-used if already present
  set(key, value) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    
    this.cache.set(key, value);
    
    if (this.cache.size > this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
  }

  clear() {
    this.cache.clear();
  }

  size() {
    return this.cache.size;
  }
}

const labelCache = new LRUCache(500);

// Generates stable cache key using page coordinates instead of viewport coordinates
// Prevents cache misses on scroll by using pageXOffset/pageYOffset to normalize position
// Includes parent ID and tag for hierarchical uniqueness (handles duplicate buttons)
function generateCacheKey(element) {
  const tag = element.tagName;
  const id = element.id || '';
  const classes = element.className || '';
  
  // Use page coordinates (scroll-independent) instead of viewport coordinates
  // Page coordinates remain constant as user scrolls, ensuring cache stability
  let position = '';
  try {
    const rect = element.getBoundingClientRect();
    const pageX = Math.round(rect.left + (window.pageXOffset || document.documentElement.scrollLeft));
    const pageY = Math.round(rect.top + (window.pageYOffset || document.documentElement.scrollTop));
    position = `${pageX},${pageY}`;
  } catch (e) {
    position = '0,0';
  }
  
  const parentId = element.parentElement?.id || '';
  const text = element.textContent?.substring(0, 30) || '';
  
  return `${tag}:${id}:${classes}:${parentId}:${position}:${text}`;
}

class LabelExtractor {
  
  // Extracts label using 12-tier priority cascade with LRU caching
  // Returns cached result on hit; otherwise executes full extraction and caches result
  static extract(element) {
    if (!element) {
      return this.emptyResult();
    }

    const cacheKey = generateCacheKey(element);
    const cached = labelCache.get(cacheKey);
    
    if (cached) {
      if (DEBUG) console.debug('[LabelExtractor] Cache hit for element:', element.tagName);
      return cached;
    }

    const startTime = performance.now();
    
    // Execute all 12 label extraction strategies in parallel
    // Priority cascade handled in generateDisplayName/generateLabel
    const sources = {
      ariaLabel: this.source1AriaLabel(element),
      ariaLabelledby: this.source2AriaLabelledby(element),
      associatedLabel: this.source3AssociatedLabel(element),
      visibleText: this.source4VisibleText(element),
      placeholder: this.source5Placeholder(element),
      title: this.source6Title(element),
      value: this.source7Value(element),
      alt: this.source8Alt(element),
      name: this.source9Name(element),
      dataLabel: this.source10DataLabel(element),
      nearbyLabel: this.source11NearbyLabel(element),
      fallback: this.source12Fallback(element)
    };

    const displayName = this.generateDisplayName(sources);
    const label = this.generateLabel(sources);
    const priority = this.determinePriority(sources);
    const confidence = this.calculateConfidence(sources);

    const executionTime = performance.now() - startTime;

    const result = {
      displayName,
      label,
      sources,
      priority,
      confidence,
      userEditable: true,
      executionTime: Math.round(executionTime)
    };
    
    labelCache.set(cacheKey, result);

    return result;
  }

  // Tier 1: aria-label attribute (highest WCAG priority)
  // Direct accessibility label, most reliable for screen readers
  static source1AriaLabel(element) {
    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel && !isEmpty(ariaLabel)) {
      return normalizeWhitespace(ariaLabel);
    }
    return null;
  }

  // Tier 2: aria-labelledby reference (WCAG-compliant indirect label)
  // Resolves ID reference to extract text from labeling element
  static source2AriaLabelledby(element) {
    const labelledBy = element.getAttribute('aria-labelledby');
    if (!labelledBy) return null;

    const labelElement = document.getElementById(labelledBy);
    if (labelElement) {
      const text = getAllText(labelElement);
      if (text && !isEmpty(text)) {
        return normalizeWhitespace(text);
      }
    }
    return null;
  }

  // Tier 3: Associated <label> element (form field standard)
  // Searches: label[for=id], parent <label>, preceding sibling <label>
  static source3AssociatedLabel(element) {
    if (!isFormField(element)) return null;

    // Explicit association via for attribute
    const id = element.id;
    if (id) {
      const label = document.querySelector(`label[for="${id}"]`);
      if (label) {
        const text = getAllText(label);
        if (text && !isEmpty(text)) {
          return normalizeWhitespace(text);
        }
      }
    }

    // Implicit association via wrapping label
    const parentLabel = element.closest('label');
    if (parentLabel) {
      const labelText = Array.from(parentLabel.childNodes)
        .filter(node => 
          node.nodeType === Node.TEXT_NODE || 
          (node.nodeType === Node.ELEMENT_NODE && node !== element)
        )
        .map(node => node.textContent)
        .join(' ');
      
      if (labelText && !isEmpty(labelText)) {
        return normalizeWhitespace(labelText);
      }
    }

    // Preceding sibling label (common pattern in older forms)
    let sibling = element.previousElementSibling;
    let attempts = 0;
    while (sibling && attempts < 3) {
      if (getTagName(sibling) === 'label') {
        const text = getAllText(sibling);
        if (text && !isEmpty(text)) {
          return normalizeWhitespace(text);
        }
      }
      sibling = sibling.previousElementSibling;
      attempts++;
    }

    return null;
  }

  // Tier 4: Visible text content (buttons, links)
  // Extracts direct text for interactive elements with text children
  static source4VisibleText(element) {
    const tag = getTagName(element);

    if (['button', 'a'].includes(tag)) {
      const text = getAllText(element);
      if (text && !isEmpty(text) && text.length < 100) {
        return normalizeWhitespace(text);
      }
    }

    // Input button value attribute
    if (tag === 'input') {
      const type = element.getAttribute('type');
      if (['button', 'submit', 'reset'].includes(type)) {
        const value = element.getAttribute('value');
        if (value && !isEmpty(value)) {
          return normalizeWhitespace(value);
        }
      }
    }

    const directText = getDirectText(element);
    if (directText && directText.length > 0 && directText.length < 100) {
      return normalizeWhitespace(directText);
    }

    return null;
  }

  // Tier 5: Placeholder attribute (form field hint text)
  // Standard HTML5 placeholder for input/textarea elements
  static source5Placeholder(element) {
    if (!isFormField(element)) return null;

    const placeholder = element.getAttribute('placeholder');
    if (placeholder && !isEmpty(placeholder)) {
      return normalizeWhitespace(placeholder);
    }
    return null;
  }

  // Tier 6: Title attribute (tooltip text)
  // Accessible via hover, lower priority than explicit labels
  static source6Title(element) {
    const title = element.getAttribute('title');
    if (title && !isEmpty(title) && title.length < 100) {
      return normalizeWhitespace(title);
    }
    return null;
  }

  // Tier 7: Value attribute (button inputs)
  // Specific to input[type=button|submit|reset] elements
  static source7Value(element) {
    const tag = getTagName(element);
    if (tag !== 'input') return null;

    const type = element.getAttribute('type');
    if (['button', 'submit', 'reset'].includes(type)) {
      const value = element.getAttribute('value') || element.value;
      if (value && !isEmpty(value)) {
        return normalizeWhitespace(value);
      }
    }
    return null;
  }

  // Tier 8: Alt attribute (image alternative text)
  // Required for WCAG compliance on images
  static source8Alt(element) {
    const tag = getTagName(element);
    if (tag !== 'img') return null;

    const alt = element.getAttribute('alt');
    if (alt && !isEmpty(alt)) {
      return normalizeWhitespace(alt);
    }
    return null;
  }

  // Tier 9: Name attribute (form field identifier)
  // Converts technical name to readable format (camelCase → Title Case)
  static source9Name(element) {
    const name = element.getAttribute('name');
    if (name && !isEmpty(name)) {
      const readable = name
        .replace(/[-_]/g, ' ')
        .replace(/([A-Z])/g, ' $1')
        .trim();
      return titleCase(readable);
    }
    return null;
  }

  // Tier 10: Data attributes (custom labeling)
  // Searches data-label and data-name for developer-provided labels
  static source10DataLabel(element) {
    const dataLabel = element.getAttribute('data-label') || 
                      element.getAttribute('data-name');
    
    if (dataLabel && !isEmpty(dataLabel)) {
      return normalizeWhitespace(dataLabel);
    }
    return null;
  }

  // Tier 11: Nearby label elements (spatial heuristic)
  // Finds <label>, <span>, <div>, <p> within 100px with label-like text
  static source11NearbyLabel(element) {
    try {
      const nearby = getNearbyElements(element, 100, 5);
      
      for (const item of nearby) {
        const tag = getTagName(item.element);
        
        if (tag === 'label') {
          const text = getAllText(item.element);
          if (text && !isEmpty(text) && text.length < 100) {
            return normalizeWhitespace(text);
          }
        }
        
        // Text containers with label indicators (colons, asterisks)
        if (['span', 'div', 'p'].includes(tag)) {
          const text = getAllText(item.element);
          if (text && text.length > 2 && text.length < 50) {
            if (/[:*]/.test(text)) {
              return normalizeWhitespace(text);
            }
          }
        }
      }
    } catch (e) {
      if (DEBUG) console.warn('[LabelExtractor] Nearby label search failed:', e);
    }
    
    return null;
  }

  // Tier 12: Fallback (tag-based generic label)
  // Uses role, type, or tag name as last resort
  static source12Fallback(element) {
    const tag = getTagName(element);
    const type = element.getAttribute('type');
    const role = element.getAttribute('role');

    if (role) {
      return titleCase(role.replace(/-/g, ' '));
    }

    if (tag === 'input' && type) {
      return `${titleCase(type)} Input`;
    }

    const tagNames = {
      'a': 'Link',
      'button': 'Button',
      'input': 'Input Field',
      'select': 'Dropdown',
      'textarea': 'Text Area',
      'img': 'Image',
      'form': 'Form',
      'div': 'Container',
      'span': 'Text Element'
    };

    return tagNames[tag] || titleCase(tag);
  }

  // Generates display name using first available source in priority order
  // Truncates to 100 characters to prevent UI overflow
  static generateDisplayName(sources) {
    if (sources.ariaLabel) return truncateText(sources.ariaLabel, 100);
    if (sources.ariaLabelledby) return truncateText(sources.ariaLabelledby, 100);
    if (sources.associatedLabel) return truncateText(sources.associatedLabel, 100);
    if (sources.visibleText) return truncateText(sources.visibleText, 100);
    if (sources.placeholder) return truncateText(sources.placeholder, 100);
    if (sources.title) return truncateText(sources.title, 100);
    if (sources.value) return truncateText(sources.value, 100);
    if (sources.alt) return truncateText(sources.alt, 100);
    if (sources.name) return truncateText(sources.name, 100);
    if (sources.dataLabel) return truncateText(sources.dataLabel, 100);
    if (sources.nearbyLabel) return truncateText(sources.nearbyLabel, 100);
    return sources.fallback || 'Unknown Element';
  }

  // Generates compact label (50 chars) for selector generation
  // Only includes high-confidence sources to avoid noise
  static generateLabel(sources) {
    if (sources.ariaLabel) return truncateText(sources.ariaLabel, 50);
    if (sources.ariaLabelledby) return truncateText(sources.ariaLabelledby, 50);
    if (sources.associatedLabel) return truncateText(sources.associatedLabel, 50);
    if (sources.visibleText) return truncateText(sources.visibleText, 50);
    if (sources.placeholder) return truncateText(sources.placeholder, 50);
    if (sources.dataLabel) return truncateText(sources.dataLabel, 50);
    return '';
  }

  // Returns priority source name for debugging and analytics
  // Enables tracking of which labeling strategy succeeded
  static determinePriority(sources) {
    if (sources.ariaLabel) return 'ariaLabel';
    if (sources.ariaLabelledby) return 'ariaLabelledby';
    if (sources.associatedLabel) return 'associatedLabel';
    if (sources.visibleText) return 'visibleText';
    if (sources.placeholder) return 'placeholder';
    if (sources.title) return 'title';
    if (sources.value) return 'value';
    if (sources.alt) return 'alt';
    if (sources.name) return 'name';
    if (sources.dataLabel) return 'dataLabel';
    if (sources.nearbyLabel) return 'nearbyLabel';
    return 'fallback';
  }

  // Calculates confidence score (0.0-1.0) based on label source reliability
  // WCAG-compliant sources (aria-*) receive highest confidence
  static calculateConfidence(sources) {
    if (sources.ariaLabel) return 1.0;
    if (sources.ariaLabelledby) return 0.98;
    if (sources.associatedLabel) return 0.95;
    if (sources.dataLabel) return 0.93;

    if (sources.visibleText) return 0.90;
    if (sources.alt) return 0.85;

    if (sources.placeholder) return 0.75;
    if (sources.title) return 0.70;
    if (sources.value) return 0.70;
    if (sources.nearbyLabel) return 0.65;

    if (sources.name) return 0.60;

    return 0.40;
  }

  // Returns empty result structure for null/invalid elements
  // Maintains consistent API contract with default fallback values
  static emptyResult() {
    return {
      displayName: 'Unknown Element',
      label: '',
      sources: {
        ariaLabel: null,
        ariaLabelledby: null,
        associatedLabel: null,
        visibleText: null,
        placeholder: null,
        title: null,
        value: null,
        alt: null,
        name: null,
        dataLabel: null,
        nearbyLabel: null,
        fallback: 'Unknown Element'
      },
      priority: 'fallback',
      confidence: 0.40,
      userEditable: true,
      executionTime: 0
    };
  }
  
  // Clears LRU cache on navigation or mode switches
  // Called by event-manager.js and injector.js cleanup handlers
  static clearCache() {
    labelCache.clear();
    if (DEBUG) console.log('[LabelExtractor] Cache cleared');
  }
  
  // Returns cache metrics for monitoring and debugging
  // Used by performance tracking to detect cache effectiveness
  static getCacheStats() {
    return {
      size: labelCache.size(),
      maxSize: labelCache.maxSize
    };
  }
}

export default LabelExtractor;

// Convenience function for direct label extraction
// Delegates to LabelExtractor.extract() with simplified API
export function extractLabel(element) {
  return LabelExtractor.extract(element);
}

// Extracts ARIA role with fallback to semantic tag mapping
// Returns role string for accessibility tree construction
export function extractRole(element) {
  if (!element) return 'unknown';

  const ariaRole = element.getAttribute('role');
  if (ariaRole) return ariaRole;

  const tag = getTagName(element);
  const type = element.getAttribute('type');

  if (tag === 'button' || (tag === 'input' && ['button', 'submit', 'reset'].includes(type))) {
    return 'button';
  }

  if (tag === 'a') return 'link';
  if (tag === 'input') return type || 'input';
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'form') return 'form';

  return tag;
}

// Extracts complete identification structure for element
// Combines label, role, and type into unified object
export function extractIdentification(element) {
  const labelInfo = LabelExtractor.extract(element);
  const role = extractRole(element);
  const type = element?.getAttribute('type') || null;

  return {
    displayName: labelInfo.displayName,
    label: labelInfo.label,
    role,
    type,
    description: {
      short: '',
      full: '',
      semantic: ''
    },
    userEditable: true,
    customFields: {}
  };
}