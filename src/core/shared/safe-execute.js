// =============================================================================
// Safe Execute: Async Function Wrapper with Timeout and Circuit Breaker
// Provides timeout-enforced execution with automatic retry logic, error
// classification, and circuit breaker pattern. Prevents promise leaks via
// AbortController and implements adaptive backoff for transient failures.
// Dependencies: error-tracking.js, config.js
// =============================================================================

import { errorTracker, ERROR_CODES } from './error-tracking.js';
import { 
  isDebugEnabled, 
  RETRY_CONFIG, 
  CIRCUIT_BREAKER_CONFIG,
  TRANSIENT_ERROR_PATTERNS 
} from './config.js';

const MODULE_DEBUG = false;
const DEBUG = isDebugEnabled(MODULE_DEBUG);

// Circuit breaker states for adaptive failure handling
const CircuitState = {
  CLOSED: 'closed',
  OPEN: 'open',
  HALF_OPEN: 'half_open'
};

// Circuit breaker registry keyed by operation name
// Tracks failure rates and automatically opens circuits on threshold breach
const circuitBreakers = new Map();

// Circuit breaker for preventing cascading failures
// Implements three-state machine: CLOSED -> OPEN -> HALF_OPEN -> CLOSED
class CircuitBreaker {
  constructor(name, options = {}) {
    this.name = name;
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
    this.halfOpenCalls = 0;
    
    this.failureThreshold = options.failureThreshold || CIRCUIT_BREAKER_CONFIG.FAILURE_THRESHOLD;
    this.successThreshold = options.successThreshold || CIRCUIT_BREAKER_CONFIG.SUCCESS_THRESHOLD;
    this.timeout = options.timeout || CIRCUIT_BREAKER_CONFIG.TIMEOUT_MS;
    this.halfOpenMaxCalls = options.halfOpenMaxCalls || CIRCUIT_BREAKER_CONFIG.HALF_OPEN_MAX_CALLS;
  }
  
  // Records successful execution and potentially closes circuit
  // Transitions from HALF_OPEN to CLOSED after success threshold reached
  recordSuccess() {
    this.failureCount = 0;
    
    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount++;
      
      if (this.successCount >= this.successThreshold) {
        this.state = CircuitState.CLOSED;
        this.successCount = 0;
        this.halfOpenCalls = 0;
        
        if (DEBUG) {
          console.debug(`[CircuitBreaker] ${this.name} closed after ${this.successThreshold} successes`);
        }
      }
    }
  }
  
  // Records failure and potentially opens circuit
  // Transitions from CLOSED to OPEN after failure threshold exceeded
  recordFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    this.successCount = 0;
    
    if (this.state === CircuitState.CLOSED && 
        this.failureCount >= this.failureThreshold) {
      this.state = CircuitState.OPEN;
      
      if (DEBUG) {
        console.debug(`[CircuitBreaker] ${this.name} opened after ${this.failureCount} failures`);
      }
    }
  }
  
  // Checks if operation should be allowed through circuit
  // Automatically transitions to HALF_OPEN after timeout period
  canExecute() {
    if (this.state === CircuitState.CLOSED) {
      return true;
    }
    
    if (this.state === CircuitState.OPEN) {
      const now = Date.now();
      
      if (now - this.lastFailureTime >= this.timeout) {
        this.state = CircuitState.HALF_OPEN;
        this.halfOpenCalls = 0;
        
        if (DEBUG) {
          console.debug(`[CircuitBreaker] ${this.name} entered half-open state`);
        }
        
        return true;
      }
      
      return false;
    }
    
    if (this.state === CircuitState.HALF_OPEN) {
      if (this.halfOpenCalls < this.halfOpenMaxCalls) {
        this.halfOpenCalls++;
        return true;
      }
      return false;
    }
    
    return false;
  }
  
  getState() {
    return {
      name: this.name,
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime
    };
  }
}

// Retrieves or creates circuit breaker for given operation name
// Implements singleton pattern per operation for consistent state tracking
function getCircuitBreaker(operationName) {
  if (!CIRCUIT_BREAKER_CONFIG.ENABLED) {
    return null;
  }
  
  if (!circuitBreakers.has(operationName)) {
    circuitBreakers.set(operationName, new CircuitBreaker(operationName));
  }
  
  return circuitBreakers.get(operationName);
}

// Classifies error as transient (retry-worthy) or permanent (fail-fast)
// Uses pattern matching against known transient error signatures
function isTransientError(error) {
  const message = error.message || '';
  return TRANSIENT_ERROR_PATTERNS.some(pattern => pattern.test(message));
}

// Executes async function with timeout enforcement and memory leak prevention
// Uses AbortController to cancel timeout when function completes
export async function safeExecute(asyncFn, fallbackValue, options = {}) {
  const {
    timeout = 100,
    errorCode = ERROR_CODES.ENRICHMENT_SELECTOR_FAILED,
    context = {},
    silent = false,
    operationName = 'anonymous'
  } = options;
  
  const breaker = getCircuitBreaker(operationName);
  
  if (breaker && !breaker.canExecute()) {
    if (DEBUG) {
      console.debug(`[SafeExecute] Circuit open for ${operationName}, returning fallback`);
    }
    return fallbackValue;
  }
  
  const abortController = new AbortController();
  let timeoutId;
  
  try {
    const result = await Promise.race([
      Promise.resolve(asyncFn()),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Timeout after ${timeout}ms`));
        }, timeout);
        
        abortController.signal.addEventListener('abort', () => {
          clearTimeout(timeoutId);
        });
      })
    ]);
    
    abortController.abort();
    
    if (breaker) {
      breaker.recordSuccess();
    }
    
    return result;
    
  } catch (error) {
    abortController.abort();
    
    if (breaker) {
      breaker.recordFailure();
    }
    
    if (!silent) {
      errorTracker.logError(errorCode, `Execution failed: ${error.message}`, {
        ...context,
        timeout,
        operationName,
        error: error.message,
        stack: error.stack
      });
    }
    
    return fallbackValue;
  }
}

// Executes function with intelligent retry logic and exponential backoff
// Only retries transient errors; fails fast on permanent errors
export async function safeExecuteWithRetry(asyncFn, fallbackValue, options = {}) {
  const {
    maxRetries = RETRY_CONFIG.MAX_ATTEMPTS,
    initialDelay = RETRY_CONFIG.BASE_DELAY_MS,
    maxDelay = RETRY_CONFIG.MAX_DELAY_MS,
    backoffMultiplier = RETRY_CONFIG.BACKOFF_MULTIPLIER,
    jitterFactor = RETRY_CONFIG.JITTER_FACTOR,
    errorCode = ERROR_CODES.ENRICHMENT_SELECTOR_FAILED,
    context = {},
    operationName = 'anonymous'
  } = options;
  
  const breaker = getCircuitBreaker(operationName);
  
  if (breaker && !breaker.canExecute()) {
    if (DEBUG) {
      console.debug(`[SafeExecute] Circuit open for ${operationName}, skipping retry`);
    }
    return fallbackValue;
  }
  
  let lastError = null;
  let delay = initialDelay;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await Promise.resolve(asyncFn());
      
      if (breaker) {
        breaker.recordSuccess();
      }
      
      if (DEBUG && attempt > 0) {
        console.debug(`[SafeExecute] ${operationName} succeeded on attempt ${attempt + 1}`);
      }
      
      return result;
      
    } catch (error) {
      lastError = error;
      
      if (!isTransientError(error)) {
        if (DEBUG) {
          console.debug(`[SafeExecute] Permanent error detected: ${error.message}`);
        }
        
        errorTracker.logError(errorCode, `Permanent error: ${error.message}`, {
          ...context,
          operationName,
          attempt,
          error: error.message
        });
        
        if (breaker) {
          breaker.recordFailure();
        }
        
        return fallbackValue;
      }
      
      if (attempt < maxRetries - 1) {
        const jitter = delay * jitterFactor * (Math.random() * 2 - 1);
        const finalDelay = Math.min(delay + jitter, maxDelay);
        
        if (DEBUG) {
          console.debug(`[SafeExecute] Retrying ${operationName} after ${Math.round(finalDelay)}ms (attempt ${attempt + 1}/${maxRetries})`);
        }
        
        await new Promise(resolve => setTimeout(resolve, finalDelay));
        delay *= backoffMultiplier;
      }
    }
  }
  
  if (breaker) {
    breaker.recordFailure();
  }
  
  errorTracker.logError(errorCode, `Failed after ${maxRetries} retries: ${lastError.message}`, {
    ...context,
    operationName,
    maxRetries,
    finalError: lastError.message
  });
  
  return fallbackValue;
}

// Executes multiple async functions in parallel with individual timeouts
// Returns array with successful results and fallback values for failures
export async function safeExecuteAll(asyncFns, fallbackValue, options = {}) {
  const {
    timeout = 100,
    errorCode = ERROR_CODES.ENRICHMENT_SELECTOR_FAILED,
    context = {},
    operationName = 'batch'
  } = options;
  
  const promises = asyncFns.map((fn, index) => 
    safeExecute(fn, fallbackValue, {
      timeout,
      errorCode,
      context: { ...context, index },
      operationName: `${operationName}_${index}`,
      silent: true
    })
  );
  
  return Promise.all(promises);
}

// Retrieves current state of all circuit breakers for monitoring
// Returns map of breaker names to their current state snapshots
export function getCircuitBreakerStates() {
  const states = {};
  
  for (const [name, breaker] of circuitBreakers.entries()) {
    states[name] = breaker.getState();
  }
  
  return states;
}

// Resets all circuit breakers to closed state
// Useful for testing or manual recovery from cascading failures
export function resetCircuitBreakers() {
  circuitBreakers.clear();
  
  if (DEBUG) {
    console.debug('[SafeExecute] All circuit breakers reset');
  }
}