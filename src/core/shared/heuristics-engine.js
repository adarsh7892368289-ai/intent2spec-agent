// =====================================================================
// Heuristics Engine: Adaptive Performance Tuning with Monotonic Clock
//
// Computes context-aware timeouts and concurrency limits based on page complexity.
// Uses performance.now() for clock-skew-resistant cache timing (NTP-safe).
// Memory pressure detection scales down resources under high heap usage.
// Dependencies: config.js for base timeout/concurrency values
// =====================================================================

import { ENRICHMENT_CONFIG, isDebugEnabled } from './config.js';

const MODULE_DEBUG = false;
const DEBUG = isDebugEnabled(MODULE_DEBUG);

class HeuristicsEngine {
  constructor() {
    this.pageStatsCache = null;
    this.lastCacheUpdate = 0;
    this.cacheTTL = 5000;
    
    this.deviceCapabilityCache = null;
    this.lastDeviceCheck = 0;
    this.deviceCheckInterval = 30000;
    
    // Finer-grained thresholds for adaptive timeout scaling
    // Triggers adjustments at lower node counts (100+ vs original 5000+)
    this.complexityThresholds = {
      veryComplex: 10000,
      complex: 2000,
      medium: 500,
      light: 100,
      simple: 0
    };
    
    this.timeoutBounds = {
      min: 50,
      max: 300,
      base: ENRICHMENT_CONFIG.MAX_ENRICHMENT_TIME || 100
    };
    
    this.concurrencyBounds = {
      min: 3,
      max: 20,
      base: ENRICHMENT_CONFIG.BATCH_CONCURRENCY || 15
    };
    
    this.featureFlags = {
      enableAdaptiveTimeout: true,
      enableAdaptiveConcurrency: true,
      enableMemoryPressureDetection: true,
      enableShadowComplexityScoring: true
    };
  }

  // Computes enrichment timeout with finer granularity and explicit memory pressure scaling
  // Adaptive thresholds trigger at lower node counts for better responsiveness
  // Memory pressure reduces timeout by 50-75% to prevent heap exhaustion
  computeEnrichmentTimeout(pageStats = {}) {
    if (!this.featureFlags.enableAdaptiveTimeout) {
      return this.timeoutBounds.base;
    }

    let timeout = this.timeoutBounds.base;
    const domNodeCount = pageStats.domNodeCount || this.estimateDOMComplexity();
    const shadowRootCount = pageStats.shadowRootCount || 0;

    // Apply complexity-based scaling with finer thresholds
    if (domNodeCount > this.complexityThresholds.veryComplex) {
      timeout = 300;
    } else if (domNodeCount > this.complexityThresholds.complex) {
      timeout = 200;
    } else if (domNodeCount > this.complexityThresholds.medium) {
      timeout = 150;
    } else if (domNodeCount > this.complexityThresholds.light) {
      timeout = 125;
    }

    // Shadow DOM complexity scaling (additional 15-30% overhead)
    if (this.featureFlags.enableShadowComplexityScoring && shadowRootCount > 0) {
      if (shadowRootCount > 10) {
        timeout = Math.min(this.timeoutBounds.max, Math.round(timeout * 1.3));
      } else if (shadowRootCount > 5) {
        timeout = Math.min(this.timeoutBounds.max, Math.round(timeout * 1.15));
      }
    }

    // Explicit memory pressure reduction to prevent heap exhaustion
    // High pressure (>85%): reduce timeout by 50%
    // Elevated pressure (>70%): reduce timeout by 25%
    if (this.featureFlags.enableMemoryPressureDetection) {
      const memoryPressure = this.estimateMemoryPressure();
      
      if (memoryPressure > 0.85) {
        timeout = Math.max(this.timeoutBounds.min, Math.round(timeout * 0.5));
        if (DEBUG) {
          console.log(`[HeuristicsEngine] Memory pressure HIGH (${(memoryPressure * 100).toFixed(1)}%), reducing timeout to ${timeout}ms`);
        }
      } else if (memoryPressure > 0.7) {
        timeout = Math.max(this.timeoutBounds.min * 1.5, Math.round(timeout * 0.75));
        if (DEBUG) {
          console.log(`[HeuristicsEngine] Memory pressure ELEVATED (${(memoryPressure * 100).toFixed(1)}%), reducing timeout to ${timeout}ms`);
        }
      }
    }

    const finalTimeout = Math.max(
      this.timeoutBounds.min, 
      Math.min(this.timeoutBounds.max, Math.round(timeout))
    );

    if (DEBUG) {
      console.log('[HeuristicsEngine] Computed timeout:', {
        base: this.timeoutBounds.base,
        computed: finalTimeout,
        domNodes: domNodeCount,
        shadowRoots: shadowRootCount,
        adjusted: finalTimeout !== this.timeoutBounds.base
      });
    }

    return finalTimeout;
  }

  // Computes batch concurrency with explicit memory pressure scaling
  // Reduces concurrency by 50-66% under high memory pressure
  // Lower concurrency prevents parallel enrichment from exhausting heap
  computeBatchConcurrency(pageStats = {}, deviceStats = {}) {
    if (!this.featureFlags.enableAdaptiveConcurrency) {
      return this.concurrencyBounds.base;
    }

    let concurrency = this.concurrencyBounds.base;
    const domNodeCount = pageStats.domNodeCount || this.estimateDOMComplexity();

    // Apply complexity-based reduction
    if (domNodeCount > this.complexityThresholds.veryComplex) {
      concurrency = 5;
    } else if (domNodeCount > this.complexityThresholds.complex) {
      concurrency = 10;
    } else if (domNodeCount > this.complexityThresholds.medium) {
      concurrency = 12;
    }

    // Explicit memory pressure reduction
    // Critical pressure (>90%): reduce to 1/3 of computed value
    // High pressure (>80%): reduce to 1/2 of computed value
    if (this.featureFlags.enableMemoryPressureDetection) {
      const memoryPressure = this.estimateMemoryPressure();
      
      if (memoryPressure > 0.9) {
        concurrency = Math.max(this.concurrencyBounds.min, Math.round(concurrency / 3));
        if (DEBUG) {
          console.log(`[HeuristicsEngine] Memory pressure CRITICAL (${(memoryPressure * 100).toFixed(1)}%), reducing concurrency to ${concurrency}`);
        }
      } else if (memoryPressure > 0.8) {
        concurrency = Math.max(this.concurrencyBounds.min, Math.round(concurrency / 2));
        if (DEBUG) {
          console.log(`[HeuristicsEngine] Memory pressure HIGH (${(memoryPressure * 100).toFixed(1)}%), reducing concurrency to ${concurrency}`);
        }
      }
    }

    const finalConcurrency = Math.max(
      this.concurrencyBounds.min,
      Math.min(this.concurrencyBounds.max, Math.round(concurrency))
    );

    if (DEBUG) {
      console.log('[HeuristicsEngine] Computed concurrency:', {
        base: this.concurrencyBounds.base,
        computed: finalConcurrency,
        domNodes: domNodeCount,
        adjusted: finalConcurrency !== this.concurrencyBounds.base
      });
    }

    return finalConcurrency;
  }

  // Estimates DOM complexity via node count with monotonic clock caching
  // Uses performance.now() instead of Date.now() to prevent NTP sync issues
  // Cache survives system clock changes (daylight saving, manual adjustments)
  estimateDOMComplexity() {
    const now = performance.now();
    
    if (this.pageStatsCache && (now - this.lastCacheUpdate) < this.cacheTTL) {
      return this.pageStatsCache.domNodeCount;
    }

    try {
      const allElements = document.querySelectorAll('*');
      const domNodeCount = allElements.length;
      
      this.pageStatsCache = {
        domNodeCount,
        timestamp: now
      };
      this.lastCacheUpdate = now;
      
      return domNodeCount;
    } catch (error) {
      return 500;
    }
  }

  // Estimates memory pressure from JS heap usage
  // Returns 0.0-1.0 representing used/limit ratio
  // Logs warning when pressure exceeds 70% threshold
  estimateMemoryPressure() {
    try {
      if (performance.memory) {
        const used = performance.memory.usedJSHeapSize;
        const limit = performance.memory.jsHeapSizeLimit;
        const pressure = used / limit;
        
        if (DEBUG && pressure > 0.7) {
          console.log(`[HeuristicsEngine] Memory: ${(used / 1024 / 1024).toFixed(1)}MB / ${(limit / 1024 / 1024).toFixed(1)}MB (${(pressure * 100).toFixed(1)}%)`);
        }
        
        return pressure;
      }
    } catch (e) {
      // Performance.memory not available
    }
    
    return 0.5;
  }

  // Retrieves device capability with monotonic clock caching
  // Caches result for 30s to avoid repeated navigator queries
  // Returns capability rating (low/medium/high) for UI adaptation
  getDeviceCapability() {
    const now = performance.now();
    
    if (this.deviceCapabilityCache && (now - this.lastDeviceCheck) < this.deviceCheckInterval) {
      return this.deviceCapabilityCache;
    }

    const capability = {
      cores: navigator.hardwareConcurrency || 4,
      memory: this.estimateMemoryPressure(),
      rating: 'medium'
    };

    if (capability.cores >= 8 && capability.memory < 0.5) {
      capability.rating = 'high';
    } else if (capability.cores <= 2 || capability.memory > 0.8) {
      capability.rating = 'low';
    }

    this.deviceCapabilityCache = capability;
    this.lastDeviceCheck = now;

    return capability;
  }

  // Returns config flag for invisible element skipping
  // True by default in interactions mode to reduce noise
  shouldSkipInvisibleInInteractions() {
    return ENRICHMENT_CONFIG.SKIP_INVISIBLE_IN_INTERACTIONS !== false;
  }

  // Returns maximum batch execution time before timeout
  // Default 60s allows full page scans on complex sites
  getMaxBatchTime() {
    return ENRICHMENT_CONFIG.MAX_BATCH_TIME || 60000;
  }

  // Computes parallel operation timeout with memory pressure scaling
  // Reduces timeout under high memory to prevent cascading failures
  // Base timeout from config (50ms default)
  getParallelTimeout() {
    const baseTimeout = ENRICHMENT_CONFIG.PARALLEL_TIMEOUT || 50;
    
    if (!this.featureFlags.enableMemoryPressureDetection) {
      return baseTimeout;
    }
    
    const memoryPressure = this.estimateMemoryPressure();
    
    if (memoryPressure > 0.8) {
      const reduced = Math.max(20, Math.round(baseTimeout * 0.5));
      if (DEBUG) {
        console.log(`[HeuristicsEngine] Parallel timeout reduced to ${reduced}ms (memory: ${(memoryPressure * 100).toFixed(1)}%)`);
      }
      return reduced;
    }
    
    if (memoryPressure > 0.7) {
      return Math.max(30, Math.round(baseTimeout * 0.75));
    }
    
    return baseTimeout;
  }

  // Sets feature flag for runtime behavior modification
  // Used by testing infrastructure to disable adaptive behavior
  setFeatureFlag(flag, value) {
    if (this.featureFlags.hasOwnProperty(flag)) {
      this.featureFlags[flag] = value;
      if (DEBUG) {
        console.log(`[HeuristicsEngine] Feature flag "${flag}" set to ${value}`);
      }
    }
  }

  // Retrieves feature flag value for conditional logic
  // Returns undefined if flag doesn't exist
  getFeatureFlag(flag) {
    return this.featureFlags[flag];
  }

  // Clears all caches and resets monotonic timestamps
  // Called by event-manager on mode switch and navigation-capture on route change
  // Safe to reset performance.now() values (monotonic, origin-relative)
  clearCache() {
    this.pageStatsCache = null;
    this.deviceCapabilityCache = null;
    this.lastCacheUpdate = 0;
    this.lastDeviceCheck = 0;
    if (DEBUG) {
      console.log('[HeuristicsEngine] Cache cleared');
    }
  }

  // Returns complete metrics snapshot for debugging
  // Includes cache age calculated from monotonic timestamps
  getMetrics() {
    return {
      pageStats: this.pageStatsCache,
      deviceCapability: this.deviceCapabilityCache,
      featureFlags: { ...this.featureFlags },
      cacheAge: this.pageStatsCache ? performance.now() - this.lastCacheUpdate : null,
      thresholds: { ...this.complexityThresholds }
    };
  }
}

export const heuristicsEngine = new HeuristicsEngine();
export default heuristicsEngine;