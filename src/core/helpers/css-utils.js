// ======================================================================
// CSS Utilities: CSS Selector Manipulation and Validation Helpers
// CSS selector manipulation, validation, and specificity calculation.
// Abstraction over CSS.escape and querySelectorAll with safety guards.
// Dependencies: None - pure CSS API wrappers
// ======================================================================

import { isDebugEnabled } from '../shared/config.js';

const MODULE_DEBUG = false;
const DEBUG = isDebugEnabled(MODULE_DEBUG);

// Wraps CSS.escape to prevent selector injection vulnerabilities in dynamic selectors.
// Contract: Returns escaped string safe for use in CSS selectors; handles non-strings gracefully.
export function escapeCss(value) {
  if (typeof value !== 'string') {
    if (DEBUG) console.warn('[CSSUtils] Cannot escape non-string:', typeof value);
    return '';
  }
  return CSS.escape(value);
}

// Validates selector syntax and counts matches in a single operation.
// Contract: Returns validation object with valid/unique flags; never throws on syntax errors.
export function testCss(selector, context = document) {
  try {
    const elements = context.querySelectorAll(selector);
    return {
      valid: true,
      count: elements.length,
      unique: elements.length === 1,
      error: null
    };
  } catch (error) {
    if (DEBUG) console.error(`[CSSUtils] Invalid selector "${selector}":`, error);
    return {
      valid: false,
      count: 0,
      unique: false,
      error: error.message
    };
  }
}

// Counts selector matches with exception recovery to prevent crashes.
// Contract: Returns integer count or 0 on syntax error; never throws.
export function countCssMatches(selector, context = document) {
  try {
    return context.querySelectorAll(selector).length;
  } catch (error) {
    if (DEBUG) console.warn('[CSSUtils] Count failed for selector:', selector, error);
    return 0;
  }
}

// Retrieves first matching element with exception recovery.
// Contract: Returns element or null on syntax error/no match; never throws.
export function getElementByCss(selector, context = document) {
  try {
    return context.querySelector(selector);
  } catch (error) {
    if (DEBUG) console.warn('[CSSUtils] Query failed for selector:', selector, error);
    return null;
  }
}

// Retrieves all matching elements with automatic array conversion.
// Contract: Returns array (empty on error); never throws on syntax errors.
export function getAllElementsByCss(selector, context = document) {
  try {
    return Array.from(context.querySelectorAll(selector));
  } catch (error) {
    if (DEBUG) console.warn('[CSSUtils] QueryAll failed for selector:', selector, error);
    return [];
  }
}

// Validates selector syntax by attempting a query (browser's native validation).
// Contract: Returns boolean; uses browser's internal parser for accurate validation.
export function isValidCssSyntax(selector) {
  try {
    document.querySelector(selector);
    return true;
  } catch (error) {
    return false;
  }
}

// Checks if selector matches exactly one element (uniqueness validation).
// Contract: Returns boolean; critical for automation selector stability.
export function isCssUnique(selector, context = document) {
  return countCssMatches(selector, context) === 1;
}

// Validates if element matches the given selector using native .matches().
// Contract: Returns boolean; exception-safe alternative to direct .matches() calls.
export function selectorPointsToElement(selector, element) {
  try {
    return element.matches(selector);
  } catch (error) {
    if (DEBUG) console.warn('[CSSUtils] Match check failed:', selector, error);
    return false;
  }
}

// Calculates CSS specificity as [ID, class/attr/pseudo, element] tuple for sorting.
// Contract: Returns 3-element array representing specificity weight; handles complex selectors.
export function calculateSpecificity(selector) {
  if (typeof selector !== 'string') return [0, 0, 0];

  let a = 0; // ID count
  let b = 0; // Class/attribute/pseudo-class count
  let c = 0; // Element/pseudo-element count

  const withoutPseudoElements = selector.replace(/::[a-z-]+/gi, match => {
    c++;
    return '';
  });

  const ids = withoutPseudoElements.match(/#[a-z0-9_-]+/gi);
  a = ids ? ids.length : 0;

  const classes = withoutPseudoElements.match(/\.[a-z0-9_-]+/gi);
  b += classes ? classes.length : 0;

  const attributes = withoutPseudoElements.match(/\[[^\]]+\]/g);
  b += attributes ? attributes.length : 0;

  const pseudoClasses = withoutPseudoElements.match(/:[a-z-]+(?:\([^)]*\))?/gi);
  b += pseudoClasses ? pseudoClasses.filter(p => !p.startsWith('::')).length : 0;

  const elements = withoutPseudoElements.match(/(?:^|[\s>+~])([a-z][a-z0-9]*)/gi);
  c += elements ? elements.length : 0;

  return [a, b, c];
}

// Generates :nth-child() selector for element's position among all siblings.
// Contract: Returns selector string or empty string for orphan elements.
export function generateNthChild(element) {
  if (!element?.parentElement) return '';
  const parent = element.parentElement;
  const siblings = Array.from(parent.children);
  const index = siblings.indexOf(element) + 1;
  const tag = element.tagName.toLowerCase();
  return `${tag}:nth-child(${index})`;
}

// Generates :nth-of-type() selector for element's position among same-tag siblings.
// Contract: Returns selector string or empty string for orphan elements.
export function generateNthOfType(element) {
  if (!element?.parentElement) return '';
  const parent = element.parentElement;
  const tag = element.tagName;
  const siblings = Array.from(parent.children).filter(e => e.tagName === tag);
  const index = siblings.indexOf(element) + 1;
  return `${tag.toLowerCase()}:nth-of-type(${index})`;
}

// Normalizes whitespace around combinators for consistent selector formatting.
// Contract: Returns trimmed, normalized selector; idempotent transformation.
export function optimizeCssSelector(selector) {
  if (!selector) return selector;
  
  selector = selector.replace(/\s+>/g, ' >');
  selector = selector.replace(/>\s+/g, '> ');
  selector = selector.replace(/\s+/g, ' ');
  
  return selector.trim();
}