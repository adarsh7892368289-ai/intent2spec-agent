// =========================================================================
// CSS Shadow Strategies: Shadow DOM CSS Selector Generation Strategies
// CSS selector generation for shadow DOM internal elements (10 strategies).
// Stateless implementations for shadow root context-scoped validation.
// Dependencies: css-utils for escapeCss and validation
// =========================================================================

import { isDebugEnabled } from '../shared/config.js';
import { escapeCss } from '../helpers/css-utils.js';

const MODULE_DEBUG = false;
const DEBUG = isDebugEnabled(MODULE_DEBUG);

class CSSShadowStrategies {
  
  // Strategy 1: ID selector (tier 1, highest stability)
  // Contract: Validates uniqueness within shadowRoot context; filters unstable IDs
  static strategyId(element, shadowRoot) {
    const results = [];
    
    if (element.id && this.isStableId(element.id)) {
      const selector = `#${escapeCss(element.id)}`;
      
      if (this.isUniqueInContext(selector, element, shadowRoot)) {
        results.push({
          selector: selector,
          strategy: 'shadow-id',
          tier: 1,
          robustness: 98
        });
      }
    }
    
    return results;
  }
  
  // Strategy 2: Test attributes (data-testid, data-qa, etc) (tier 2)
  // Contract: Prioritizes data-key/data-component-id with robustness 96
  static strategyTestAttributes(element, shadowRoot) {
    const results = [];
    const testAttrs = ['data-testid', 'data-test', 'data-qa', 'data-cy', 
                       'data-automation-id', 'data-key', 'data-component-id'];
    
    for (const attr of testAttrs) {
      const value = element.getAttribute(attr);
      
      if (value) {
        const selector = `[${attr}="${escapeCss(value)}"]`;
        
        if (this.isUniqueInContext(selector, element, shadowRoot)) {
          results.push({
            selector: selector,
            strategy: `shadow-${attr}`,
            tier: 2,
            robustness: 96
          });
        }
      }
    }
    
    return results;
  }
  
  // Strategy 3: Type + name combination for form inputs (tier 3)
  // Contract: Combines type and name attributes for high specificity
  static strategyTypeAndName(element, shadowRoot) {
    const results = [];
    const tag = element.tagName.toLowerCase();
    
    if (element.type && element.name) {
      const selector = `${tag}[type="${escapeCss(element.type)}"][name="${escapeCss(element.name)}"]`;
      
      if (this.isUniqueInContext(selector, element, shadowRoot)) {
        results.push({
          selector: selector,
          strategy: 'shadow-type-name',
          tier: 3,
          robustness: 92
        });
      }
    }
    
    return results;
  }
  
  // Strategy 4: Type-only selector (tier 4)
  // Contract: Uses type attribute with tag for moderate specificity
  static strategyType(element, shadowRoot) {
    const results = [];
    const tag = element.tagName.toLowerCase();
    
    if (element.type) {
      const selector = `${tag}[type="${escapeCss(element.type)}"]`;
      
      if (this.isUniqueInContext(selector, element, shadowRoot)) {
        results.push({
          selector: selector,
          strategy: 'shadow-type',
          tier: 4,
          robustness: 85
        });
      }
    }
    
    return results;
  }
  
  // Strategy 5: ARIA attributes (aria-label, role) (tier 5)
  // Contract: Generates tag[aria-label] and tag[role][aria-label] variants
  static strategyAria(element, shadowRoot) {
    const results = [];
    const tag = element.tagName.toLowerCase();
    
    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel) {
      const selector = `${tag}[aria-label="${escapeCss(ariaLabel)}"]`;
      
      if (this.isUniqueInContext(selector, element, shadowRoot)) {
        results.push({
          selector: selector,
          strategy: 'shadow-aria-label',
          tier: 5,
          robustness: 88
        });
      }
    }
    
    const role = element.getAttribute('role');
    if (role && ariaLabel) {
      const selector = `${tag}[role="${escapeCss(role)}"][aria-label="${escapeCss(ariaLabel)}"]`;
      
      if (this.isUniqueInContext(selector, element, shadowRoot)) {
        results.push({
          selector: selector,
          strategy: 'shadow-role-aria',
          tier: 5,
          robustness: 90
        });
      }
    }
    
    return results;
  }
  
  // Strategy 6: Stable classes (tier 6)
  // Contract: Filters classes via isStableClass; uses first 2 stable classes
  static strategyStableClasses(element, shadowRoot) {
    const results = [];
    const tag = element.tagName.toLowerCase();
    
    if (!element.className || typeof element.className !== 'string') {
      return results;
    }
    
    const classes = element.className.split(' ')
      .filter(c => c.trim().length > 3)
      .filter(c => this.isStableClass(c));
    
    if (classes.length >= 2) {
      const selector = `${tag}.${escapeCss(classes[0])}.${escapeCss(classes[1])}`;
      
      if (this.isUniqueInContext(selector, element, shadowRoot)) {
        results.push({
          selector: selector,
          strategy: 'shadow-classes',
          tier: 6,
          robustness: 75
        });
      }
    } else if (classes.length === 1) {
      const selector = `${tag}.${escapeCss(classes[0])}`;
      
      if (this.isUniqueInContext(selector, element, shadowRoot)) {
        results.push({
          selector: selector,
          strategy: 'shadow-class',
          tier: 6,
          robustness: 70
        });
      }
    }
    
    return results;
  }
  
  // Strategy 7: Name attribute (tier 7)
  // Contract: Uses name attribute for form elements; filters unstable values
  static strategyName(element, shadowRoot) {
    const results = [];
    const tag = element.tagName.toLowerCase();
    
    if (element.name && this.isStableValue(element.name)) {
      const selector = `${tag}[name="${escapeCss(element.name)}"]`;
      
      if (this.isUniqueInContext(selector, element, shadowRoot)) {
        results.push({
          selector: selector,
          strategy: 'shadow-name',
          tier: 7,
          robustness: 82
        });
      }
    }
    
    return results;
  }
  
  // Strategy 8: nth-of-type positional selector (tier 8)
  // Contract: Finds index among same-tag siblings within parent
  static strategyNthOfType(element, shadowRoot) {
    const results = [];
    const tag = element.tagName.toLowerCase();
    const parent = element.parentElement;
    
    if (!parent) return results;
    
    const siblings = Array.from(parent.children).filter(e => e.tagName === element.tagName);
    const index = siblings.indexOf(element) + 1;
    
    if (index > 0) {
      const selector = `${tag}:nth-of-type(${index})`;
      
      if (this.isUniqueInContext(selector, element, shadowRoot)) {
        results.push({
          selector: selector,
          strategy: 'shadow-nth-of-type',
          tier: 8,
          robustness: 60
        });
      }
    }
    
    return results;
  }
  
  // Strategy 9: Attribute combination (tier 9)
  // Contract: Combines first 2 data-* attributes for fingerprinting
  static strategyAttributeCombination(element, shadowRoot) {
    const results = [];
    const tag = element.tagName.toLowerCase();
    
    const attrs = Array.from(element.attributes)
      .filter(a => a.name.startsWith('data-') && this.isStableValue(a.value))
      .slice(0, 2);
    
    if (attrs.length >= 2) {
      const attrStr = attrs.map(a => `[${a.name}="${escapeCss(a.value)}"]`).join('');
      const selector = `${tag}${attrStr}`;
      
      if (this.isUniqueInContext(selector, element, shadowRoot)) {
        results.push({
          selector: selector,
          strategy: 'shadow-data-attrs',
          tier: 9,
          robustness: 78
        });
      }
    }
    
    return results;
  }
  
  // Strategy 10: Slot name for slotted content (tier 10)
  // Contract: Uses slot attribute for web component slotted elements
  static strategySlot(element, shadowRoot) {
    const results = [];
    const tag = element.tagName.toLowerCase();
    
    const slot = element.getAttribute('slot');
    if (slot) {
      const selector = `${tag}[slot="${escapeCss(slot)}"]`;
      
      if (this.isUniqueInContext(selector, element, shadowRoot)) {
        results.push({
          selector: selector,
          strategy: 'shadow-slot',
          tier: 10,
          robustness: 85
        });
      }
    }
    
    return results;
  }
  
  // Runs all 10 strategies and returns flattened results array
  // Contract: Returns array of all valid selectors sorted by tier/robustness
  static runAll(element, shadowRoot) {
    const strategies = [
      this.strategyId(element, shadowRoot),
      this.strategyTestAttributes(element, shadowRoot),
      this.strategyTypeAndName(element, shadowRoot),
      this.strategyType(element, shadowRoot),
      this.strategyAria(element, shadowRoot),
      this.strategyStableClasses(element, shadowRoot),
      this.strategyName(element, shadowRoot),
      this.strategyNthOfType(element, shadowRoot),
      this.strategyAttributeCombination(element, shadowRoot),
      this.strategySlot(element, shadowRoot)
    ];
    
    return strategies.flat();
  }
  
  // Gets best strategy by running all and selecting lowest tier
  // Contract: Returns single best selector object or fallback; never returns null
  static getBest(element, shadowRoot) {
    const all = this.runAll(element, shadowRoot);
    
    if (all.length === 0) {
      return this.getFallback(element, shadowRoot);
    }
    
    all.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      return b.robustness - a.robustness;
    });
    
    return all[0];
  }
  
  // Fallback strategy when all others fail
  // Contract: Returns nth-of-type or tag-only selector; always returns valid object
  static getFallback(element, shadowRoot) {
    const tag = element.tagName.toLowerCase();
    const parent = element.parentElement;
    
    if (!parent) {
      return {
        selector: tag,
        strategy: 'shadow-tag-only',
        tier: 99,
        robustness: 20
      };
    }
    
    const siblings = Array.from(parent.children).filter(e => e.tagName === element.tagName);
    const index = siblings.indexOf(element) + 1;
    
    return {
      selector: `${tag}:nth-of-type(${index})`,
      strategy: 'shadow-nth-fallback',
      tier: 99,
      robustness: 30
    };
  }
  
  // Validates selector uniqueness within shadowRoot context
  // Contract: Returns true only if selector matches exactly 1 element and it's the target
  static isUniqueInContext(selector, element, context) {
    try {
      const results = context.querySelectorAll(selector);
      return results.length === 1 && results[0] === element;
    } catch (error) {
      return false;
    }
  }
  
  // Checks if ID is stable (not auto-generated)
  // Contract: Filters numeric-only, framework-prefixed, Lightning-pattern IDs
  static isStableId(id) {
    if (!id || id.length < 3) return false;
    
    const unstablePatterns = [
      /^\d+$/,
      /^[0-9]{6,}$/,
      /lightning-\w+-\d+/i,
      /^ember\d+$/i,
      /^react-\d+$/i
    ];
    
    return !unstablePatterns.some(p => p.test(id));
  }
  
  // Checks if class is stable (not CSS-in-JS generated)
  // Contract: Filters Material-UI, JSS, Emotion, LWC patterns
  static isStableClass(className) {
    if (!className || typeof className !== 'string') return false;
    
    const unstablePatterns = [
      /^[a-z]\d+$/i,
      /^css-[a-z0-9]+$/i,
      /^jss\d+$/i,
      /lwc-[a-z0-9]+/i
    ];
    
    return !unstablePatterns.some(p => p.test(className));
  }
  
  // Checks if attribute value is stable (not dynamic)
  // Contract: Filters long numerics, UUIDs, timestamps
  static isStableValue(value) {
    if (!value || typeof value !== 'string') return false;
    if (value.length < 1 || value.length > 200) return false;
    
    const unstablePatterns = [
      /^[0-9]{8,}$/,
      /^[a-f0-9]{8}-[a-f0-9]{4}/i,
      /^\d{13}$/
    ];
    
    return !unstablePatterns.some(p => p.test(value));
  }
}

export default CSSShadowStrategies;