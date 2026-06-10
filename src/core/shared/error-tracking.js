// =============================================================================
// Error Tracking: Centralized Observability Framework
// Provides structured error logging with deduplication, metrics capping, and
// event broadcasting for UI consumption. Implements LRU eviction for bounded
// memory usage and intelligent error aggregation.
// Dependencies: config.js for debug flags and limits
// =============================================================================

import { ERROR_TRACKING_CONFIG, isDebugEnabled } from './config.js';

const MODULE_DEBUG = false;
const DEBUG = isDebugEnabled(MODULE_DEBUG);

export const ERROR_CODES = {
  ENRICHMENT_DETACHED: 'enrichment_detached_element',
  ENRICHMENT_TIMEOUT: 'enrichment_timeout_exceeded',
  ENRICHMENT_INVALID_ELEMENT: 'enrichment_invalid_element',
  ENRICHMENT_SELECTOR_FAILED: 'enrichment_selector_generation_failed',
  
  FRAME_HANDSHAKE_TIMEOUT: 'frame_handshake_timeout',
  FRAME_HANDSHAKE_SEQUENCE_MISMATCH: 'frame_handshake_sequence_mismatch',
  FRAME_ORPHANED: 'frame_orphaned_no_parent',
  FRAME_CROSS_ORIGIN_FAILED: 'frame_cross_origin_message_failed',
  
  STORAGE_QUOTA_EXCEEDED: 'storage_quota_exceeded',
  STORAGE_WRITE_FAILED: 'storage_write_failed',
  STORAGE_READ_FAILED: 'storage_read_failed',
  STORAGE_LOCK_TIMEOUT: 'storage_optimistic_lock_timeout',
  
  XPATH_GENERATION_FAILED: 'xpath_generation_failed',
  CSS_GENERATION_FAILED: 'css_generation_failed',
  XPATH_VALIDATION_FAILED: 'xpath_validation_failed',
  
  STATE_TRACKING_PAUSED: 'state_tracking_paused',
  STATE_INVALID_MODE: 'state_invalid_tracking_mode',
  STATE_PERSISTENCE_FAILED: 'state_persistence_failed'
};

// Structured error object preserving stack traces and context
// Provides JSON serialization for telemetry and logging
export class TrackerError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.name = 'TrackerError';
    this.code = code;
    this.context = context;
    this.timestamp = Date.now();
    
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, TrackerError);
    }
  }
  
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      context: this.context,
      timestamp: this.timestamp,
      stack: this.stack
    };
  }
}

// Central error aggregation with bounded memory and deduplication
// Implements LRU eviction for metrics maps and recent error caching
export class ErrorTracker {
  constructor() {
    this.errors = [];
    this.maxErrorHistory = ERROR_TRACKING_CONFIG.MAX_ERROR_HISTORY;
    this.maxErrorsByCode = ERROR_TRACKING_CONFIG.MAX_ERRORS_BY_CODE;
    this.maxErrorsBySession = ERROR_TRACKING_CONFIG.MAX_ERRORS_BY_SESSION;
    this.dedupeWindowMs = ERROR_TRACKING_CONFIG.DEDUPLICATION_WINDOW_MS;
    this.maxDedupeCacheSize = ERROR_TRACKING_CONFIG.MAX_DEDUPE_CACHE_SIZE;
    
    this.metrics = {
      totalErrors: 0,
      errorsByCode: {},
      errorsBySession: {},
      deduplicatedCount: 0
    };
    
    this.recentErrorHashes = new Map();
  }
  
  // Logs error with deduplication, bounded metrics, and event broadcasting
  // Implements LRU eviction when metrics maps exceed size limits
  logError(code, message, context = {}) {
    const errorHash = this._generateErrorHash(code, message, context);
    
    if (this._isDuplicate(errorHash)) {
      this.metrics.deduplicatedCount++;
      
      if (DEBUG) {
        console.debug(`[ErrorTracker] Deduplicated error: ${code}`);
      }
      
      return null;
    }
    
    const error = new TrackerError(code, message, context);
    
    this.errors.push({
      code,
      message,
      context,
      timestamp: error.timestamp
    });
    
    if (this.errors.length > this.maxErrorHistory) {
      this.errors.shift();
    }
    
    this.metrics.totalErrors++;
    
    this._updateErrorsByCode(code);
    
    if (context.sessionId) {
      this._updateErrorsBySession(context.sessionId);
    }
    
    this._trackForDeduplication(errorHash);
    
    this._broadcastError(code, message, context, error.timestamp);
    
    if (DEBUG) {
      console.error(`[ErrorTracker] ${code}: ${message}`, context);
    }
    
    return error;
  }
  
  // Updates errorsByCode map with LRU eviction when limit exceeded
  // Removes lowest count entry to maintain bounded memory usage
  _updateErrorsByCode(code) {
    if (Object.keys(this.metrics.errorsByCode).length >= this.maxErrorsByCode && 
        !this.metrics.errorsByCode[code]) {
      const entries = Object.entries(this.metrics.errorsByCode);
      entries.sort((a, b) => a[1] - b[1]);
      delete this.metrics.errorsByCode[entries[0][0]];
      
      if (DEBUG) {
        console.debug(`[ErrorTracker] Evicted error code: ${entries[0][0]}`);
      }
    }
    
    this.metrics.errorsByCode[code] = (this.metrics.errorsByCode[code] || 0) + 1;
  }
  
  // Updates errorsBySession map with LRU eviction when limit exceeded
  // Removes oldest session entry to prevent unbounded growth
  _updateErrorsBySession(sessionId) {
    if (Object.keys(this.metrics.errorsBySession).length >= this.maxErrorsBySession && 
        !this.metrics.errorsBySession[sessionId]) {
      const sessions = Object.keys(this.metrics.errorsBySession);
      delete this.metrics.errorsBySession[sessions[0]];
      
      if (DEBUG) {
        console.debug(`[ErrorTracker] Evicted session: ${sessions[0]}`);
      }
    }
    
    this.metrics.errorsBySession[sessionId] = 
      (this.metrics.errorsBySession[sessionId] || 0) + 1;
  }
  
  // Generates stable hash for error deduplication
  // Combines code, message, and key context fields for uniqueness
  _generateErrorHash(code, message, context) {
    const contextKey = JSON.stringify({
      elementId: context.elementId,
      sessionId: context.sessionId,
      url: context.url
    });
    return `${code}:${message}:${contextKey}`;
  }
  
  // Checks if error occurred recently within deduplication window
  // Returns true if duplicate, false if novel error
  _isDuplicate(errorHash) {
    const now = Date.now();
    const lastSeen = this.recentErrorHashes.get(errorHash);
    
    if (lastSeen && (now - lastSeen) < this.dedupeWindowMs) {
      return true;
    }
    
    return false;
  }
  
  // Tracks error hash with timestamp for deduplication
  // Implements bounded cache with LRU eviction
  _trackForDeduplication(errorHash) {
    const now = Date.now();
    
    if (this.recentErrorHashes.size >= this.maxDedupeCacheSize) {
      const oldestKey = this.recentErrorHashes.keys().next().value;
      this.recentErrorHashes.delete(oldestKey);
    }
    
    this.recentErrorHashes.set(errorHash, now);
    
    this._cleanupStaleHashes();
  }
  
  // Removes stale entries from deduplication cache
  // Prevents memory accumulation from old error hashes
  _cleanupStaleHashes() {
    const now = Date.now();
    const cutoff = now - this.dedupeWindowMs;
    
    for (const [hash, timestamp] of this.recentErrorHashes.entries()) {
      if (timestamp < cutoff) {
        this.recentErrorHashes.delete(hash);
      }
    }
  }
  
  // Broadcasts error event with fallback to console if CustomEvent fails
  // Ensures errors are always logged even in restricted contexts
  _broadcastError(code, message, context, timestamp) {
    try {
      if (typeof window !== 'undefined' && window.dispatchEvent) {
        window.dispatchEvent(new CustomEvent('tracker-error', {
          detail: { code, message, context, timestamp }
        }));
      }
    } catch (e) {
      if (DEBUG) console.error(`[ErrorTracker] Failed to broadcast event: ${code}`, {
        message,
        context,
        broadcastError: e.message
      });
    }
  }
  
  // Retrieves immutable metrics snapshot for telemetry
  // Returns defensive copies to prevent external mutation
  getMetrics() {
    return {
      totalErrors: this.metrics.totalErrors,
      deduplicatedCount: this.metrics.deduplicatedCount,
      errorsByCode: { ...this.metrics.errorsByCode },
      errorsBySession: { ...this.metrics.errorsBySession },
      recentErrors: this.errors.slice(-10).map(e => ({ ...e })),
      timestamp: Date.now()
    };
  }
  
  // Retrieves all errors matching specific error code
  // Returns shallow copy to prevent external mutation of history
  getErrorsByCode(code) {
    return this.errors.filter(e => e.code === code).map(e => ({ ...e }));
  }
  
  // Retrieves all errors for specific session identifier
  // Returns shallow copy with defensive cloning
  getErrorsBySession(sessionId) {
    return this.errors
      .filter(e => e.context?.sessionId === sessionId)
      .map(e => ({ ...e }));
  }
  
  // Clears error history and resets all metrics to zero
  // Preserves error code structure for consistent telemetry schema
  clear() {
    this.errors = [];
    this.recentErrorHashes.clear();
    
    const codes = Object.keys(this.metrics.errorsByCode);
    this.metrics = {
      totalErrors: 0,
      deduplicatedCount: 0,
      errorsByCode: Object.fromEntries(codes.map(c => [c, 0])),
      errorsBySession: {}
    };
    
    if (DEBUG) {
      console.debug('[ErrorTracker] Cleared all error history and metrics');
    }
  }
}

export const errorTracker = new ErrorTracker();