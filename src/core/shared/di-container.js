// =============================================================================
// Dependency Injection Container: Service Lifecycle Management with Lazy Bootstrap
//
// Centralized service registration and resolution with singleton caching.
// Lazy bootstrap pattern: services registered on first resolve(), not on module import.
// Prevents race conditions during module initialization and circular dependencies.
// Dependencies: None (pure DI orchestration)
// =============================================================================

import { isDebugEnabled } from './config.js';

const MODULE_DEBUG = false;
const DEBUG = isDebugEnabled(MODULE_DEBUG);

// Lightweight DI container with factory pattern and lifecycle management
// Separates service registration from instantiation for testability
export class DIContainer {
  constructor() {
    this.registry = new Map();
    this.instances = new Map();
    this.bootstrapped = false;
  }
  
  // Registers service factory with singleton or transient lifecycle
  // Singleton services cached in instances map for reuse across resolution calls
  // Throws if attempting to re-register existing singleton without clearing first
  register(name, factory, singleton = false) {
    if (singleton && this.instances.has(name)) {
      throw new Error(
        `Cannot re-register singleton: ${name}. ` +
        `Clear instances first via clear() or clearService('${name}').`
      );
    }
    
    this.registry.set(name, { factory, singleton });
  }
  
  // Resolves service instance via factory or singleton cache
  // Lazy bootstrap on first call: registers all services only when needed
  // Prevents race conditions from eager module-level initialization
  resolve(name) {
    // Bootstrap on first resolve to avoid module initialization races
    if (!this.bootstrapped) {
      this.bootstrap();
    }
    
    const registration = this.registry.get(name);
    
    if (!registration) {
      const available = Array.from(this.registry.keys()).join(', ');
      throw new Error(
        `Service not found: ${name}. ` +
        `Available services: ${available || 'none'}`
      );
    }
    
    if (registration.singleton) {
      if (!this.instances.has(name)) {
        this.instances.set(name, registration.factory());
      }
      return this.instances.get(name);
    }
    
    return registration.factory();
  }
  
  // Lazy bootstrap: registers all default services on first resolve
  // Uses lazy require() in factories to prevent circular dependency issues
  // Allows retry on failure by resetting bootstrapped flag
  bootstrap() {
    if (this.bootstrapped) return;
    
    try {
      // Selector generation engines (singleton for consistent caching behavior)
      this.register('xpathEngine', () => {
        const XPathEngine = require('../enrichment/xpath-engine.js').default;
        return XPathEngine;
      }, true);
      
      this.register('cssEngine', () => {
        const CSSEngine = require('../enrichment/css-engine.js').default;
        return CSSEngine;
      }, true);
      
      // Label extraction (singleton for LRU cache sharing)
      this.register('labelExtractor', () => {
        const LabelExtractor = require('../enrichment/label-extractor.js').default;
        return LabelExtractor;
      }, true);
      
      // Shadow DOM traversal (singleton for cache sharing)
      this.register('shadowTraverser', () => {
        const ShadowDOMTraverser = require('../helpers/shadow-dom-traverser.js').default;
        return ShadowDOMTraverser;
      }, true);
      
      // Parent chain builder (singleton for reusable traversal logic)
      this.register('parentBuilder', () => {
        const buildParentChain = require('../enrichment/parent-builder.js').default;
        return buildParentChain;
      }, true);
      
      // Metadata collector (singleton for reusable extraction logic)
      this.register('metadataCollector', () => {
        const collectMetadata = require('../enrichment/metadata-collector.js').default;
        return collectMetadata;
      }, true);
      
      // Nearby element finder (singleton for spatial query optimization)
      this.register('nearbyFinder', () => {
        const findNearbyElements = require('../enrichment/nearby-finder.js').default;
        return findNearbyElements;
      }, true);
      
      // Description builder (singleton for template caching)
      this.register('descriptionBuilder', () => {
        const buildDescription = require('../enrichment/description-builder.js').default;
        return buildDescription;
      }, true);
      
      this.bootstrapped = true;
      
    } catch (error) {
      if (DEBUG) console.error('[DIContainer] Bootstrap failed:', error);
      // Allow retry on next resolve by not setting bootstrapped flag
      this.bootstrapped = false;
    }
  }
  
  // Checks if service registered without triggering instantiation
  // Safe for checking service availability before resolution
  has(name) {
    return this.registry.has(name);
  }
  
  // Unregisters service and clears singleton instance
  // No-op if service doesn't exist (safe for cleanup)
  unregister(name) {
    this.registry.delete(name);
    this.instances.delete(name);
  }
  
  // Clears singleton instance cache without unregistering factory
  // Useful for forcing re-instantiation without re-registration
  clearService(name) {
    this.instances.delete(name);
  }
  
  // Clears all singleton instances while preserving registry
  // Used for testing cleanup between test cases
  clear() {
    this.instances.clear();
  }
  
  // Resets container to initial state (empty registry and instances)
  // Used for complete teardown in testing scenarios
  reset() {
    this.registry.clear();
    this.instances.clear();
    this.bootstrapped = false;
  }
  
  // Returns array of all registered service names
  // Useful for debugging and service discovery
  getServiceNames() {
    return Array.from(this.registry.keys());
  }
}

// Global singleton container for application-wide service resolution
// Single instance ensures consistent service sharing across modules
export const globalContainer = new DIContainer();

// No auto-bootstrap: services registered lazily on first resolve()
// Prevents module initialization race conditions and circular dependencies