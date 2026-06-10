// ==========================================================================
// XPath Engine: Strategy Tournament with Early-Exit Optimization
// Phase 2 Enhancement: Sequential tournament with 60-80% CPU reduction via early termination
// Integrates heuristics engine for adaptive timeout computation
// Dependencies: XPathStrategies, XPathShadowHandler, ShadowDOMTraverser, heuristicsEngine
// ==========================================================================

import AttributeProfiler from '../shared/attribute-profiler.js';
import { isDebugEnabled } from '../shared/config.js';
import heuristicsEngine from '../shared/heuristics-engine.js';
import { getDataAttributes } from '../helpers/dom-utils.js';
import ShadowDOMTraverser from '../helpers/shadow-dom-traverser.js';
import { cleanText } from '../helpers/text-utils.js';
import { countXPathMatches, escapeXPath, getEvaluationContext, xpathPointsToElement } from '../helpers/xpath-utils.js';
import XPathShadowHandler from './xpath-shadow-handler.js';
import XPathStrategies from './xpath-strategies.js';
const MODULE_DEBUG = true;
const DEBUG = isDebugEnabled(MODULE_DEBUG);

// Engine class encapsulating XPath generation strategies and helpers
// Uses a tournament of strategies with early-exit optimizations
class XPathEngine {
  // Pre-computed attribute priority cache for domain to accelerate XPath strategy selection
  // TTL ensures attributes stay fresh as DOM patterns evolve
  static profileCache = new Map();
  static CACHE_TTL = 60000;

  // Loads and caches attribute profile for a domain from the attribute profiler
  // Profiles are used to prioritize high-value attributes when building XPaths
  static async warmCache(domain) {
    if(!domain) {
      domain = this.getDomainFromUrl(window.location.href);
    }

    if(DEBUG) console.log(`[XPathEngine] Warming cache for ${domain}`);

    const attributes = await AttributeProfiler.getMergedAttributes(domain);

    this.profileCache.set(domain, {
      attributes,
      timestamp: Date.now()
    })

    if (DEBUG) {
      console.log(`[XPathEngine] Cache warmed:`, {
        domain,
        attributeCount: attributes.length,
        attributes
      });
    }
  }

  // Returns cached attributes for domain with automatic refresh on TTL expiry
  // Falls back to loading profile if cache miss or expired
  static async getPriorityAttributes(domain) {
    if(!domain) {
      domain = this.getDomainFromUrl(window.location.href);
    }

    const cached = this.profileCache.get(domain);

    if(cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.attributes;
    }

    if (DEBUG) console.log(`[XPathEngine] Cache miss for ${domain}, loading profile`);

    const attributes = await AttributeProfiler.getMergedAttributes(domain);

    this.profileCache.set(domain, {
      attributes,
      timestamp: Date.now()
    })

    return attributes;
  }

  // Safely extracts hostname from URL with fallback for malformed URLs
  static getDomainFromUrl(url) {
    try {
      if (!url || url === 'about:blank' || url === 'about:srcdoc') {
        return 'about:blank';
      }
      
      const parsed = new URL(url);
      
      if (!parsed.hostname || parsed.hostname === '') {
        return parsed.protocol.replace(':', '') || 'unknown';
      }
      
      return parsed.hostname;
    } catch (error) {
      console.warn('[XPathEngine] Failed to parse URL:', url, error);
      return 'unknown';
    }
  }


  // Clears profile cache for domain or entire cache if domain omitted
  // Useful after navigation or when profiler data updates
  static invalidateCache(domain) {
    if(domain) {
      this.profileCache.delete(domain);
      if (DEBUG) console.log(`[XPathEngine] Cache invalidated for ${domain}`);
    } else {
      this.profileCache.clear();
      if (DEBUG) console.log(`[XPathEngine] Cache cleared`);
    }
  }

  static SEMANTIC_TAGS = [
    'form', 'nav', 'header', 'footer', 'main', 'section', 'article', 
    'aside', 'dialog', 'table', 'fieldset', 'figure'
  ];

  // Generates primary+fallback XPath selectors for an element
  // Routes Shadow DOM elements to a CSS-based shadow handler
  static async generate(element) {
    if (!element || !element.tagName) {
      return this.emptyResult();
    }

    const startTime = performance.now();
    const shadowPath = ShadowDOMTraverser.getShadowPath(element);

    if (shadowPath.inShadowDOM) {
      const framework = this.detectFramework();
      
      if (DEBUG) {
        console.log('[XPathEngine] Shadow DOM detected, routing to CSS-based handler');
      }
      
      const hostElement = shadowPath.hosts[0].host;
      const hostTag = this.getUniversalTag(hostElement);
      const strategies = this.buildAllStrategies(hostElement, hostTag, framework);
      
      const targetTag = this.getUniversalTag(element);
      return XPathShadowHandler.generateShadowDOMPath(
        element, 
        shadowPath, 
        strategies, 
        targetTag, 
        framework
      );
    }

    return this.generateRegularDOMPath(element, startTime);
  }

  // Executes strategy tournament with early-exit and adaptive timeout
  // Collects valid candidates, validates them, and selects diverse fallbacks
  static async generateRegularDOMPath(element, startTime) {
    const tag = this.getUniversalTag(element);
    const framework = this.detectFramework();
    const context = getEvaluationContext(element);

    const allStrategies = this.buildAllStrategies(element, tag, framework);
    const validCandidates = [];
    
    const adaptiveTimeout = heuristicsEngine.computeEnrichmentTimeout({
      shadowRootCount: 0
    });
    
    // Exit tournament early if sufficient robust candidates found
    const earlyExitThreshold = 3;

    for (const { name, tier, fn } of allStrategies) {
      if (performance.now() - startTime > adaptiveTimeout) {
        if (DEBUG) {
          console.log(`[XPathEngine] Early exit at ${name} (timeout: ${adaptiveTimeout}ms)`);
        }
        break;
      }

      if (validCandidates.length >= earlyExitThreshold) {
        if (DEBUG) {
          console.log(`[XPathEngine] Early exit at ${name} (${earlyExitThreshold} valid candidates)`);
        }
        break;
      }

      try {
        const candidates = await Promise.resolve(fn());
        if (!candidates || candidates.length === 0) continue;

        for (const candidate of candidates) {
          if (!candidate?.xpath) continue;

          const validation = this.strictValidate(candidate.xpath, element, context);
          if (!validation.isValid || !validation.pointsToTarget) continue;

          const uniqueXPath = validation.isUnique
            ? candidate.xpath
              : await this.ensureUniqueness(candidate.xpath, element, context);

          const finalValidation = this.strictValidate(uniqueXPath, element, context);
          if (!finalValidation.isUnique || !finalValidation.pointsToTarget) continue;

          const robustness = this.calculateRobustness(uniqueXPath, tier);

          validCandidates.push({
            xpath: uniqueXPath,
            tier: tier,
            strategy: candidate.strategy || name,
            robustness: robustness
          });

          if (validCandidates.length >= earlyExitThreshold) break;
        }
      } catch (error) {
        if (DEBUG) console.warn(`[XPathEngine] Strategy ${name} failed:`, error);
      }
    }

    if (validCandidates.length === 0) {
      const fallbackResults = await this.executeFallbackStrategies(
        element, 
        tag, 
        framework, 
        context, 
        startTime, 
        adaptiveTimeout
      );
      validCandidates.push(...fallbackResults);
    }

    const sorted = validCandidates.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      return b.robustness - a.robustness;
    });

    const diverse = this.selectDiverseFallbacks(sorted, 3);
    
    return {
      primary: diverse[0]?.xpath || null,
      fallback1: diverse[1]?.xpath || null,
      fallback2: diverse[2]?.xpath || null,
      tier: diverse[0]?.tier || 99,
      strategy: diverse[0]?.strategy || 'none',
      robustness: diverse[0]?.robustness || 0,
      framework: framework,
      candidateCount: validCandidates.length,
      shadowDOM: false,
      shadowDepth: 0,
      shadowFramework: 'none',
      executionTime: Math.round(performance.now() - startTime)
    };
  }

  // Runs lower-priority fallback strategies when primary tournament yields no results
  // Includes table context, SVG fingerprinting, spatial text heuristics, and guaranteed path
  static async executeFallbackStrategies(element, tag, framework, context, startTime, timeout) {
    const remainingTime = timeout - (performance.now() - startTime);
    if (remainingTime < 20) return [];

    const fallbackStrategies = [
      { name: 'tableRowContext', tier: 19, fn: () => XPathStrategies.strategyTableRowContext(element, tag, this.collectStableAttributes.bind(this), this.getUniversalTag.bind(this), this.extractTagFromUniversal.bind(this)) },
      { name: 'svgVisualFingerprint', tier: 20, fn: () => XPathStrategies.strategySVGVisualFingerprint(element, tag, this.getBestAttribute.bind(this), this.getUniversalTag.bind(this)) },
      { name: 'spatialTextContext', tier: 21, fn: () => XPathStrategies.strategySpatialTextContext(element, tag, this.getUniversalTag.bind(this), this.findNearbyTextElements.bind(this)) },
      { name: 'guaranteedPath', tier: 22, fn: () => XPathStrategies.strategyGuaranteedPath(element, tag, this.getBestAttribute.bind(this), this.getUniversalTag.bind(this), this.strictValidate.bind(this)) }
    ];

    const strategyResults = await Promise.all(
      fallbackStrategies.map(async ({ name, tier, fn }) => {
        try {
          const candidates = await Promise.resolve(fn());
          return (candidates || []).map(c => ({ ...c, tier, strategyName: name }));
        } catch (error) {
          if (DEBUG) console.warn(`[XPathEngine] Fallback strategy ${name} failed:`, error);
          return [];
        }
      })
    );

    const results = strategyResults.flat();
    
    const validCandidates = [];
    for (const candidate of results) {
      if (!candidate?.xpath) continue;

      const validation = this.strictValidate(candidate.xpath, element, context);
      if (!validation.isValid || !validation.pointsToTarget) continue;

      const uniqueXPath = validation.isUnique
        ? candidate.xpath
        : await this.ensureUniqueness(candidate.xpath, element, context);

      const finalValidation = this.strictValidate(uniqueXPath, element, context);
      if (!finalValidation.isUnique || !finalValidation.pointsToTarget) continue;

      validCandidates.push({
        xpath: uniqueXPath,
        tier: candidate.tier,
        strategy: candidate.strategy || candidate.strategyName,
        robustness: candidate.robustness || this.calculateRobustness(uniqueXPath, candidate.tier)
      });
    }

    return validCandidates;
  }

  // Assembles all XPath generation strategies in priority order (tiered)
  // Each strategy entry provides a lazy evaluator function to be executed by the tournament
  static buildAllStrategies(element, tag, framework) {
    return [
      { name: 'exactVisibleText', tier: 0, fn: () => XPathStrategies.strategyExactVisibleText(element, tag) },
      { name: 'testAttributes', tier: 1, fn: () => XPathStrategies.strategyTestAttributes(element, tag) },
      { name: 'stableId', tier: 2, fn: () => XPathStrategies.strategyStableId(element, tag) },
      { name: 'visibleTextNormalized', tier: 3, fn: () => XPathStrategies.strategyVisibleTextNormalized(element, tag) },
      { name: 'precedingContext', tier: 4, fn: () => XPathStrategies.strategyPrecedingContext(element, tag, this.getBestAttribute.bind(this), this.collectStableAttributes.bind(this), this.getUniversalTag.bind(this)) },
      { name: 'descendantContext', tier: 5, fn: () => XPathStrategies.strategyDescendantContext(element, tag, this.getBestAttribute.bind(this), this.collectStableAttributes.bind(this), this.getUniversalTag.bind(this)) },
      { name: 'attrTextCombo', tier: 6, fn: () => XPathStrategies.strategyAttrTextCombo(element, tag, this.collectStableAttributes.bind(this)) },
      { name: 'followingContext', tier: 7, fn: () => XPathStrategies.strategyFollowingContext(element, tag, this.getBestAttribute.bind(this), this.collectStableAttributes.bind(this), this.getUniversalTag.bind(this)) },
      { name: 'frameworkAttrs', tier: 8, fn: () => XPathStrategies.strategyFrameworkAttributes(element, tag, framework) },
      { name: 'multiAttrFingerprint', tier: 9, fn: () => XPathStrategies.strategyMultiAttributeFingerprint(element, tag, this.collectStableAttributes.bind(this)) },
      { name: 'ariaRoleLabel', tier: 10, fn: () => XPathStrategies.strategyAriaRoleLabel(element, tag) },
      { name: 'labelAssociation', tier: 11, fn: () => XPathStrategies.strategyLabelAssociation(element, tag, this.extractTagFromUniversal.bind(this)) },
      { name: 'partialTextMatch', tier: 12, fn: () => XPathStrategies.strategyPartialTextMatch(element, tag) },
      { name: 'hrefPattern', tier: 13, fn: () => XPathStrategies.strategyHrefPattern(element, tag) },
      { name: 'parentChildAxes', tier: 14, fn: () => XPathStrategies.strategyParentChildAxes(element, tag, this.getBestAttribute.bind(this), this.collectStableAttributes.bind(this), this.getUniversalTag.bind(this)) },
      { name: 'siblingAxes', tier: 15, fn: () => XPathStrategies.strategySiblingAxes(element, tag, this.getBestAttribute.bind(this), this.collectStableAttributes.bind(this), this.getUniversalTag.bind(this)) },
      { name: 'semanticAncestor', tier: 16, fn: () => XPathStrategies.strategySemanticAncestor(element, tag, this.getBestAttribute.bind(this), this.collectStableAttributes.bind(this), this.getUniversalTag.bind(this), this.findBestSemanticAncestor.bind(this)) },
      { name: 'classAttrCombo', tier: 17, fn: () => XPathStrategies.strategyClassAttributeCombo(element, tag, this.collectStableAttributes.bind(this)) },
      { name: 'ancestorChain', tier: 18, fn: () => XPathStrategies.strategyAncestorChain(element, tag, this.collectStableAttributes.bind(this), this.getStableAncestorChain.bind(this), this.getUniversalTag.bind(this)) }
    ];
  }

  // Fast context-focused XPath generation (limited strategy set and tight timeout)
  // Optimized for label/parent-context lookups and short-circuit returns
  static async generateForContext(element) {
    if (!element || !element.tagName) {
      return null;
    }

    const startTime = performance.now();
    const tag = this.getUniversalTag(element);
    const framework = this.detectFramework();
    const context = getEvaluationContext(element);

    const contextStrategies = this.buildAllStrategies(element, tag, framework).slice(0, 16);
    const validCandidates = [];
    
    const contextTimeout = 30;

    for (const { name, tier, fn } of contextStrategies) {
      if (performance.now() - startTime > contextTimeout) break;
      if (validCandidates.length >= 1) break;

      try {
        const candidates = await Promise.resolve(fn());
        if (!candidates || candidates.length === 0) continue;

        for (const candidate of candidates) {
          if (!candidate?.xpath) continue;

          const validation = this.strictValidate(candidate.xpath, element, context);
          if (!validation.isValid || !validation.pointsToTarget) continue;

          const uniqueXPath = validation.isUnique
            ? candidate.xpath
            : await this.ensureUniqueness(candidate.xpath, element, context);

          const finalValidation = this.strictValidate(uniqueXPath, element, context);
          if (!finalValidation.isUnique || !finalValidation.pointsToTarget) continue;

          validCandidates.push({
            xpath: uniqueXPath,
            tier: tier,
            strategy: name,
            robustness: this.calculateRobustness(uniqueXPath, tier)
          });

          break;
        }
      } catch (error) {
        continue;
      }
    }

    if (validCandidates.length === 0) {
      return null;
    }

    const best = validCandidates[0];

    return {
      xpath: best.xpath,
      tier: best.tier,
      strategy: best.strategy,
      robustness: best.robustness,
      candidateCount: validCandidates.length,
      executionTime: Math.round(performance.now() - startTime)
    };
  }

  // Returns a standardized empty result when generation fails
  static emptyResult() {
    return {
      primary: null,
      fallback1: null,
      fallback2: null,
      tier: 99,
      strategy: 'none',
      robustness: 0,
      framework: 'unknown',
      candidateCount: 0,
      shadowDOM: false,
      shadowDepth: 0,
      shadowFramework: 'none',
      executionTime: 0
    };
  }

  // Finds nearby textual elements for context-based strategies
  // Computes Euclidean distance from element center to candidate text node centers
  static findNearbyTextElements(element, maxDistance = 200) {
    const rect = element.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    
    const textElements = [];
    const candidates = document.querySelectorAll('label, span, div, p, h1, h2, h3, h4, h5, h6, legend, button, a, td, th');
    
    for (const el of candidates) {
      if (el === element || el.contains(element) || element.contains(el)) continue;
      
      const text = cleanText(el.textContent);
      if (!text || text.length === 0 || text.length > 100) continue;
      
      const elRect = el.getBoundingClientRect();
      const elCenterX = elRect.left + elRect.width / 2;
      const elCenterY = elRect.top + elRect.height / 2;
      
      const distance = Math.sqrt(
        Math.pow(elCenterX - centerX, 2) + Math.pow(elCenterY - centerY, 2)
      );
      
      if (distance <= maxDistance) {
        const direction = (elCenterX < centerX || elCenterY < centerY) ? 'before' : 'after';
        textElements.push({ element: el, text, distance, direction });
      }
    }
    
    return textElements.sort((a, b) => a.distance - b.distance);
  }

  // Extracts simple tag name from universal tag representation
  // Handles selectors using local-name() for namespaces like SVG
  static extractTagFromUniversal(tag) {
    return tag.toLowerCase().replace(/\*\s*\[local-name\(\)\s*=\s*'([^']+)'\]/, '$1');
  }

  // Attempts to make an ambiguous XPath unique by applying contextual wraps
  // Strategies: ancestor context, parent wrapping, sibling context, full-attribute path
  static async ensureUniqueness(xpath, element, context) {
    const matches = countXPathMatches(xpath, context);

    if (matches === 1) return xpath;
    if (matches === 0) return xpath;

    const ancestorXPath = await this.wrapWithAncestorContext(xpath, element, context);
    if (ancestorXPath && countXPathMatches(ancestorXPath, context) === 1 && xpathPointsToElement(ancestorXPath, element, context)) {
      return ancestorXPath;
    }

    const parentXPath = await this.wrapWithUniqueParent(xpath, element, context);
    if (parentXPath && countXPathMatches(parentXPath, context) === 1 && xpathPointsToElement(parentXPath, element, context)) {
      return parentXPath;
    }

    const siblingXPath = await this.buildPrecedingSiblingPath(xpath, element, context);
    if (siblingXPath && countXPathMatches(siblingXPath, context) === 1 && xpathPointsToElement(siblingXPath, element, context)) {
      return siblingXPath;
    }

    const fullAttrPath = await this.buildFullAttributePath(element, context);
    if (fullAttrPath && countXPathMatches(fullAttrPath, context) === 1 && xpathPointsToElement(fullAttrPath, element, context)) {
      return fullAttrPath;
    }

    return xpath;
  }

  // Wraps XPath with ancestor predicate using stable ancestor attributes
  // Prioritizes ancestors that have stable attributes (data-testid, id, etc.)
  static async wrapWithAncestorContext(xpath, element, context) {
    const ancestors = await this.getStableAncestorChain(element, 4);

    for (const ancestor of ancestors) {
      const ancestorTag = this.getUniversalTag(ancestor.element);
      const lastSegment = xpath.substring(xpath.lastIndexOf('//'));
      const wrappedXPath = `//${ancestorTag}[@${ancestor.attr.name}=${escapeXPath(ancestor.attr.value)}]${lastSegment}`;

      if (countXPathMatches(wrappedXPath, context) === 1 && xpathPointsToElement(wrappedXPath, element, context)) {
        return wrappedXPath;
      }
    }
    return null;
  }

  // Attempts to disambiguate using a unique parent predicate
  // Walks up parent chain searching for a stable attribute to anchor the XPath
  static async wrapWithUniqueParent(xpath, element, context) {
    let parent = element.parentElement;
    let depth = 0;

    while (parent && depth < 4) {
      const parentAttr = await this.getBestAttribute(parent);

      if (parentAttr) {
        const parentTag = this.getUniversalTag(parent);
        const lastSegment = xpath.substring(xpath.lastIndexOf('//'));
        const wrappedXPath = `//${parentTag}[@${parentAttr.name}=${escapeXPath(parentAttr.value)}]${lastSegment}`;

        if (countXPathMatches(wrappedXPath, context) === 1 && xpathPointsToElement(wrappedXPath, element, context)) {
          return wrappedXPath;
        }
      }

      parent = parent.parentElement;
      depth++;
    }
    return null;
  }

  // Uses preceding sibling with a stable attribute to build a following-sibling path
  // Useful when sibling elements provide unique anchors
  static async buildPrecedingSiblingPath(xpath, element, context) {
    let sibling = element.previousElementSibling;
    let depth = 0;

    while (sibling && depth < 3) {
      const siblingAttr = await this.getBestAttribute(sibling);

      if (siblingAttr) {
        const siblingTag = this.getUniversalTag(sibling);
        const elementTag = this.getUniversalTag(element);
        const elementAttrs = await this.collectStableAttributes(element);

        if (elementAttrs.length > 0) {
          const siblingXPath = `//${siblingTag}[@${siblingAttr.name}=${escapeXPath(siblingAttr.value)}]/following-sibling::${elementTag}[@${elementAttrs[0].name}=${escapeXPath(elementAttrs[0].value)}]`;

          if (countXPathMatches(siblingXPath, context) === 1 && xpathPointsToElement(siblingXPath, element, context)) {
            return siblingXPath;
          }
        }
      }

      sibling = sibling.previousElementSibling;
      depth++;
    }
    return null;
  }

  // Constructs a full attribute-based path by accumulating stable attributes up the tree
  // Considered a last-resort unique path generator
  static async buildFullAttributePath(element, context) {
    const segments = [];
    let current = element;
    let depth = 0;

    while (current && current !== document.body && depth < 10) {
      const tag = this.getUniversalTag(current);
      const attrs = await this.collectStableAttributes(current);

      if (attrs.length > 0) {
        const conditions = attrs.slice(0, 2).map(a => `@${a.name}=${escapeXPath(a.value)}`).join(' and ');
        segments.unshift(`${tag}[${conditions}]`);
      } else {
        segments.unshift(tag);
      }

      const testXpath = '//' + segments.join('/');
      if (countXPathMatches(testXpath, context) === 1 && xpathPointsToElement(testXpath, element, context)) {
        return testXpath;
      }

      current = current.parentElement;
      depth++;
    }
    return null;
  }

  // Selects a diverse set of XPath fallbacks avoiding duplicate XPath values
  // Ensures the chosen fallbacks provide alternative resilient selectors
  static selectDiverseFallbacks(candidates, maxCount) {
    if (candidates.length <= maxCount) return candidates;

    const diverse = [];
    const usedXPaths = new Set();

    if (candidates.length > 0) {
      diverse.push(candidates[0]);
      usedXPaths.add(candidates[0].xpath);
    }

    for (const candidate of candidates.slice(1)) {
      if (diverse.length >= maxCount) break;
      if (usedXPaths.has(candidate.xpath)) continue;

      diverse.push(candidate);
      usedXPaths.add(candidate.xpath);
    }

    return diverse;
  }

  // Strictly validates XPath: existence, uniqueness and whether it points to target
  // Returns flags for validation, uniqueness, and match count
  static strictValidate(xpath, targetElement, context = null) {
    const evalContext = context || getEvaluationContext(targetElement);
    
    try {
      const matchCount = countXPathMatches(xpath, evalContext);
      
      if (matchCount === 0) {
        return { isValid: false, isUnique: false, pointsToTarget: false, matchCount: 0 };
      }
      
      if (matchCount > 1) {
        return { isValid: true, isUnique: false, pointsToTarget: false, matchCount };
      }
      
      const pointsCorrectly = xpathPointsToElement(xpath, targetElement, evalContext);
      
      return {
        isValid: true,
        isUnique: true,
        pointsToTarget: pointsCorrectly,
        matchCount: 1
      };
      
    } catch (error) {
      return { isValid: false, isUnique: false, pointsToTarget: false, matchCount: -1 };
    }
  }

  // Produces a universal tag string suitable for XPath (handles namespaces)
  // e.g., `*[local-name()='svg']` for SVG elements
  static getUniversalTag(element) {
    const ns = element.namespaceURI;
    
    if (ns === 'http://www.w3.org/2000/svg' || ns === 'http://www.w3.org/1998/Math/MathML') {
      return `*[local-name()='${element.localName}']`;
    }
    
    return element.tagName.toLowerCase();
  }

  // Heuristic detection of common frontend frameworks based on HTML markers
  // Used to prioritize framework-specific attributes in strategies
  static detectFramework() {
    const html = document.documentElement.outerHTML.substring(0, 3000);
    
    if (html.includes('lightning-') || html.includes('data-aura')) return 'salesforce';
    if (html.includes('data-reactid') || html.includes('__react')) return 'react';
    if (html.includes('ng-') || html.includes('_ngcontent')) return 'angular';
    if (html.includes('data-v-') || html.includes('__vue')) return 'vue';
    
    return 'generic';
  }

  // Gathers prioritized stable attributes from profiler and fallbacks
  // Includes supplementary attributes and data-* attributes as last-resort
  static async collectStableAttributes(element) {
    const domain = this.getDomainFromUrl(window.location.href);

    const priorityAttrs = await this.getPriorityAttributes(domain);

    const attrs = [];

    for (const attr of priorityAttrs) {
      const value = element.getAttribute(attr);
      if(value && XPathStrategies.isStableValue(value)) {
        attrs.push({ name: attr, value });
      }
    }

    const supplementary = ['role', 'type', 'href', 'for', 'value', 'placeholder', 'class'];
    for (const attr of supplementary) {
      const value = element.getAttribute(attr);
      if (value && XPathStrategies.isStableValue(value) && !attrs.find(a => a.name === attr)) {
        attrs.push({ name: attr, value });
      }
    }
    
    const dataAttrs = getDataAttributes(element);
    for (const [name, value] of Object.entries(dataAttrs)) {
      if (XPathStrategies.isStableValue(value) && !attrs.find(a => a.name === name)) {
        attrs.push({ name, value });
      }
    }
    
    return attrs;
  }

  // Returns the highest-priority stable attribute for an element
  // Used to anchor ancestor/sibling based XPath generation
  static async getBestAttribute(element) {
    const attrs = await this.collectStableAttributes(element);
    return attrs.length > 0 ? attrs[0] : null;
  }

  // Collects ancestor elements up to maxDepth that have stable attributes
  // Used to wrap XPaths with stable ancestor context
  static async getStableAncestorChain(element, maxDepth) {
    const ancestors = [];
    let current = element.parentElement;
    let depth = 0;
    
    while (current && depth < maxDepth) {
      const attr = await this.getBestAttribute(current);
      if (attr) {
        ancestors.push({ element: current, attr, depth });
      }
      current = current.parentElement;
      depth++;
    }
    
    return ancestors;
  }

  // Finds the nearest semantic ancestor (form, nav, main, etc.) for contextual strategies
  static async findBestSemanticAncestor(element) {
    let current = element.parentElement;
    let depth = 0;

    while (current && depth < 8) {
      const tag = current.tagName.toLowerCase();

      if (this.SEMANTIC_TAGS.includes(tag)) {
        const attr = await this.getBestAttribute(current);
        if (attr) return current;
      }

      current = current.parentElement;
      depth++;
    }

    return null;
  }

  // Scores XPath robustness based on attribute presence and structural complexity
  // Higher score indicates a more resilient selector against DOM changes
  static calculateRobustness(xpath, tier) {
    let score = 100 - (tier * 4);

    if (xpath.includes("[@aria-controls='")) score += 20;
    if (xpath.includes('[@data-key=')) score += 18;
    if (xpath.includes('[@data-record-id=')) score += 17;
    if (xpath.includes('[@data-component-id=')) score += 16;
    if (xpath.includes('[@data-row-key-value=')) score += 15;
    if (xpath.includes('[@data-testid=') || xpath.includes('[@data-test=')) score += 20;
    if (xpath.includes('[@id=')) score += 15;

    if (xpath.includes('[text()=')) score += 10;
    if (xpath.includes('[normalize-space()=')) score += 9;

    if (xpath.includes('[@role=')) score += 6;
    if (xpath.includes('[@aria-label=')) score += 6;

    if (xpath.includes('[contains(@class')) score -= 8;
    if (xpath.includes('/following::') || xpath.includes('/preceding::')) score -= 10;

    const segments = xpath.split('//').length;
    if (segments > 3) score -= (segments - 3) * 5;

    return Math.max(30, Math.min(100, score));
  }

  // Builds a position-based unique XPath when attributes are not available
  // Falls back to indexed path segments (e.g., /div[3]/button[1])
  static getUniqueXPath(element) {
    if (element.id) {
      return `//*[@id='${element.id}']`;
    }
    const parts = [];
    while (element && element.nodeType === Node.ELEMENT_NODE) {
      let part = element.tagName.toLowerCase();
      if (element.id) {
        part += `[@id='${element.id}']`;
        parts.unshift(part);
        break; 
      }
      const siblings = Array.from(element.parentNode.children);
      const sameTagSiblings = siblings.filter(sibling => sibling.tagName === element.tagName);
      if (sameTagSiblings.length > 1) {
        const index = sameTagSiblings.indexOf(element) + 1;
        part += `[${index}]`;
      }
      parts.unshift(part);
      element = element.parentNode;
    }
    return parts.length ? '/' + parts.join('/') : null;
  }
}

export default XPathEngine;