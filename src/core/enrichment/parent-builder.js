// ===================================================================
// Parent Builder: Element Ancestry Hierarchy Chain Constructor
// Builds parent hierarchy filtering for meaningful stable ancestors.
// Traverses DOM tree with shadow DOM awareness for full ancestry chain.
// Dependencies: dom-utils for attribute extraction and traversal
// ===================================================================

import { isDebugEnabled } from '../shared/config.js';
import {
  getDataAttributes,
  getTagName,
  hasDataAttribute
} from '../helpers/dom-utils.js';

const MODULE_DEBUG = false;
const DEBUG = isDebugEnabled(MODULE_DEBUG);

const CONFIG = {
  MAX_PARENTS: 5,
  MAX_DEPTH: 30,
  SEMANTIC_TAGS: ['form', 'nav', 'header', 'footer', 'main', 'section', 'article', 'aside', 'dialog', 'details', 'figure', 'fieldset', 'table', 'ul', 'ol'],
  STOP_AT_TAGS: ['body', 'html']
};

// Builds chain of meaningful parent elements with shadow host traversal
// Contract: Returns {parents, fullDomPath, depth, executionTime}; filters for semantic/identified parents only
export default function buildParentChain(element) {
  const startTime = performance.now();
  
  if (!element) {
    return { parents: [], fullDomPath: '', depth: 0, executionTime: 0 };
  }
  
  const allParents = collectAllParents(element);
  const meaningfulParents = filterMeaningfulParents(allParents);
  const parentChain = meaningfulParents.map((p, index) => createParentNode(p, index + 1));
  const domPath = buildFullDomPath(allParents, element);
  
  const executionTime = Math.round(performance.now() - startTime);
  
  return {
    parents: parentChain,
    fullDomPath: domPath,
    depth: parentChain.length,
    executionTime
  };
}

// Collects all parent elements including shadow hosts up to MAX_DEPTH
// Contract: Returns array of parent elements; stops at body/html or MAX_DEPTH; includes shadow hosts in chain
function collectAllParents(element) {
  const parents = [];
  let current = element?.parentElement;
  let depth = 0;

  while (current && depth < CONFIG.MAX_DEPTH) {
    const tag = getTagName(current);
    
    if (CONFIG.STOP_AT_TAGS.includes(tag)) {
      break;
    }
    
    parents.push(current);
    current = current.parentElement;
    depth++;
  }

  try {
    const root = element.getRootNode();
    if (root instanceof ShadowRoot) {
      const host = root.host;
      if (host && !parents.includes(host)) {
        parents.push(host);
        depth++;
        
        let hostParent = host.parentElement;
        while (hostParent && depth < CONFIG.MAX_DEPTH) {
          const hostParentTag = getTagName(hostParent);
          if (CONFIG.STOP_AT_TAGS.includes(hostParentTag)) {
            break;
          }
          parents.push(hostParent);
          hostParent = hostParent.parentElement;
          depth++;
        }
        
        const hostRoot = host.getRootNode();
        if (hostRoot instanceof ShadowRoot && hostRoot !== root) {
          const nestedHost = hostRoot.host;
          if (nestedHost && !parents.includes(nestedHost)) {
            parents.push(nestedHost);
            depth++;
          }
        }
      }
    }
  } catch (e) {
    if (DEBUG) console.warn('[ParentBuilder] Shadow DOM traversal failed:', e);
  }

  return parents;
}

// Filters parent list to retain only meaningful ancestors
// Contract: Returns max MAX_PARENTS elements; prioritizes semantic tags, IDs, data attrs, custom elements, component classes
function filterMeaningfulParents(parents) {
  return parents.filter(isMeaningful).slice(0, CONFIG.MAX_PARENTS);
}

// Determines if element is meaningful based on tag, ID, data attrs, or component-like structure
// Contract: Returns true for semantic tags, elements with IDs, data attrs, custom elements (tag contains '-'), BEM-style classes
function isMeaningful(element) {
  if (!element) return false;
  
  const tag = getTagName(element);
  
  if (CONFIG.SEMANTIC_TAGS.includes(tag)) return true;
  
  if (element.id && element.id.length > 0) return true;
  
  if (hasDataAttribute(element)) return true;
  
  if (tag.includes('-')) return true;
  
  const classes = Array.from(element.classList || []);
  if (classes.length > 0 && classes.some(cls => isComponentClass(cls))) {
    return true;
  }
  
  return false;
}

// Heuristically checks if class name suggests component (not generic utility class)
// Contract: Returns false for generic layout classes (container/wrapper/etc); true for BEM syntax, component-specific names
function isComponentClass(className) {
  const lowerClass = className.toLowerCase();
  
  const genericPatterns = ['container', 'wrapper', 'inner', 'outer', 'content', 'row', 'col', 'grid', 'flex', 'layout', 'block'];
  if (genericPatterns.some(pattern => lowerClass === pattern)) {
    return false;
  }
  
  const componentPatterns = ['form', 'modal', 'dialog', 'card', 'panel', 'menu', 'nav', 'header', 'footer', 'sidebar', 'button', 'input', 'field', 'dropdown', 'accordion', 'tab'];
  if (componentPatterns.some(pattern => lowerClass.includes(pattern))) {
    return true;
  }
  
  if (className.includes('__') || className.includes('--')) {
    return true;
  }
  
  return false;
}

// Creates simplified parent node object for storage
// Contract: Returns {level, tag, id?, classes?, dataAttributes?, isShadowHost?}; omits empty collections
function createParentNode(element, level) {
  const tag = getTagName(element);
  const id = element.id || null;
  const classes = Array.from(element.classList || []);
  const dataAttrs = getDataAttributes(element);
  
  const node = {
    level,
    tag
  };
  
  if (id) {
    node.id = id;
  }
  
  if (classes.length > 0) {
    node.classes = classes;
  }
  
  if (Object.keys(dataAttrs).length > 0) {
    node.dataAttributes = dataAttrs;
  }
  
  try {
    if (element.shadowRoot || tag.includes('-')) {
      node.isShadowHost = true;
    }
  } catch (e) {
    // Ignore
  }
  
  return node;
}

// Builds simplified, readable DOM path from root to element
// Contract: Returns string with '>' separators; formats each element with tag + (id or first component class)
function buildFullDomPath(parents, element) {
  const segments = [];
  
  for (const parent of [...parents].reverse()) {
    segments.push(formatElement(parent));
  }
  
  segments.push(formatElement(element));
  
  return segments.join(' > ');
}

// Formats element into concise string representation (tag#id or tag.class)
// Contract: Returns tag with id (#) if present; otherwise tag with first component-like class (.); fallback to tag only
function formatElement(element) {
  let segment = element.tagName.toLowerCase();
  
  if (element.id) {
    segment += `#${element.id}`;
  } else if (element.classList.length > 0) {
    const classes = Array.from(element.classList);
    const mainClass = classes.find(cls => isComponentClass(cls)) || classes[0];
    if (mainClass) {
      segment += `.${mainClass}`;
    }
  }
  
  return segment;
}