// ============================================================================
// Description Builder: Human-Readable Element Description Generator
// Builds descriptions combining color, type, label, and location context.
// Natural language generation from element properties for reporting.
// Dependencies: dom-utils for computed styles, text-utils for truncation
// ============================================================================

import { isDebugEnabled } from '../shared/config.js';
import { getComputedStyles, getTagName } from '../helpers/dom-utils.js';
import { truncateText } from '../helpers/text-utils.js';

const MODULE_DEBUG = false;
const DEBUG = isDebugEnabled(MODULE_DEBUG);

const CONFIG = {
  MAX_LENGTH: 200
};

// Builds human-readable description from element properties and parent context
// Contract: Returns {description, executionTime}; combines color + type + label + location; max CONFIG.MAX_LENGTH
export default function buildDescription(element, label, parentData) {
  const startTime = performance.now();

  if (!element) {
    return {
      description: 'Unknown element',
      executionTime: 0
    };
  }

  try {
    const parts = [];

    const color = getProminentColor(element);
    if (color) parts.push(color);

    const elementType = getElementType(element);
    parts.push(elementType);

    if (label) {
      parts.push(`labeled '${truncateText(label, 30)}'`);
    }

    if (parentData?.tag) {
      const location = getLocationDescription(parentData);
      if (location) parts.push(location);
    }

    const description = parts.join(' ');

    return {
      description: truncateText(description, CONFIG.MAX_LENGTH),
      executionTime: Math.round(performance.now() - startTime)
    };

  } catch (error) {
    console.error('[DescriptionBuilder] Error building description:', error);
    return {
      description: getElementType(element),
      executionTime: Math.round(performance.now() - startTime)
    };
  }
}

// Gets prominent color from background or class-based color indicators
// Contract: Returns color name string or null; parses RGB values or class names (primary/success/danger/etc)
function getProminentColor(element) {
  try {
    const styles = getComputedStyles(element, ['backgroundColor']);
    const bgColor = styles.backgroundColor;

    if (!bgColor || bgColor === 'rgba(0, 0, 0, 0)' || bgColor === 'transparent') {
      return checkClassBasedColor(element);
    }

    return parseColorName(bgColor);

  } catch (error) {
    if (DEBUG) console.warn('[DescriptionBuilder] Could not determine prominent color:', error);
    return null;
  }
}

// Parses RGB color string to common color name
// Contract: Returns color name for primary hues (red/green/blue/yellow/etc) or null; uses RGB threshold ranges
function parseColorName(rgb) {
  if (!rgb) return null;

  const match = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) return null;

  const [, r, g, b] = match.map(Number);

  if (r > 200 && g < 100 && b < 100) return 'red';
  if (r < 100 && g > 200 && b < 100) return 'green';
  if (r < 100 && g < 100 && b > 200) return 'blue';
  if (r > 200 && g > 200 && b < 100) return 'yellow';
  if (r > 150 && g < 150 && b > 150) return 'purple';
  if (r > 200 && g > 100 && b < 100) return 'orange';
  if (r > 200 && g > 200 && b > 200) return 'white';
  if (r < 100 && g < 100 && b < 100) return 'black';

  return null;
}

// Checks for semantic color class names (primary/success/danger/warning/secondary)
// Contract: Returns color name or null; maps Bootstrap/common framework color classes to color names
function checkClassBasedColor(element) {
  const classes = Array.from(element.classList || []).join(' ');

  if (/primary|blue/i.test(classes)) return 'blue';
  if (/success|green/i.test(classes)) return 'green';
  if (/danger|error|red/i.test(classes)) return 'red';
  if (/warning|yellow/i.test(classes)) return 'yellow';
  if (/secondary|gray/i.test(classes)) return 'gray';

  return null;
}

// Gets human-readable element type from tag and type attribute
// Contract: Returns readable string; maps standard tags to friendly names; includes type for inputs
function getElementType(element) {
  const tag = getTagName(element);
  const type = element.getAttribute('type');

  const typeMap = {
    'button': 'button',
    'a': 'link',
    'input': type ? `${type} input` : 'input field',
    'select': 'dropdown',
    'textarea': 'text area',
    'img': 'image',
    'form': 'form',
    'label': 'label'
  };

  return typeMap[tag] || tag;
}

// Gets location description from parent tag and ID
// Contract: Returns location phrase or null; combines semantic tag name with ID if present
function getLocationDescription(parentData) {
  const { tag, id } = parentData;

  if (!tag) return null;

  const locationMap = {
    'form': 'in form',
    'nav': 'in navigation',
    'header': 'in header',
    'footer': 'in footer',
    'main': 'in main content',
    'section': 'in section',
    'article': 'in article'
  };

  const base = locationMap[tag] || `in ${tag}`;

  if (id) {
    return `${base} '${id}'`;
  }

  return base;
}

// Builds extended description including nearby element context
// Contract: Returns {description, executionTime}; adds spatial context from nearbyContext array
export function buildDescriptionExtended(element, label, parentData, nearbyContext) {
  const startTime = performance.now();

  if (!element) {
    return {
      description: 'Unknown element',
      executionTime: 0
    };
  }

  try {
    const parts = [];

    const color = getProminentColor(element);
    if (color) parts.push(color);

    const elementType = getElementType(element);
    parts.push(elementType);

    if (label) {
      parts.push(`labeled '${truncateText(label, 30)}'`);
    }

    if (nearbyContext && nearbyContext.length > 0) {
      const above = nearbyContext.find(n => n.direction === 'above');
      if (above && above.label) {
        parts.push(`below '${truncateText(above.label, 20)}'`);
      }
    }

    if (parentData?.tag) {
      const location = getLocationDescription(parentData);
      if (location) parts.push(location);
    }

    const description = parts.join(' ');

    return {
      description: truncateText(description, CONFIG.MAX_LENGTH),
      executionTime: Math.round(performance.now() - startTime)
    };

  } catch (error) {
    console.error('[DescriptionBuilder] Error building extended description:', error);
    return {
      description: getElementType(element),
      executionTime: Math.round(performance.now() - startTime)
    };
  }
}