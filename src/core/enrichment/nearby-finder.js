// ===================================================================
// Nearby Finder: Contextually Relevant Spatial Element Discovery
// Finds nearby elements prioritizing same-row table cells.
// Spatial analysis with stability scoring and direction classification.
// Dependencies: CONTEXT_CONFIG, ShadowDOMTraverser, XPathEngine
// ===================================================================

import { isDebugEnabled, CONTEXT_CONFIG } from '../shared/config.js';
import {
  getElementPosition,
  getTagName,
  isElementVisible
} from '../helpers/dom-utils.js';
import ShadowDOMTraverser from '../helpers/shadow-dom-traverser.js';
import { getAllText, truncateText } from '../helpers/text-utils.js';
import XPathEngine from './xpath-engine.js';

const MODULE_DEBUG = false;
const DEBUG = isDebugEnabled(MODULE_DEBUG);

// Finds most relevant nearby elements within configured radius with stability-based ranking
// Contract: Returns {context: Array}; max CONTEXT_CONFIG.MAX_ELEMENTS; prioritizes same table row with boost
export default function findNearbyElements(element) {
  if (!CONTEXT_CONFIG.ENABLED || !element) {
    return { context: [] };
  }

  try {
    const targetPos = getElementPosition(element);
    const centerX = targetPos.x + targetPos.width / 2;
    const centerY = targetPos.y + targetPos.height / 2;

    const targetRow = element.closest('tr');
    const inTable = !!targetRow;

    const candidates = ShadowDOMTraverser.findAllElements(
      document,
      CONTEXT_CONFIG.INTERACTIVE_ELEMENTS.join(','),
      5
    );
    const categorized = { above: [], below: [], left: [], right: [] };

    for (const candidate of candidates) {
      if (candidate === element || !isElementVisible(candidate)) continue;

      const candidatePos = getElementPosition(candidate);
      const candidateCenterX = candidatePos.x + candidatePos.width / 2;
      const candidateCenterY = candidatePos.y + candidatePos.height / 2;

      const distance = Math.sqrt(
        Math.pow(candidateCenterX - centerX, 2) +
        Math.pow(candidateCenterY - centerY, 2)
      );

      if (distance === 0 || distance > CONTEXT_CONFIG.SEARCH_RADIUS) continue;

      const direction = getDirection(centerX, centerY, candidateCenterX, candidateCenterY);
      
      const candidateRow = candidate.closest('tr');
      const inSameRow = inTable && candidateRow && candidateRow === targetRow;

      const stabilityScore = calculateStability(candidate);
      
      let finalScore = stabilityScore - (distance * 0.1);
      if (inSameRow && CONTEXT_CONFIG.ENABLE_TABLE_AWARENESS) {
        finalScore += CONTEXT_CONFIG.SAME_ROW_PRIORITY_BOOST;
      }

      categorized[direction].push({
        element: candidate,
        distance: Math.round(distance),
        stabilityScore,
        combinedScore: finalScore,
        inSameRow
      });
    }

    const context = [];
    const directions = ['above', 'below', 'left', 'right'];

    for (const direction of directions) {
      const candidates = categorized[direction];
      if (candidates.length === 0) continue;

      candidates.sort((a, b) => b.combinedScore - a.combinedScore);

      const best = candidates[0];
      const contextEl = buildContextElement(best.element, direction, best.distance);

      if (contextEl) {
        context.push(contextEl);
      }

      if (context.length >= CONTEXT_CONFIG.MAX_ELEMENTS) break;
    }

    if (context.length < CONTEXT_CONFIG.MAX_ELEMENTS) {
      const allCandidates = [
        ...categorized.above,
        ...categorized.below,
        ...categorized.left,
        ...categorized.right
      ];

      const addedTags = context.map(c => `${c.element}-${c.label}-${c.distance}`);
      const remaining = allCandidates.filter(c => {
        const tag = `${getTagName(c.element)}-${truncateText(getAllText(c.element), 50)}-${c.distance}`;
        return !addedTags.includes(tag);
      });

      remaining.sort((a, b) => b.combinedScore - a.combinedScore);

      for (const candidate of remaining) {
        if (context.length >= CONTEXT_CONFIG.MAX_ELEMENTS) break;

        const candidatePos = getElementPosition(candidate.element);
        const direction = getDirection(
          centerX, centerY,
          candidatePos.x + candidatePos.width / 2,
          candidatePos.y + candidatePos.height / 2
        );

        const contextEl = buildContextElement(candidate.element, direction, candidate.distance);
        if (contextEl) {
          context.push(contextEl);
        }
      }
    }

    return { context };

  } catch (error) {
    console.error('[NearbyFinder] Error finding nearby elements:', error);
    return { context: [] };
  }
}

// Calculates stability score based on attribute quality with weighted priority
// Contract: Returns numeric score; highest for test attributes (20), lowest for unattributed elements (0)
function calculateStability(element) {
  let score = 0;

  if (element.hasAttribute('data-testid') || 
      element.hasAttribute('data-test') || 
      element.hasAttribute('data-qa') ||
      element.hasAttribute('data-cy')) {
    score += CONTEXT_CONFIG.ELEMENT_PRIORITY['data-testid'];
  }

  if (element.id && isStableId(element.id)) {
    score += CONTEXT_CONFIG.ELEMENT_PRIORITY['stable-id'];
  }

  if (element.tagName === 'A' && element.hasAttribute('href')) {
    score += CONTEXT_CONFIG.ELEMENT_PRIORITY['a[href]'];
  }

  const dataAttrs = Array.from(element.attributes).filter(a => 
    a.name.startsWith('data-') && 
    !a.name.includes('aura-rendered') &&
    isStableValue(a.value)
  );
  if (dataAttrs.length > 0) {
    score += CONTEXT_CONFIG.ELEMENT_PRIORITY['[data-*]'];
  }

  if (element.hasAttribute('aria-label') || 
      element.hasAttribute('aria-labelledby') ||
      element.hasAttribute('role')) {
    score += CONTEXT_CONFIG.ELEMENT_PRIORITY['aria'];
  }

  if (element.hasAttribute('name') && isStableValue(element.getAttribute('name'))) {
    score += CONTEXT_CONFIG.ELEMENT_PRIORITY['name'];
  }

  const text = getAllText(element);
  if (text && text.length > 2 && text.length < 100) {
    score += CONTEXT_CONFIG.ELEMENT_PRIORITY['text'];
  }

  if (element.tagName === 'BUTTON') {
    score += CONTEXT_CONFIG.ELEMENT_PRIORITY['button'];
  }

  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(element.tagName)) {
    score += CONTEXT_CONFIG.ELEMENT_PRIORITY['input'];
  }

  const stableAttrCount = Array.from(element.attributes).filter(a => 
    isStableValue(a.value)
  ).length;
  score += Math.min(stableAttrCount * 5, 20);

  return score;
}

// Determines direction of target relative to center point using delta comparison
// Contract: Returns 'above'|'below'|'left'|'right'; prioritizes vertical over horizontal for ties
function getDirection(centerX, centerY, targetX, targetY) {
  const deltaX = targetX - centerX;
  const deltaY = targetY - centerY;

  if (Math.abs(deltaY) > Math.abs(deltaX)) {
    return deltaY < 0 ? 'above' : 'below';
  } else {
    return deltaX < 0 ? 'left' : 'right';
  }
}

// Checks if ID is stable (not auto-generated or dynamic)
// Contract: Returns false for numeric-only, long numeric substrings, Lightning/datatable patterns
function isStableId(id) {
  if (!id || id.length < 2) return false;

  const unstablePatterns = [
    /^\d+$/,
    /-\d+-\d+$/,
    /\d{8,}/,
    /^(ember|react|vue|angular)\d+$/i,
    /^uid-\d+$/i,
    /check-button-label-\d+-\d+/i,
    /lgt-datatable.*-\d+/i
  ];

  return !unstablePatterns.some(pattern => pattern.test(id));
}

// Checks if attribute value is stable (not dynamic or Aura-rendered)
// Contract: Returns false for long numerics, UUIDs, Aura patterns, positional IDs
function isStableValue(value) {
  if (!value || typeof value !== 'string') return false;
  if (value.length < 1 || value.length > 200) return false;

  const unstablePatterns = [
    /^[0-9]{8,}/,
    /^[a-f0-9]{8}-[a-f0-9]{4}/i,
    /data-aura-rendered/i,
    /-\d+-\d+$/
  ];

  return !unstablePatterns.some(pattern => pattern.test(value));
}

// Builds context element object with optional XPath generation
// Contract: Returns {element, label, direction, distance, xpath?}; generates XPath only if GENERATE_XPATH enabled
function buildContextElement(element, direction, distance) {
  const baseContext = {
    element: getTagName(element),
    label: truncateText(getAllText(element), 50) || null,
    direction,
    distance
  };

  if (CONTEXT_CONFIG.GENERATE_XPATH) {
    try {
      const xpathResult = XPathEngine.generateForContext(element);
      if (xpathResult && xpathResult.xpath) {
        baseContext.xpath = xpathResult.xpath;
        baseContext.xpathTier = xpathResult.tier;
        baseContext.xpathStrategy = xpathResult.strategy;
      }
    } catch (error) {
      if (DEBUG) console.warn('[NearbyFinder] XPath generation for context element failed:', error);
    }
  }

  return baseContext;
}

// Extended version with custom search options (radius, maxCount)
// Contract: Overrides CONTEXT_CONFIG temporarily; restores original values after execution
export function findNearbyElementsExtended(element, options = {}) {
  if (!CONTEXT_CONFIG.ENABLED) {
    return { context: [] };
  }

  const radius = options.radius || CONTEXT_CONFIG.SEARCH_RADIUS;
  const maxCount = options.maxCount || CONTEXT_CONFIG.MAX_ELEMENTS;

  const originalRadius = CONTEXT_CONFIG.SEARCH_RADIUS;
  const originalMax = CONTEXT_CONFIG.MAX_ELEMENTS;
  
  CONTEXT_CONFIG.SEARCH_RADIUS = radius;
  CONTEXT_CONFIG.MAX_ELEMENTS = maxCount;

  const result = findNearbyElements(element);

  CONTEXT_CONFIG.SEARCH_RADIUS = originalRadius;
  CONTEXT_CONFIG.MAX_ELEMENTS = originalMax;

  return result;
}