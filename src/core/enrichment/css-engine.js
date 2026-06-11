// ===========================================================================================
// CSS Engine: Strategic CSS Selector Generation with Shadow DOM Support
// Validates all selectors via querySelector uniqueness check; routes shadow elements to handler.
// Implements 10-strategy cascade (ID, data attrs, type, class, combinators, pseudo, positional).
// Dependencies: css-utils, dom-utils, ShadowDOMTraverser, CSSShadowStrategies
// ===========================================================================================

import { isDebugEnabled } from '../shared/config.js';
import { countCssMatches, escapeCss, isValidCssSyntax } from '../helpers/css-utils.js';
import { walkUpTree } from '../helpers/dom-utils.js';
import ShadowDOMTraverser from '../helpers/shadow-dom-traverser.js';
import CSSShadowStrategies from './css-shadow-strategies.js';

const MODULE_DEBUG = false;
const DEBUG = isDebugEnabled(MODULE_DEBUG);

class CSSEngine {
  
  // Generates CSS selector via 10-strategy cascade, routing shadow DOM elements to composite handler
  // Contract: Returns first unique selector found; tests strategies in tier order (1=ID, 10=nth-type)
  static generate(element) {
    if (!element || !element.tagName) {
      return this.emptyResult();
    }

    const startTime = performance.now();
    const tag = element.tagName.toLowerCase();
    
    const shadowContext = ShadowDOMTraverser.getShadowPath(element);
    
    if (shadowContext.inShadowDOM) {
      if (DEBUG) console.log('[CSSEngine] Shadow DOM detected, generating composite selector');
      const shadowResult = this.generateShadowCSS(element, shadowContext);
      return this.buildResult(shadowResult, startTime);
    }
    
    let result = null;
    
    result = this.tryStrategy(element, tag, 1, this.strategy1Id);
    if (result) return this.buildResult(result, startTime);
    
    result = this.tryStrategy(element, tag, 2, this.strategy2DataAttrs);
    if (result) return this.buildResult(result, startTime);
    
    result = this.tryStrategy(element, tag, 3, this.strategy3CombinedData);
    if (result) return this.buildResult(result, startTime);
    
    result = this.tryStrategy(element, tag, 4, this.strategy4TypeName);
    if (result) return this.buildResult(result, startTime);
    
    result = this.tryStrategy(element, tag, 5, this.strategy5ClassAttr);
    if (result) return this.buildResult(result, startTime);
    
    result = this.tryStrategy(element, tag, 6, this.strategy6ParentChild);
    if (result) return this.buildResult(result, startTime);
    
    result = this.tryStrategy(element, tag, 7, this.strategy7Descendant);
    if (result) return this.buildResult(result, startTime);
    
    result = this.tryStrategy(element, tag, 8, this.strategy8Pseudo);
    if (result) return this.buildResult(result, startTime);
    
    result = this.tryStrategy(element, tag, 9, this.strategy9NthChild);
    if (result) return this.buildResult(result, startTime);
    
    result = this.tryStrategy(element, tag, 10, this.strategy10NthType);
    if (result) return this.buildResult(result, startTime);
    
    return this.emptyResult();
  }

  // Generates CSS composite selector for shadow DOM elements with execute() function
  // Contract: Combines host selector with internal selector; supports nested shadow (depth > 1) via hostChain
  static generateShadowCSS(element, shadowContext) {
    const tag = element.tagName.toLowerCase();
    
    const shadowRoot = element.getRootNode();
    if (!(shadowRoot instanceof ShadowRoot)) {
      if (DEBUG) console.warn('[CSSEngine] Cannot access shadow root');
      return { selector: null, tier: 0, strategy: 'none' };
    }
    
    const internalResult = CSSShadowStrategies.getBest(element, shadowRoot);
    
    if (!internalResult) {
      return { selector: null, tier: 0, strategy: 'none' };
    }
    
    if (shadowContext.depth > 1) {
      return this.generateNestedShadowCSS(element, shadowContext, internalResult);
    }
    
    const hostSelector = this.buildShadowHostSelector(shadowContext.hosts[0]);
    
    const composite = {
      type: 'shadow-composite-css',
      hostSelector: hostSelector,
      internalSelector: internalResult.selector,
      shadowDepth: shadowContext.depth,
      framework: shadowContext.framework,
      
      execute: function(rootDocument = document) {
        try {
          const host = rootDocument.querySelector(this.hostSelector);
          if (!host) return null;
          
          let shadowRoot = host.shadowRoot;
          if (!shadowRoot) {
            shadowRoot = ShadowDOMTraverser.tryAccessClosedShadowRoot(host);
          }
          if (!shadowRoot) return null;
          
          return shadowRoot.querySelector(this.internalSelector);
        } catch (error) {
          console.error('[CSSEngine] Shadow composite CSS execution failed:', error);
          return null;
        }
      },
      
      toString: function() {
        return `${this.hostSelector} >> ${this.internalSelector}`;
      },
      
      playwright: `${hostSelector} >>> ${internalResult.selector}`,
      selenium: `${hostSelector}::shadow ${internalResult.selector}`,
      cypress: hostSelector
    };
    
    return {
      selector: composite,
      tier: internalResult.tier,
      strategy: `shadow-${internalResult.strategy}`,
      shadowDOM: true,
      shadowDepth: shadowContext.depth,
      shadowHosts: [hostSelector],
      internalSelector: internalResult.selector
    };
  }

  // Handles nested shadow DOM (depth > 1) by building complete host chain with chained execute()
  // Contract: Creates hostChain array; execute() traverses chain sequentially to reach final shadowRoot
  static generateNestedShadowCSS(element, shadowContext, internalResult) {
    const hostChain = shadowContext.hosts.map(hostInfo => 
      this.buildShadowHostSelector(hostInfo)
    );
    
    const composite = {
      type: 'shadow-composite-nested',
      hostChain: hostChain,
      internalSelector: internalResult.selector,
      shadowDepth: shadowContext.depth,
      framework: shadowContext.framework,
      
      execute: function(rootDocument = document) {
        try {
          let currentContext = rootDocument;
          
          for (const hostSelector of this.hostChain) {
            const host = currentContext.querySelector(hostSelector);
            if (!host) return null;
            
            currentContext = host.shadowRoot || 
                            ShadowDOMTraverser.tryAccessClosedShadowRoot(host);
            if (!currentContext) return null;
          }
          
          return currentContext.querySelector(this.internalSelector);
        } catch (error) {
          console.error('[CSSEngine] Nested shadow CSS execution failed:', error);
          return null;
        }
      },
      
      toString: function() {
        return this.hostChain.join(' >> ') + ' >> ' + this.internalSelector;
      },
      
      playwright: hostChain.join(' >>> ') + ' >>> ' + internalResult.selector,
      selenium: hostChain.map(h => `${h}::shadow`).join(' ') + ' ' + internalResult.selector,
      cypress: hostChain[0]
    };
    
    return {
      selector: composite,
      tier: internalResult.tier,
      strategy: `shadow-nested-${internalResult.strategy}`,
      shadowDOM: true,
      shadowDepth: shadowContext.depth,
      shadowHosts: hostChain,
      internalSelector: internalResult.selector
    };
  }

  // Builds CSS selector for shadow host element prioritizing stable attributes
  // Contract: Prioritizes aria-controls, Lightning attrs, test attrs, id, classes; returns tag as fallback
  static buildShadowHostSelector(hostInfo) {
    if (!hostInfo) return hostInfo.hostTag || 'unknown';
    
    const tag = hostInfo.hostTag;
    const attrs = hostInfo.hostAttributes;
    
    if (attrs['aria-controls']) {
      return `${tag}[aria-controls="${escapeCss(attrs['aria-controls'])}"]`;
    }
    
    const lightningAttrs = ['data-key', 'data-record-id', 'data-component-id'];
    for (const attr of lightningAttrs) {
      if (attrs[attr]) {
        return `${tag}[${attr}="${escapeCss(attrs[attr])}"]`;
      }
    }
    
    const testAttrs = ['data-testid', 'data-test', 'data-qa'];
    for (const attr of testAttrs) {
      if (attrs[attr]) {
        return `${tag}[${attr}="${escapeCss(attrs[attr])}"]`;
      }
    }
    
    if (attrs.id && this.isStableId(attrs.id)) {
      return `${tag}#${escapeCss(attrs.id)}`;
    }
    
    if (attrs.class) {
      const classes = attrs.class.split(' ')
        .filter(c => c.length > 3 && !c.match(/^[a-z]\d+$/));
      
      if (classes.length >= 2) {
        return `${tag}.${escapeCss(classes[0])}.${escapeCss(classes[1])}`;
      } else if (classes.length === 1) {
        return `${tag}.${escapeCss(classes[0])}`;
      }
    }
    
    return tag;
  }

  // Executes strategy function and tests each candidate for uniqueness
  // Contract: Returns first unique selector from strategy or null; validates via isUnique()
  static tryStrategy(element, tag, tier, strategyFunc) {
    const selectors = strategyFunc.call(this, element, tag);
    
    for (const s of selectors) {
      if (this.isUnique(s.selector, element)) {
        return { ...s, tier };
      }
    }
    
    return null;
  }

  // Strategy 1: ID selector (tier 1, highest priority)
  // Contract: Generates #id and tag#id variants; filters unstable IDs via isStableId
  static strategy1Id(element, tag) {
    const selectors = [];
    
    if (element.id && this.isStableId(element.id)) {
      selectors.push({
        selector: `#${escapeCss(element.id)}`,
        strategy: 'id'
      });
      
      selectors.push({
        selector: `${tag}#${escapeCss(element.id)}`,
        strategy: 'id-with-tag'
      });
    }
    
    return selectors;
  }

  // Strategy 2: Test automation data attributes (tier 2)
  // Contract: Checks data-testid, data-qa, etc; generates both attribute-only and tag[attr] variants
  static strategy2DataAttrs(element, tag) {
    const selectors = [];
    
    const testAttrs = ['data-testid', 'data-test', 'data-qa', 'data-cy'];
    
    for (const attr of testAttrs) {
      const value = element.getAttribute(attr);
      if (value) {
        selectors.push({
          selector: `[${attr}="${escapeCss(value)}"]`,
          strategy: 'data-attribute'
        });
        
        selectors.push({
          selector: `${tag}[${attr}="${escapeCss(value)}"]`,
          strategy: 'data-attribute-with-tag'
        });
      }
    }
    
    return selectors;
  }

  // Strategy 3: Combined data attributes (tier 3)
  // Contract: Combines first 2 data-* attributes into single selector
  static strategy3CombinedData(element, tag) {
    const selectors = [];
    
    const dataAttrs = Array.from(element.attributes)
      .filter(a => a.name.startsWith('data-') && a.value)
      .slice(0, 2);
    
    if (dataAttrs.length >= 2) {
      const attrStr = dataAttrs
        .map(a => `[${a.name}="${escapeCss(a.value)}"]`)
        .join('');
      
      selectors.push({
        selector: `${tag}${attrStr}`,
        strategy: 'combined-data-attributes'
      });
    }
    
    return selectors;
  }

  // Strategy 4: Type and name combination for form inputs (tier 4)
  // Contract: Generates type+name, type-only variants
  static strategy4TypeName(element, tag) {
    const selectors = [];
    
    if (element.type && element.name) {
      selectors.push({
        selector: `${tag}[type="${escapeCss(element.type)}"][name="${escapeCss(element.name)}"]`,
        strategy: 'type-name'
      });
    }
    
    if (element.type) {
      selectors.push({
        selector: `${tag}[type="${escapeCss(element.type)}"]`,
        strategy: 'type-only'
      });
    }
    
    return selectors;
  }

  // Strategy 5: Class attributes (tier 5)
  // Contract: Uses first 2 meaningful classes; combines with type attribute if available
  static strategy5ClassAttr(element, tag) {
    const selectors = [];
    
    const classes = this.getMeaningfulClasses(element);
    
    if (classes.length > 0) {
      const classStr = classes.slice(0, 2).map(c => `.${escapeCss(c)}`).join('');
      
      selectors.push({
        selector: `${tag}${classStr}`,
        strategy: 'class-attribute'
      });
      
      if (element.type) {
        selectors.push({
          selector: `${tag}${classStr}[type="${escapeCss(element.type)}"]`,
          strategy: 'class-with-type'
        });
      }
    }
    
    return selectors;
  }

  // Strategy 6: Parent > child combinator (tier 6)
  // Contract: Finds stable parent within 5 levels; uses direct child combinator
  static strategy6ParentChild(element, tag) {
    const selectors = [];
    const parent = this.findStableParent(element);
    
    if (!parent) return selectors;
    
    const parentSelector = this.getParentSelector(parent);
    const childSelector = this.getChildSelector(element);
    
    selectors.push({
      selector: `${parentSelector} > ${childSelector}`,
      strategy: 'parent-child'
    });
    
    return selectors;
  }

  // Strategy 7: Descendant combinator (tier 7)
  // Contract: Finds stable parent within 5 levels; uses descendant combinator
  static strategy7Descendant(element, tag) {
    const selectors = [];
    const parent = this.findStableParent(element);
    
    if (!parent) return selectors;
    
    const parentSelector = this.getParentSelector(parent);
    const childSelector = this.getChildSelector(element);
    
    selectors.push({
      selector: `${parentSelector} ${childSelector}`,
      strategy: 'complex-descendant'
    });
    
    return selectors;
  }

  // Strategy 8: Pseudo-classes (:disabled, :required, :checked) (tier 8)
  // Contract: Generates selectors for form state pseudo-classes
  static strategy8Pseudo(element, tag) {
    const selectors = [];
    
    if (element.disabled) {
      selectors.push({
        selector: `${tag}:disabled`,
        strategy: 'pseudo-disabled'
      });
    }
    
    if (element.required) {
      selectors.push({
        selector: `${tag}:required`,
        strategy: 'pseudo-required'
      });
    }
    
    if (element.checked !== undefined) {
      selectors.push({
        selector: `${tag}:checked`,
        strategy: 'pseudo-checked'
      });
    }
    
    return selectors;
  }

  // Strategy 9: nth-child positional selector (tier 9)
  // Contract: Uses parent selector + nth-child index; finds index among all children
  static strategy9NthChild(element, tag) {
    const selectors = [];
    const parent = element.parentElement;
    
    if (!parent) return selectors;
    
    const siblings = Array.from(parent.children);
    const index = siblings.indexOf(element) + 1;
    
    if (index === 0) return selectors;
    
    const parentSelector = this.getParentSelector(parent);
    
    selectors.push({
      selector: `${parentSelector} > ${tag}:nth-child(${index})`,
      strategy: 'nth-child'
    });
    
    return selectors;
  }

  // Strategy 10: nth-of-type positional selector (tier 10, last resort)
  // Contract: Uses parent selector + nth-of-type index; finds index among same-tag siblings
  static strategy10NthType(element, tag) {
    const parent = element.parentElement;
    
    if (!parent) {
      return [{
        selector: tag,
        strategy: 'tag-only',
        tier: 10
      }];
    }
    
    const siblings = Array.from(parent.children)
      .filter(e => e.tagName === element.tagName);
    const index = siblings.indexOf(element) + 1;
    
    const parentSelector = this.getParentSelector(parent);
    
    return [{
      selector: `${parentSelector} > ${tag}:nth-of-type(${index})`,
      strategy: 'nth-of-type',
      tier: 10
    }];
  }

  // Validates selector uniqueness via context-aware querySelector
  // Contract: Returns true only if selector matches exactly 1 element and it's the target; handles shadowRoot context
  static isUnique(selector, element) {
    try {
      if (!isValidCssSyntax(selector)) {
        return false;
      }
      
      const root = element.getRootNode();
      
      if (root instanceof ShadowRoot) {
        const results = root.querySelectorAll(selector);
        if (results.length !== 1) return false;
        return results[0] === element;
      }
      
      const count = countCssMatches(selector);
      if (count !== 1) return false;
      
      const result = document.querySelector(selector);
      return result === element;
    } catch (e) {
      if (DEBUG) console.error(`[CSSEngine] Error validating selector "${selector}":`, e);
      return false;
    }
  }

  // Finds first stable parent within 5 levels (ID, data attr, or semantic tag)
  // Contract: Returns parent element or null; prioritizes ID > data attr > semantic tag
  static findStableParent(element) {
    const parents = walkUpTree(element, 5);
    
    for (const parent of parents) {
      if (parent.id && this.isStableId(parent.id)) return parent;
      
      const dataAttr = this.getFirstDataAttr(parent);
      if (dataAttr) return parent;
      
      const semantic = ['form', 'nav', 'header', 'footer', 'main', 'section', 'article'];
      if (semantic.includes(parent.tagName.toLowerCase())) {
        return parent;
      }
    }
    
    return parents[0] || null;
  }

  // Builds selector for parent element using best available identifier
  // Contract: Prioritizes ID > data attr > first class; returns tag as fallback
  static getParentSelector(parent) {
    if (!parent) return 'body';
    
    const tag = parent.tagName.toLowerCase();
    
    if (parent.id && this.isStableId(parent.id)) {
      return `#${escapeCss(parent.id)}`;
    }
    
    const dataAttr = this.getFirstDataAttr(parent);
    if (dataAttr) {
      return `${tag}[${dataAttr.name}="${escapeCss(dataAttr.value)}"]`;
    }
    
    const classes = this.getMeaningfulClasses(parent);
    if (classes.length > 0) {
      return `${tag}.${escapeCss(classes[0])}`;
    }
    
    return tag;
  }

  // Builds selector for child element using best available identifier
  // Contract: Prioritizes data attr > type > first class; returns tag as fallback
  static getChildSelector(element) {
    const tag = element.tagName.toLowerCase();
    
    const dataAttr = this.getFirstDataAttr(element);
    if (dataAttr) {
      return `${tag}[${dataAttr.name}="${escapeCss(dataAttr.value)}"]`;
    }
    
    if (element.type) {
      return `${tag}[type="${escapeCss(element.type)}"]`;
    }
    
    const classes = this.getMeaningfulClasses(element);
    if (classes.length > 0) {
      return `${tag}.${escapeCss(classes[0])}`;
    }
    
    return tag;
  }

  // Finds first data-* attribute on element
  // Contract: Returns {name, value} object or null
  static getFirstDataAttr(element) {
    const attrs = Array.from(element.attributes);
    const dataAttr = attrs.find(a => a.name.startsWith('data-') && a.value);
    return dataAttr || null;
  }

  // Filters element classes to remove generated/utility classes
  // Contract: Returns classes >3 chars, not auto-generated, not state classes (active/hover/etc)
  static getMeaningfulClasses(element) {
    if (!element.className || typeof element.className !== 'string') {
      return [];
    }
    
    return element.className
      .trim()
      .split(/\s+/)
      .filter(c => c.length > 3)
      .filter(c => !c.match(/^[a-z]\d+$/))
      .filter(c => !['active', 'selected', 'hover', 'focus'].includes(c));
  }

  // Checks if ID is stable (not numeric-only or auto-generated)
  // Contract: Returns false for pure numeric, long numeric substrings, short IDs
  static isStableId(id) {
    if (!id || id.length < 3) return false;
    if (/^\d+$/.test(id)) return false;
    if (/[0-9]{6,}/.test(id)) return false;
    return true;
  }

  // Builds result object with execution time
  // Contract: Adds executionTime; preserves shadow DOM metadata if present
  static buildResult(strategyResult, startTime) {
    const executionTime = Math.round(performance.now() - startTime);
    return {
      selector: strategyResult.selector,
      tier: strategyResult.tier,
      strategy: strategyResult.strategy,
      executionTime: executionTime,
      ...(strategyResult.shadowDOM && {
        shadowDOM: strategyResult.shadowDOM,
        shadowDepth: strategyResult.shadowDepth,
        shadowHosts: strategyResult.shadowHosts,
        internalSelector: strategyResult.internalSelector
      })
    };
  }

  // Returns empty result structure
  // Contract: Consistent empty result shape for error cases
  static emptyResult() {
    return {
      selector: null,
      tier: 0,
      strategy: 'none',
      executionTime: 0
    };
  }
}

export default CSSEngine;