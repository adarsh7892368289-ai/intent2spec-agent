// ====================================================================
// XPath Utilities: XPath Generation and Shadow DOM Context Handler
// P2 FIX: getEvaluationContext now supports depth parameter for nested shadows
// Why: XPath validation failed in deeply nested shadow DOMs (2+ levels)
// ====================================================================

import { isDebugEnabled } from '../shared/config.js';

const MODULE_DEBUG = false;
const DEBUG = isDebugEnabled(MODULE_DEBUG);

import ShadowDOMTraverser from './shadow-dom-traverser.js';

// Safely escapes XPath string values handling both quote and apostrophe characters
// Returns concat expression when mixed quotes present
export function escapeXPath(value) {
  if (typeof value !== 'string') {
    if (DEBUG) console.warn('[XPathUtils] Cannot escape non-string value');
    return '';
  }
  
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  
  const parts = value.split("'");
  const escaped = parts.map((part, index) => {
    if (index === 0) return `'${part}'`;
    return `"'",'${part}'`;
  });
  
  return `concat(${escaped.join(',')})`;
}

// Counts number of elements matching XPath expression in given context
// Returns -1 on syntax error to differentiate from zero matches
export function countXPathMatches(xpath, context = document) {
  try {
    const result = context.evaluate(
      xpath,
      context,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null
    );
    return result.snapshotLength;
  } catch (error) {
    if (DEBUG) console.error(`[XPathUtils] Count failed for "${xpath}":`, error.message);
    return -1;
  }
}

// Validates XPath expression matches target element exactly
// Used for enrichment validation to ensure selector correctness
export function xpathPointsToElement(xpath, element, context = null) {
  const evalContext = context || getEvaluationContext(element);
  
  try {
    const foundElement = getElementByXPath(xpath, evalContext);
    return foundElement === element;
  } catch (error) {
    if (DEBUG) console.error(`[XPathUtils] Validation failed for "${xpath}":`, error.message);
    return false;
  }
}

// Tests XPath syntax validity and returns match count and uniqueness flag
// Used for debugging and validation during enrichment
export function testXPath(xpath, context = document) {
  try {
    const result = context.evaluate(
      xpath,
      context,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null
    );
    
    return {
      valid: true,
      count: result.snapshotLength,
      unique: result.snapshotLength === 1,
      error: null
    };
  } catch (error) {
    return {
      valid: false,
      count: 0,
      unique: false,
      error: error.message
    };
  }
}

// Retrieves first element matching XPath expression
// Returns null if no match or syntax error
export function getElementByXPath(xpath, context = document) {
  try {
    return context.evaluate(
      xpath,
      context,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null
    ).singleNodeValue;
  } catch (error) {
    if (DEBUG) console.error(`[XPathUtils] Query failed for "${xpath}":`, error.message);
    return null;
  }
}

// Retrieves all elements matching XPath expression as array
// Returns empty array on error instead of throwing
export function getAllElementsByXPath(xpath, context = document) {
  try {
    const result = context.evaluate(
      xpath,
      context,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null
    );
    
    const elements = [];
    for (let i = 0; i < result.snapshotLength; i++) {
      elements.push(result.snapshotItem(i));
    }
    return elements;
  } catch (error) {
    if (DEBUG) console.error(`[XPathUtils] QueryAll failed for "${xpath}":`, error.message);
    return [];
  }
}

// Quick check if XPath syntax is valid without evaluating
// Used for early validation before expensive evaluation
export function isValidXPathSyntax(xpath) {
  try {
    document.evaluate(xpath, document, null, XPathResult.ANY_TYPE, null);
    return true;
  } catch (error) {
    return false;
  }
}

// Checks if XPath matches exactly one element
// Convenience wrapper around countXPathMatches
export function isXPathUnique(xpath, context = document) {
  return countXPathMatches(xpath, context) === 1;
}

// Comprehensive XPath validation returning uniqueness and target matching status
// Used for enrichment quality assessment
export function validateXPathUniqueness(xpath, targetElement, context = null) {
  const evalContext = context || getEvaluationContext(targetElement);
  
  try {
    const count = countXPathMatches(xpath, evalContext);
    
    if (count === 0) {
      return { 
        valid: false, 
        unique: false, 
        pointsToTarget: false, 
        count: 0, 
        reason: 'No elements found' 
      };
    }
    
    if (count > 1) {
      return { 
        valid: true, 
        unique: false, 
        pointsToTarget: false, 
        count, 
        reason: `Matches ${count} elements` 
      };
    }
    
    const pointsCorrectly = xpathPointsToElement(xpath, targetElement, evalContext);
    
    if (!pointsCorrectly) {
      return { 
        valid: true, 
        unique: true, 
        pointsToTarget: false, 
        count: 1, 
        reason: 'Points to different element' 
      };
    }
    
    return { 
      valid: true, 
      unique: true, 
      pointsToTarget: true, 
      count: 1, 
      reason: 'Valid and unique' 
    };
  } catch (error) {
    return { 
      valid: false, 
      unique: false, 
      pointsToTarget: false, 
      count: 0, 
      reason: error.message 
    };
  }
}

// Generates basic position-based XPath from element ID or sibling indices
// Fallback when attribute-based selectors unavailable
export function generateSimpleXPath(element) {
  if (!element || element === document.body) return '/html/body';
  
  const tag = element.tagName.toLowerCase();
  
  if (element.id) return `//${tag}[@id='${element.id}']`;
  
  let path = '';
  let current = element;
  
  while (current && current !== document.body) {
    const currentTag = current.tagName.toLowerCase();
    const parent = current.parentElement;
    
    if (parent) {
      const siblings = Array.from(parent.children).filter(e => e.tagName === current.tagName);
      if (siblings.length > 1) {
        const index = siblings.indexOf(current) + 1;
        path = `/${currentTag}[${index}]${path}`;
      } else {
        path = `/${currentTag}${path}`;
      }
    } else {
      path = `/${currentTag}${path}`;
    }
    
    current = parent;
  }
  
  return `/html/body${path}`;
}

// Cleans up XPath expression removing redundant whitespace and wildcards
// Improves readability and consistency
export function optimizeXPath(xpath) {
  if (!xpath) return xpath;
  
  return xpath
    .replace(/\/\/\*/g, '//*')
    .replace(/\[\s+/g, '[')
    .replace(/\s+\]/g, ']')
    .replace(/\s+and\s+/g, ' and ');
}

// Executes Shadow DOM composite selector (CSS-based) for cross-frame element queries
// Routes to CSS or nested CSS handler based on composite type
export function executeShadowComposite(composite, rootDocument = document) {
  if (!composite) {
    if (DEBUG) console.error('[XPathUtils] No composite selector provided');
    return null;
  }
  
  if (typeof composite.execute === 'function') {
    return composite.execute(rootDocument);
  }
  
  if (composite.type === 'shadow-composite-css') {
    return executeShadowCompositeCss(composite, rootDocument);
  }
  
  if (composite.type === 'shadow-composite-nested') {
    return executeNestedShadowCompositeCss(composite, rootDocument);
  }
  
  if (DEBUG) console.error('[XPathUtils] Unknown composite type:', composite.type);
  return null;
}

function executeShadowCompositeCss(composite, rootDocument) {
  try {
    const hostSelector = composite.hostSelector || composite.host;
    const internalSelector = composite.internalSelector || composite.internal;
    
    if (!hostSelector || !internalSelector) {
      if (DEBUG) console.error('[XPathUtils] Shadow composite missing selectors');
      return null;
    }
    
    const host = rootDocument.querySelector(hostSelector);
    if (!host) {
      if (DEBUG) console.warn('[XPathUtils] Shadow host not found:', hostSelector);
      return null;
    }
    
    let shadowRoot = host.shadowRoot;
    if (!shadowRoot) {
      shadowRoot = ShadowDOMTraverser.tryAccessClosedShadowRoot(host);
    }
    if (!shadowRoot) {
      if (DEBUG) console.warn('[XPathUtils] Shadow root inaccessible');
      return null;
    }
    
    return shadowRoot.querySelector(internalSelector);
  } catch (error) {
    if (DEBUG) console.error('[XPathUtils] Single-level shadow execution failed:', error);
    return null;
  }
}

function executeNestedShadowCompositeCss(composite, rootDocument) {
  try {
    const hostChain = composite.hostChain;
    const internalSelector = composite.internalSelector || composite.internal;
    
    if (!hostChain || !Array.isArray(hostChain) || !internalSelector) {
      if (DEBUG) console.error('[XPathUtils] Nested shadow composite missing data');
      return null;
    }
    
    let currentContext = rootDocument;
    
    for (const hostSelector of hostChain) {
      const host = currentContext.querySelector(hostSelector);
      if (!host) {
        if (DEBUG) console.warn('[XPathUtils] Host not found in chain:', hostSelector);
        return null;
      }
      
      currentContext = host.shadowRoot || 
                      ShadowDOMTraverser.tryAccessClosedShadowRoot(host);
      if (!currentContext) {
        if (DEBUG) console.warn('[XPathUtils] Shadow root inaccessible in chain');
        return null;
      }
    }
    
    return currentContext.querySelector(internalSelector);
  } catch (error) {
    if (DEBUG) console.error('[XPathUtils] Nested shadow execution failed:', error);
    return null;
  }
}

// Validates Shadow DOM composite selector matches expected element
// Used for enrichment quality checks on Shadow DOM elements
export function validateShadowComposite(composite, expectedElement) {
  try {
    const found = executeShadowComposite(composite);
    return found === expectedElement;
  } catch (error) {
    if (DEBUG) console.error('[XPathUtils] Shadow composite validation failed:', error);
    return false;
  }
}

// P2 FIX: Support depth traversal for nested shadow roots
// Why: Previous implementation returned immediate parent only
// Returns evaluation context (Shadow root or document) for XPath expressions
// Supports depth parameter for nested shadow hierarchies
export function getEvaluationContext(element, preferredDepth = 0) {
  if (!element) return document;
  
  // Default behavior: return immediate shadow root parent
  if (preferredDepth === 0) {
    const root = element.getRootNode();
    return root instanceof ShadowRoot ? root : document;
  }
  
  // Traverse up preferredDepth levels for nested shadow scenarios
  let current = element;
  for (let i = 0; i < preferredDepth; i++) {
    const root = current.getRootNode();
    if (root instanceof ShadowRoot) {
      current = root.host;
    } else {
      // Reached top of shadow hierarchy
      break;
    }
  }
  
  const finalRoot = current.getRootNode();
  return finalRoot instanceof ShadowRoot ? finalRoot : document;
}

// Tests if XPath matches target element in specific context
// Useful for validating XPath against Shadow DOM roots
export function validateInContext(xpath, element, context) {
  try {
    const result = context.evaluate(
      xpath,
      context,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null
    );
    
    if (result.snapshotLength !== 1) return false;
    
    return result.snapshotItem(0) === element;
  } catch (error) {
    return false;
  }
}

// Checks if element is inside Shadow DOM
// Used for enrichment strategy selection
export function isInShadowDOM(element) {
  if (!element) return false;
  
  const root = element.getRootNode();
  return root instanceof ShadowRoot;
}

// Calculates nesting depth within Shadow DOM hierarchy
// Higher depth indicates more complex nested structure
export function getShadowDepth(element) {
  if (!element) return 0;
  
  let depth = 0;
  let current = element;
  const maxIterations = 20;
  let iterations = 0;
  
  while (current && iterations < maxIterations) {
    const root = current.getRootNode();
    if (root instanceof ShadowRoot) {
      depth++;
      current = root.host;
    } else {
      break;
    }
    iterations++;
  }
  
  return depth;
}