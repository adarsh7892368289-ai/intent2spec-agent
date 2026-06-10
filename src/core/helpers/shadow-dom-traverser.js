// ======================================================================
// Shadow DOM Traverser: LRU-Cached Element Discovery with Periodic Cleanup
//
// Traverses shadow DOM trees using visitor pattern with bounded LRU cache.
// Eliminates O(n²) queries via cached element lists per shadow root key.
// Active expiration via periodic cleanup prevents unbounded memory growth in SPAs.
// Dependencies: None (uses native shadowRoot APIs)
// ======================================================================

import { isDebugEnabled } from '../shared/config.js';

const MODULE_DEBUG = false;
const DEBUG = isDebugEnabled(MODULE_DEBUG);

class ShadowDOMTraverser {
  
  // LRU cache with hard size limit and periodic cleanup
  // Uses stable key generation (tag:id:data-key) instead of WeakMap for bounded memory
  static shadowRootCache = new Map();
  static cacheAccessOrder = [];
  static cacheExpiry = 5000;
  static maxCacheSize = 100;
  static cleanupInterval = null;
  
  // Recursively finds all elements matching selector across shadow boundaries
  // Maintains visited set to prevent infinite loops in circular shadow structures
  // Returns deduplicated array of matching elements
  static findAllElements(root = document, selector, maxDepth = 10) {
    const elements = [];
    const visited = new WeakSet();
    
    const traverse = (currentRoot, depth) => {
      if (depth > maxDepth || visited.has(currentRoot)) return;
      if (!currentRoot?.querySelectorAll) return;
      
      visited.add(currentRoot);
      
      // Query current root for direct matches
      try {
        const directMatches = currentRoot.querySelectorAll(selector);
        elements.push(...Array.from(directMatches));
      } catch (e) {
        if (DEBUG) console.warn('[ShadowTraverser] Invalid selector:', selector, e);
      }
      
      const cachedElements = this.getCachedElements(currentRoot);
      
      if (cachedElements) {
        // Fast path: use cached element list to find shadow roots
        for (const el of cachedElements) {
          if (el.shadowRoot) {
            traverse(el.shadowRoot, depth + 1);
            continue;
          }
          
          // Try accessing closed shadow roots on custom elements
          if (el.tagName?.includes('-')) {
            const closedRoot = this.tryAccessClosedShadowRoot(el);
            if (closedRoot && !visited.has(closedRoot)) {
              traverse(closedRoot, depth + 1);
            }
          }
        }
      } else {
        // Slow path: query all elements and cache for future use
        let allElements;
        try {
          allElements = Array.from(currentRoot.querySelectorAll('*'));
          this.setCachedElements(currentRoot, allElements);
        } catch (e) {
          return;
        }
        
        for (const el of allElements) {
          if (el.shadowRoot) {
            traverse(el.shadowRoot, depth + 1);
            continue;
          }
          
          if (el.tagName?.includes('-')) {
            const closedRoot = this.tryAccessClosedShadowRoot(el);
            if (closedRoot && !visited.has(closedRoot)) {
              traverse(closedRoot, depth + 1);
            }
          }
        }
      }
    };
    
    traverse(root, 0);
    
    return Array.from(new Set(elements));
  }
  
  // Retrieves cached elements with TTL expiration check
  // Updates LRU access order on cache hit to prevent premature eviction
  // Returns null on miss or expiration for cache rebuild
  static getCachedElements(shadowRoot) {
    const key = this.getShadowRootKey(shadowRoot);
    
    if (!this.shadowRootCache.has(key)) return null;
    
    const cached = this.shadowRootCache.get(key);
    const now = Date.now();
    
    // Check TTL expiration
    if (now - cached.timestamp > this.cacheExpiry) {
      this.shadowRootCache.delete(key);
      this.removeFromAccessOrder(key);
      return null;
    }
    
    // Update LRU order (move to end = most recently used)
    this.updateAccessOrder(key);
    
    return cached.elements;
  }
  
  // Stores elements in LRU cache with automatic eviction on size limit
  // Evicts least-recently-used entry when cache reaches maxCacheSize
  // Updates access order to mark as most recently used
  static setCachedElements(shadowRoot, elements) {
    const key = this.getShadowRootKey(shadowRoot);
    
    // Enforce size limit via LRU eviction
    if (this.shadowRootCache.size >= this.maxCacheSize) {
      const lruKey = this.cacheAccessOrder.shift();
      this.shadowRootCache.delete(lruKey);
    }
    
    this.shadowRootCache.set(key, {
      elements: elements,
      timestamp: Date.now()
    });
    
    this.updateAccessOrder(key);
  }
  
  // Generates stable cache key from shadow root's host element
  // Uses tag:id:data-key format for consistent identification across sessions
  // Falls back to random key for orphaned shadow roots without host
  static getShadowRootKey(shadowRoot) {
    const host = shadowRoot.host;
    if (!host) return `shadow-${Math.random()}`;
    
    const id = host.id || '';
    const tag = host.tagName.toLowerCase();
    const dataKey = host.getAttribute('data-key') || '';
    
    return `${tag}:${id}:${dataKey}`;
  }
  
  // Updates LRU access order by moving key to end (most recent)
  // Removes existing occurrence to maintain uniqueness before appending
  static updateAccessOrder(key) {
    this.removeFromAccessOrder(key);
    this.cacheAccessOrder.push(key);
  }
  
  // Removes key from access order array to maintain unique entries
  // Used during eviction and before re-insertion on access
  static removeFromAccessOrder(key) {
    const index = this.cacheAccessOrder.indexOf(key);
    if (index > -1) {
      this.cacheAccessOrder.splice(index, 1);
    }
  }
  
  // Clears entire cache and resets access order
  // Called by event-manager on mode switch and injector on unload
  static clearCache() {
    this.shadowRootCache.clear();
    this.cacheAccessOrder = [];
    if (DEBUG) console.log('[ShadowTraverser] Cache cleared');
  }
  
  // Periodic cleanup task to remove expired entries
  // Runs every 30s to prevent unbounded growth in long-running SPAs
  // Logs cleanup count for monitoring cache health
  static startPeriodicCleanup() {
    if (this.cleanupInterval) return;
    
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      const keysToDelete = [];
      
      // Find all expired entries
      for (const [key, cached] of this.shadowRootCache.entries()) {
        if (now - cached.timestamp > this.cacheExpiry) {
          keysToDelete.push(key);
        }
      }
      
      // Delete expired entries and update access order
      keysToDelete.forEach(key => {
        this.shadowRootCache.delete(key);
        this.removeFromAccessOrder(key);
      });
      
      if (DEBUG && keysToDelete.length > 0) {
        console.log(`[ShadowTraverser] Periodic cleanup removed ${keysToDelete.length} expired entries`);
      }
    }, 30000);
  }
  
  // Stops periodic cleanup interval
  // Called during testing or when traverser is being torn down
  static stopPeriodicCleanup() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
  
  // Attempts to access closed shadow roots via framework-specific APIs
  // Tries: element.template, element._shadowRoot, Aura/Lightning APIs
  // Returns null if inaccessible (security boundary respected)
  static tryAccessClosedShadowRoot(element) {
    try {
      if (element.template instanceof ShadowRoot) return element.template;
      if (element._shadowRoot instanceof ShadowRoot) return element._shadowRoot;
      
      // Salesforce Aura framework detection
      if (element.getAttribute?.('data-aura-rendered-by')) {
        const shadowRoot = this.tryAccessAuraShadowRoot(element);
        if (shadowRoot) return shadowRoot;
      }
      
      // Salesforce Lightning Web Components detection
      if (element.tagName?.startsWith('LIGHTNING-')) {
        const shadowRoot = this.tryAccessLightningShadowRoot(element);
        if (shadowRoot) return shadowRoot;
      }
      
      // Attempt direct access (may throw if closed)
      if (DEBUG && element.shadowRoot === null) {
        try {
          const internalRoot = element.shadowRoot;
          if (internalRoot instanceof ShadowRoot) return internalRoot;
        } catch (e) {
          // Expected for closed roots
        }
      }
      
    } catch (e) {
      if (DEBUG) console.warn('[ShadowTraverser] Closed root access failed:', e);
    }
    
    return null;
  }
  
  // Accesses Aura component shadow root via global $A API
  // Retrieves component by aura-rendered-by ID and extracts shadow root
  // Returns null if $A unavailable or component not found
  static tryAccessAuraShadowRoot(element) {
    try {
      if (typeof window.$A === 'undefined' || !window.$A.getComponent) return null;
      
      const auraId = element.getAttribute('data-aura-rendered-by');
      if (!auraId) return null;
      
      const component = window.$A.getComponent(auraId);
      if (!component) return null;
      
      if (component.getElement) {
        const compElement = component.getElement();
        if (compElement?.shadowRoot) return compElement.shadowRoot;
      }
      
      if (component.getElements) {
        const elements = component.getElements();
        if (elements?.length > 0) {
          const firstEl = elements[0];
          if (firstEl?.shadowRoot) return firstEl.shadowRoot;
        }
      }
      
    } catch (e) {
      if (DEBUG) console.warn('[ShadowTraverser] Aura access failed:', e);
    }
    
    return null;
  }
  
  // Accesses Lightning Web Component shadow root via template property
  // Uses getRootNode() fallback for nested shadow contexts
  // Returns null if template unavailable or not a ShadowRoot
  static tryAccessLightningShadowRoot(element) {
    try {
      if (element.template) return element.template;
      
      if (element.querySelector) {
        const child = element.querySelector('*');
        if (child?.getRootNode) {
          const root = child.getRootNode();
          if (root instanceof ShadowRoot) return root;
        }
      }
      
      if (element.shadowRoot) return element.shadowRoot;
      
    } catch (e) {
      // Expected for inaccessible shadow roots
    }
    
    return null;
  }
  
  // Extracts shadow DOM path from element to document root
  // Returns host chain with mode, tag, attributes, and framework detection
  // Used for shadow-piercing selector generation
  static getShadowPath(element) {
    const hosts = [];
    let current = element;
    let depth = 0;
    const maxIterations = 20;
    
    while (current && depth < maxIterations) {
      const root = current.getRootNode();
      
      if (root instanceof ShadowRoot) {
        const host = root.host;
        
        hosts.unshift({
          host: host,
          mode: root.mode || 'unknown',
          hostTag: host.tagName.toLowerCase(),
          hostAttributes: this.extractHostAttributes(host),
          hostId: host.id || null,
          hostClasses: host.className || null
        });
        
        current = host;
        depth++;
      } else {
        break;
      }
    }
    
    const isLightning = hosts.some(h => 
      h.hostTag.startsWith('lightning-') || 
      h.hostTag.startsWith('c-')
    );
    
    const isAura = hosts.some(h => 
      h.host.hasAttribute('data-aura-rendered-by') ||
      h.host.hasAttribute('data-aura-class')
    );
    
    return {
      inShadowDOM: hosts.length > 0,
      hosts: hosts,
      depth: hosts.length,
      isLightning: isLightning,
      isAura: isAura,
      framework: this.detectFramework(hosts)
    };
  }
  
  // Extracts selector-stable attributes from host element
  // Whitelist approach: only includes attributes useful for selectors
  // Filters dynamic state attributes and unstable generated IDs
  static extractHostAttributes(host) {
    if (!host?.attributes) return {};

    const extracted = {};
    const allAttrs = Array.from(host.attributes);

    const selectorAttributes = new Set([
      'id', 'class', 'role', 'type', 'name',
      'aria-controls', 'aria-label', 'aria-labelledby', 'aria-describedby',
      'data-key', 'data-record-id', 'data-component-id',
      'data-testid', 'data-test', 'data-qa', 'data-cy',
      'data-row-key-value', 'data-name', 'data-tracking-type'
    ]);

    const dynamicStateAttributes = new Set([
      'aria-expanded', 'aria-selected', 'aria-pressed', 'aria-checked',
      'aria-hidden', 'aria-current', 'aria-disabled',
      'disabled', 'checked', 'selected', 'open'
    ]);

    const blacklistKeywords = ['override', 'module', 'tbid', 'menu', 'link', 'button', 'contact', 'context', 'search', 'region', 'main'];

    for (const attr of allAttrs) {
      const name = attr.name;
      const value = attr.value;

      if (!value || value.length === 0 || value.length > 200) continue;
      if (name.startsWith('on') || name.startsWith('_')) continue;
      if (['style', 'tabindex', 'draggable'].includes(name)) continue;
      if (dynamicStateAttributes.has(name)) continue;

      const isWhitelisted = selectorAttributes.has(name);
      const isDataAttr = name.startsWith('data-');

      if (isDataAttr) {
        const hasBlacklistedKeyword = blacklistKeywords.some(keyword =>
          name.toLowerCase().includes(keyword)
        );
        if (hasBlacklistedKeyword) continue;
      }

      if (!isWhitelisted && !isDataAttr) continue;
      if (!this.isStableAttributeValue(value)) continue;

      extracted[name] = value;
    }

    return extracted;
  }
  
  // Validates attribute value stability for selector usage
  // Filters timestamps, UUIDs, and framework-generated IDs
  // Returns false for values likely to change across sessions
  static isStableAttributeValue(value) {
    if (!value || typeof value !== 'string') return false;
    if (value.length < 1 || value.length > 500) return false;
    
    const unstablePatterns = [
      /^[0-9]{8,}$/,
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}/i,
      /^\d{13,}$/,
      /^ember\d+$/i,
      /^react-\d+$/i,
      /^vue-\d+$/i
    ];
    
    return !unstablePatterns.some(pattern => pattern.test(value));
  }
  
  // Detects UI framework from shadow host tag patterns
  // Returns framework identifier for selector strategy selection
  // Used to apply framework-specific optimizations
  static detectFramework(hosts) {
    if (hosts.length === 0) return 'none';
    
    const hasLightningTag = hosts.some(h => h.hostTag.startsWith('lightning-'));
    const hasLWCTag = hosts.some(h => h.hostTag.startsWith('c-'));
    if (hasLightningTag || hasLWCTag) return 'lightning';
    
    const hasAuraAttr = hosts.some(h => 
      h.host.hasAttribute('data-aura-rendered-by')
    );
    if (hasAuraAttr) return 'aura';
    
    const tags = hosts.map(h => h.hostTag).join(' ');
    if (tags.includes('ion-')) return 'ionic';
    if (tags.includes('mat-')) return 'angular-material';
    if (tags.includes('mwc-')) return 'material-web-components';
    
    return 'custom';
  }

  // Generates executable shadow-piercing selector path
  // Returns object with selector string and executable function
  // Handles both standard CSS and shadow DOM traversal
  static generateShadowPiercingPath(element) {
    const shadowPath = this.getShadowPath(element);
    
    if (!shadowPath.inShadowDOM) {
      const cssSelector = this.generateStandardCSSPath(element);
      return {
        type: 'standard-css',
        selector: cssSelector,
        shadowDepth: 0,
        framework: 'none',
        executable: (doc = document) => doc.querySelector(cssSelector),
        toString: () => cssSelector
      };
    }
    
    const segments = [];
    
    // Build host chain segments
    for (let i = 0; i < shadowPath.hosts.length; i++) {
      const hostInfo = shadowPath.hosts[i];
      const hostSelector = this.buildHostSelector(hostInfo);
      
      segments.push({
        type: 'shadow-host',
        selector: hostSelector,
        tag: hostInfo.hostTag,
        depth: i,
        attributes: hostInfo.hostAttributes
      });
    }
    
    // Build final target element selector
    const finalSelector = this.buildLocalPath(element);
    segments.push({
      type: 'target-element',
      selector: finalSelector,
      isTarget: true
    });
    
    // Create executable function for runtime resolution
    const executable = (doc = document) => {
      let currentRoot = doc;
      
      try {
        // Traverse shadow host chain
        for (let i = 0; i < segments.length - 1; i++) {
          const seg = segments[i];
          
          const host = currentRoot.querySelector(seg.selector);
          if (!host) {
            if (DEBUG) console.warn('[ShadowTraverser] Host not found:', seg.selector);
            return null;
          }
          
          let shadowRoot = host.shadowRoot;
          if (!shadowRoot) {
            shadowRoot = ShadowDOMTraverser.tryAccessClosedShadowRoot(host);
          }
          
          if (!shadowRoot) {
            if (DEBUG) console.warn('[ShadowTraverser] Shadow root inaccessible');
            return null;
          }
          
          currentRoot = shadowRoot;
        }
        
        // Query final element in shadow context
        const finalSelector = segments[segments.length - 1].selector;
        return currentRoot.querySelector(finalSelector);
        
      } catch (e) {
        if (DEBUG) console.error('[ShadowTraverser] Execution failed:', e);
        return null;
      }
    };
    
    return {
      type: 'shadow-piercing',
      selector: null,
      shadowDepth: shadowPath.depth,
      framework: shadowPath.framework,
      segments: segments,
      executable: executable,
      toString: () => segments.map(s => s.selector).join(' >> ')
    };
  }
  
  // Builds optimal selector for shadow host element
  // Prioritizes stable attributes over classes/tags
  // Returns most robust selector available
  static buildHostSelector(hostInfo) {
    const { hostTag, hostAttributes, hostId } = hostInfo;
    
    const prioritized = this.prioritizeAttributes(hostAttributes);
    
    if (prioritized.length > 0) {
      const topAttr = prioritized[0];
      return `${hostTag}[${topAttr.name}="${this.escapeCss(topAttr.value)}"]`;
    }
    
    if (hostId && this.isStableId(hostId)) {
      return `#${this.escapeCss(hostId)}`;
    }
    
    if (hostAttributes['class']) {
      const classes = hostAttributes['class'].split(' ')
        .filter(c => c.length > 3)
        .filter(c => this.isStableClass(c));
      
      if (classes.length > 0) {
        return `${hostTag}.${this.escapeCss(classes[0])}`;
      }
    }
    
    return hostTag;
  }
  
  // Prioritizes attributes by selector stability score
  // ARIA and data-testid attributes receive highest scores
  // Returns sorted array of {name, value, score}
  static prioritizeAttributes(attributes) {
    const scored = [];
    
    for (const [name, value] of Object.entries(attributes)) {
      if (name === 'class' || name === 'style') continue;
      
      let score = 0;
      
      if (name === 'aria-controls') score = 100;
      else if (name.startsWith('aria-')) score = 90;
      else if (name === 'data-key') score = 95;
      else if (name === 'data-record-id') score = 94;
      else if (name === 'data-component-id') score = 93;
      else if (name === 'data-testid' || name === 'data-test') score = 92;
      else if (name.startsWith('data-') && name.includes('id')) score = 85;
      else if (name.startsWith('data-') && name.includes('key')) score = 84;
      else if (name.startsWith('data-')) score = 70;
      else if (name === 'id') score = 80;
      else if (name === 'name') score = 75;
      else if (name === 'role') score = 65;
      else if (name === 'type') score = 60;
      else score = 50;
      
      if (value.length < 10) score += 5;
      if (/^[a-z0-9-]+$/.test(value)) score += 3;
      
      scored.push({ name, value, score });
    }
    
    return scored.sort((a, b) => b.score - a.score);
  }
  
  // Builds selector for element within shadow root
  // Prefers stable attributes over structural selectors
  // Falls back to nth-of-type for dynamic elements
  static buildLocalPath(element) {
    const allAttrs = this.extractHostAttributes(element);
    const prioritized = this.prioritizeAttributes(allAttrs);
    
    if (prioritized.length > 0) {
      const top = prioritized[0];
      return `[${top.name}="${this.escapeCss(top.value)}"]`;
    }
    
    const id = element.id;
    if (id && this.isStableId(id)) {
      return `#${this.escapeCss(id)}`;
    }
    
    const tag = element.tagName.toLowerCase();
    const type = element.getAttribute('type');
    const name = element.getAttribute('name');
    const role = element.getAttribute('role');
    
    if (type && name) {
      return `${tag}[type="${this.escapeCss(type)}"][name="${this.escapeCss(name)}"]`;
    }
    
    if (type) return `${tag}[type="${this.escapeCss(type)}"]`;
    
    if (name && this.isStableAttributeValue(name)) {
      return `${tag}[name="${this.escapeCss(name)}"]`;
    }
    
    if (role) return `${tag}[role="${this.escapeCss(role)}"]`;
    
    if (element.className && typeof element.className === 'string') {
      const classes = element.className.split(' ')
        .filter(c => c.length > 3)
        .filter(c => this.isStableClass(c));
      
      if (classes.length > 0) {
        return `${tag}.${this.escapeCss(classes[0])}`;
      }
    }
    
    const parent = element.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children)
        .filter(e => e.tagName === element.tagName);
      const index = siblings.indexOf(element) + 1;
      return `${tag}:nth-of-type(${index})`;
    }
    
    return tag;
  }
  
  // Generates standard CSS path for non-shadow elements
  // Builds hierarchical selector up to 5 levels deep
  // Stops at first stable ID found in ancestor chain
  static generateStandardCSSPath(element) {
    if (element.id && this.isStableId(element.id)) {
      return `#${this.escapeCss(element.id)}`;
    }
    
    const allAttrs = this.extractHostAttributes(element);
    const prioritized = this.prioritizeAttributes(allAttrs);
    
    if (prioritized.length > 0 && prioritized[0].score >= 90) {
      const top = prioritized[0];
      return `[${top.name}="${this.escapeCss(top.value)}"]`;
    }
    
    const path = [];
    let current = element;
    
    while (current && current !== document.body && path.length < 5) {
      let segment = current.tagName.toLowerCase();
      
      if (current.id && this.isStableId(current.id)) {
        segment = `#${this.escapeCss(current.id)}`;
        path.unshift(segment);
        break;
      }
      
      if (current.className && typeof current.className === 'string') {
        const classes = current.className.split(' ')
          .filter(c => c.length > 3)
          .filter(c => this.isStableClass(c));
        if (classes.length > 0) {
          segment += `.${this.escapeCss(classes[0])}`;
        }
      }
      
      path.unshift(segment);
      current = current.parentElement;
    }
    
    return path.join(' > ');
  }
  
  // Validates ID stability for selector usage
  // Filters numeric IDs, framework-generated IDs, and UUIDs
  static isStableId(id) {
    if (!id || id.length < 3 || id.length > 100) return false;
    
    const unstablePatterns = [
      /^\d+$/,
      /^[0-9]{6,}$/,
      /lightning-\w+-\d+/i,
      /^ember\d+$/i,
      /^react-\d+$/i,
      /-\d{8,}$/,
      /^[a-f0-9]{8}-[a-f0-9]{4}/i
    ];
    
    return !unstablePatterns.some(pattern => pattern.test(id));
  }
  
  // Validates class name stability for selector usage
  // Filters CSS-in-JS generated classes and framework hashes
  static isStableClass(className) {
    if (!className || typeof className !== 'string') return false;
    
    const unstablePatterns = [
      /^[a-z]\d+$/i,
      /^css-[a-z0-9]+$/i,
      /^makeStyles-/i,
      /^jss\d+$/i,
      /^sc-[a-z]+-[a-z]+$/i,
      /^emotion-\d+$/i,
      /lwc-[a-z0-9]+/i
    ];
    
    return !unstablePatterns.some(pattern => pattern.test(className));
  }
  
  // Escapes special characters for CSS selector usage
  // Handles quotes and backslashes to prevent syntax errors
  static escapeCss(str) {
    if (!str) return '';
    return str.replace(/["\\]/g, '\\$&');
  }
}

// Start periodic cleanup on module load
// Ensures cache doesn't grow unbounded in long-running SPAs
if (typeof window !== 'undefined') {
  ShadowDOMTraverser.startPeriodicCleanup();
}

export default ShadowDOMTraverser;