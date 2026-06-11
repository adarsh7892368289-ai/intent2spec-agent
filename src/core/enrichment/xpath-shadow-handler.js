// ======================================================================
// XPath Shadow Handler: Shadow DOM Path Generation via CSS Bridge
// Generates shadow DOM paths using CSS-based executable approach.
// Handles single-level and nested shadow DOM with host validation.
// Dependencies: ShadowDOMTraverser, CSSShadowStrategies, xpath-utils
// ======================================================================

import { isDebugEnabled } from '../shared/config.js';
import CSSShadowStrategies from './css-shadow-strategies.js';

const MODULE_DEBUG = false;
const DEBUG = isDebugEnabled(MODULE_DEBUG);

class XPathShadowHandler {
  
  // Generates shadow DOM path using CSS-based executable approach, routing to single/nested handlers
  // Contract: Returns composite locator object with toString() and executable functions; robustness based on host XPath tier
  static async generateShadowDOMPath(element, shadowPath, xpathStrategies, tag, framework) {
    const startTime = performance.now();
    
    if (!shadowPath || !shadowPath.inShadowDOM || shadowPath.hosts.length === 0) {
      return this.emptyResult();
    }
    
    if (shadowPath.depth > 1) {
      return this.generateNestedShadowPath(element, shadowPath, xpathStrategies, framework, startTime);
    }
    
    return this.generateSingleLevelShadowPath(element, shadowPath, xpathStrategies, framework, startTime);
  }
  
  // Handles single-level shadow DOM by generating XPaths for host and CSS selector for internal element
  // Contract: Validates host XPaths in document context; combines top 3 host XPaths with best CSS selector
  static async generateSingleLevelShadowPath(element, shadowPath, xpathStrategies, framework, startTime) {
    const hostElement = shadowPath.hosts[0].host;
    
    const hostCandidates = await this.runHostStrategies(
      xpathStrategies,
      hostElement,
      document
    );
    
    const shadowRoot = element.getRootNode();
    if (!(shadowRoot instanceof ShadowRoot)) {
      if (DEBUG) console.warn('[XPathShadowHandler] Cannot access shadow root');
      return this.emptyResult();
    }
    
    const internalResult = CSSShadowStrategies.getBest(element, shadowRoot);
    
    if (!internalResult) {
      return this.emptyResult();
    }
    
    const top3 = hostCandidates.slice(0, 3);
    
    const primary = this.buildShadowComposite(
      top3[0],
      internalResult,
      shadowPath,
      false
    );
    
    const fallback1 = top3[1] ? this.buildShadowComposite(
      top3[1],
      internalResult,
      shadowPath,
      false
    ) : null;
    
    const fallback2 = top3[2] ? this.buildShadowComposite(
      top3[2],
      internalResult,
      shadowPath,
      false
    ) : null;
    
    return {
      primary: primary,
      fallback1: fallback1,
      fallback2: fallback2,
      tier: primary.tier,
      strategy: `shadow-${internalResult.strategy}`,
      robustness: primary.robustness,
      framework: framework,
      shadowDOM: true,
      shadowDepth: shadowPath.depth,
      shadowFramework: shadowPath.framework,
      candidateCount: hostCandidates.length,
      executionTime: Math.round(performance.now() - startTime)
    };
  }
  
  // Handles nested shadow DOM by building host chain (only first host validated via XPath)
  // Contract: Creates shadow-composite-nested objects with hostChain array; only validates first host in document
  static async generateNestedShadowPath(element, shadowPath, xpathStrategies, framework, startTime) {
    const firstHost = shadowPath.hosts[0].host;
    
    const firstHostCandidates = await this.runHostStrategies(
      xpathStrategies,
      firstHost,
      document
    );
    
    const shadowRoot = element.getRootNode();
    if (!(shadowRoot instanceof ShadowRoot)) {
      if (DEBUG) console.warn('[XPathShadowHandler] Cannot access shadow root for nested element');
      return this.emptyResult();
    }
    
    const internalResult = CSSShadowStrategies.getBest(element, shadowRoot);
    
    if (!internalResult) {
      return this.emptyResult();
    }
    
    const top3 = firstHostCandidates.slice(0, 3);
    
    const buildCompositeWithHost = (hostCandidate) => {
      const hostChain = shadowPath.hosts.map(h => h.hostTag);
      hostChain[0] = hostCandidate.xpath;
      
      return {
        type: 'shadow-composite-nested',
        hostChain: hostChain,
        internal: internalResult.selector,
        shadowDepth: shadowPath.depth,
        framework: shadowPath.framework,
        tier: internalResult.tier || 6,
        robustness: hostCandidate.robustness || 70,
        
        toString: function() {
          return this.hostChain.join(' >> ') + ' >> ' + this.internal;
        }
      };
    };
    
    const primary = buildCompositeWithHost(top3[0]);
    
    const fallback1 = top3[1] ? buildCompositeWithHost(top3[1]) : null;
    
    const fallback2 = top3[2] ? buildCompositeWithHost(top3[2]) : null;
    
    return {
      primary: primary,
      fallback1: fallback1,
      fallback2: fallback2,
      tier: primary.tier,
      strategy: `shadow-nested-${internalResult.strategy}`,
      robustness: primary.robustness,
      framework: framework,
      shadowDOM: true,
      shadowDepth: shadowPath.depth,
      shadowFramework: shadowPath.framework,
      candidateCount: firstHostCandidates.length,
      executionTime: Math.round(performance.now() - startTime)
    };
  }

  // Builds shadow composite object combining host XPath and internal CSS selector
  // Contract: Creates object with toString() serialization and tier/robustness metadata
  static buildShadowComposite(hostCandidate, internalResult, shadowPath, isNested) {
    const hostXPath = hostCandidate.xpath;
    const internalSelector = internalResult.selector;
    
    return {
      type: isNested ? 'shadow-composite-nested' : 'shadow-composite',
      host: hostXPath,
      internal: internalSelector,
      hostChain: isNested ? shadowPath.hosts.map(h => h.hostTag) : [hostXPath],
      shadowDepth: shadowPath.depth,
      framework: shadowPath.framework,
      tier: internalResult.tier || 6,
      robustness: hostCandidate.robustness || 70,
      
      toString: function() {
        return isNested 
          ? this.hostChain.join(' >> ') + ' >> ' + this.internal
          : `${this.host} >> ${this.internal}`;
      }
    };
  }

  // Extracts attributes from XPath for host chain rebuilding (currently unused)
  // Contract: Returns object with extracted aria-controls, data-key, id, class values
  static extractAttributesFromXPath(xpath) {
    const attrs = {};
    
    const patterns = [
      { regex: /\[@aria-controls='([^']+)'\]/, key: 'aria-controls' },
      { regex: /\[@data-key='([^']+)'\]/, key: 'data-key' },
      { regex: /\[@id='([^']+)'\]/, key: 'id' },
      { regex: /\[@class='([^']+)'\]/, key: 'class' }
    ];
    
    for (const { regex, key } of patterns) {
      const match = xpath.match(regex);
      if (match) attrs[key] = match[1];
    }
    
    return attrs;
  }
  
  // Runs XPath strategies for host element and validates in document context
  // Contract: Executes strategies, validates each candidate, returns sorted by tier/robustness; stops at 5 valid candidates
  static async runHostStrategies(strategies, hostElement, validationContext) {
    const validCandidates = [];
    
    for (const { name, tier, fn } of strategies) {
      try {
        const candidates = await Promise.resolve(fn());
        if (!candidates || candidates.length === 0) continue;
        
        for (const candidate of candidates) {
          if (!candidate?.xpath) continue;
          
          const isValid = this.validateInContext(
            candidate.xpath,
            hostElement,
            validationContext
          );
          
          if (isValid) {
            validCandidates.push({
              xpath: candidate.xpath,
              strategy: candidate.strategy || name,
              tier: tier,
              robustness: candidate.robustness || this.calculateRobustness(candidate.xpath, tier)
            });
          }
          
          if (validCandidates.length >= 5) break;
        }
        
        if (validCandidates.length >= 5) break;
        
      } catch (error) {
        if (DEBUG) console.warn(`[XPathShadowHandler] Host strategy ${name} failed:`, error);
        continue;
      }
    }
    
    validCandidates.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      return b.robustness - a.robustness;
    });
    
    return validCandidates;
  }
  
  // Validates XPath in specific context (document or shadowRoot) using document.evaluate
  // Contract: Returns true only if XPath matches exactly 1 element and it's the target element
  static validateInContext(xpath, element, context) {
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
  
  // Calculates robustness score based on XPath attributes and structure
  // Contract: Returns score 30-100; higher for test attrs/IDs, lower for classes/axes; penalizes long paths
  static calculateRobustness(xpath, tier) {
    let score = 100 - (tier * 4);

    if (xpath.includes("[@aria-controls='")) score += 20;
    if (xpath.includes('[@data-key=')) score += 18;
    if (xpath.includes('[@data-record-id=')) score += 17;
    if (xpath.includes('[@data-component-id=')) score += 16;
    if (xpath.includes('[@data-row-key-value=')) score += 15;
    if (xpath.includes('[@data-testid=') || xpath.includes('[@data-test=')) score += 20;
    if (xpath.includes('[@id=') && !xpath.match(/[@id='[^']*\\d{3,}[^']*']/)) score += 15;

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
  
  // Returns empty result structure
  // Contract: Provides consistent empty result shape for error cases
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
}

export default XPathShadowHandler;