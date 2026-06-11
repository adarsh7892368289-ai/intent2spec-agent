// =============================================================================
// Configuration Constants: Centralized System Configuration
//
// Single source of truth for feature flags, timeout limits, and behavioral settings.
// Provides global debug control with per-module override capability.
// Adaptive behavior configured via ENRICHMENT_CONFIG with HeuristicsEngine integration.
// Dependencies: None (root configuration module)
// =============================================================================

// Global debug flag: enables logging across all modules
// Individual modules can override with local DEBUG constants
export const GLOBAL_DEBUG = false;

// Helper function for modules to check debug status
// Returns true if either global or module-level debug enabled
export const isDebugEnabled = (moduleDebug = false) => {
  return GLOBAL_DEBUG || moduleDebug;
};

export const TRACKING_MODES = {
  INTERACTIONS: 'interactions',
  FULL_PAGE: 'full_page',
  HYBRID: 'hybrid'
};

export const MESSAGE_TYPES = {
  GET_SESSION: 'GET_SESSION',
  MODE_CHANGED: 'MODE_CHANGED',
  GET_MODE: 'GET_MODE',
  TOGGLE_TRACKING_STATE: 'TOGGLE_TRACKING_STATE',
  TRACKING_STATE_CHANGED: 'TRACKING_STATE_CHANGED',
  INTERACTION: 'INTERACTION',
  ELEMENT_CAPTURED: 'ELEMENT_CAPTURED',
  PAGE_SCAN: 'PAGE_SCAN',
  START_PAGE_SCAN: 'START_PAGE_SCAN',
  BATCH_SAVE: 'BATCH_SAVE',
  GET_INTERACTIONS: 'GET_INTERACTIONS',
  GET_ELEMENTS: 'GET_ELEMENTS',
  GET_PAGE_SCANS: 'GET_PAGE_SCANS',
  GET_STATS: 'GET_STATS',
  GET_SETTINGS: 'GET_SETTINGS',
  UPDATE_SETTINGS: 'UPDATE_SETTINGS',
  EXPORT_DATA: 'EXPORT_DATA',
  CLEAR_DATA: 'CLEAR_DATA',
  CLEAR_INTERACTIONS: 'CLEAR_INTERACTIONS',
  CLEAR_PAGE_SCANS: 'CLEAR_PAGE_SCANS',
  CLEAR_BY_MODE: 'CLEAR_BY_MODE',
  CLEAR_ALL_MODES: 'CLEAR_ALL_MODES',
  COMPRESS_DATA: 'COMPRESS_DATA',
  GET_MEMORY_USAGE: 'GET_MEMORY_USAGE'
};

export const MODE_DISPLAY_NAMES = {
  [TRACKING_MODES.INTERACTIONS]: 'Interactions',
  [TRACKING_MODES.FULL_PAGE]: 'Element Scan',
  [TRACKING_MODES.HYBRID]: 'Hybrid'
};

export const STORAGE_KEYS = {
  INTERACTIONS_ELEMENTS: 'interactions_elements',
  FULLPAGE_ELEMENTS: 'fullpage_elements',
  HYBRID_ELEMENTS: 'hybrid_elements',
  
  INTERACTIONS_STATS: 'interactions_stats',
  FULLPAGE_STATS: 'fullpage_stats',
  HYBRID_STATS: 'hybrid_stats',
  
  SESSIONS: 'sessions',
  SETTINGS: 'settings',
  API_KEY: 'apiKey',
  SEQUENCE_COUNTER: 'sequenceCounter',
  
  SESSION_MAP: 'active_sessions_map',
  INJECTED_FRAMES: 'injected_frames_set',
  TRACKING_STATE: 'trackingState',

  DOMAIN_PROFILES: 'domain_attribute_profiles',
  DOMAIN_PROFILES_VERSION: 'domain_profiles_v1'
};

export const DEFAULT_SETTINGS = {
  trackingMode: TRACKING_MODES.INTERACTIONS,
  scanFilters: [],
  
  captureClicks: true,          
  captureInputs: true,          
  captureForms: true,           
  captureNavigation: true,      
  captureScroll: true,          
  
  scrollThrottle: 500,
  inputDebounce: 500,
  
  enableDeduplication: true,
  capturePasswordFields: false,
  captureFileInputs: true,
  captureOnBlur: true,
  captureOnChange: true
};

export const PERFORMANCE = {
  BATCH_SIZE: 20,
  BATCH_INTERVAL: 2000,
  COMPRESSION_THRESHOLD: 1000,
  MEMORY_CHECK_INTERVAL: 30000
};

export const MEMORY_ZONES = {
  GREEN: { limit: 0.5, color: '#4caf50', label: 'Normal' },
  YELLOW: { limit: 0.8, color: '#ff9800', label: 'Warning' },
  ORANGE: { limit: 0.9, color: '#ff5722', label: 'Critical' },
  RED: { limit: 1.0, color: '#f44336', label: 'Full' }
};

export const STORAGE_LIMITS = {
  QUOTA_BYTES: 52428800,
  WARNING_THRESHOLD: 0.8,
  CRITICAL_THRESHOLD: 0.9,
  VERSION_RESET_THRESHOLD: 1000000000
};

export const IGNORED_ELEMENTS = [
  'script',
  'style',
  'noscript',
  'meta',
  'link[rel="stylesheet"]',
  'link[rel="icon"]'
];

export const EXPORT_FORMATS = {
  JSON: 'json',
  CSV: 'csv'
};

export const CSV_EXPORT_CONFIG = {
  allowedEventTypes: ['input', 'click']
};

export const INPUT_CAPTURE_CONFIG = {
  DEBOUNCE_DELAY: 500,
  CAPTURE_ON_BLUR: true,
  CAPTURE_ON_CHANGE: true,
  CAPTURE_PASSWORD_VALUES: true,
  CAPTURE_FILE_NAMES: true,
  ENABLE_VALUE_DEDUPLICATION: true,
  MAX_VALUE_LENGTH: 10000,
  MAX_ACTIVE_INPUTS: 100,

  IGNORED_INPUT_TYPES: [
    'hidden',
    'submit',
    'reset',
    'button'
  ]
};

export const NAVIGATION_CAPTURE_CONFIG = {
  CAPTURE_PAGE_LOAD: true,
  CAPTURE_HISTORY_CHANGES: true,
  CAPTURE_HASH_CHANGES: true,
  CAPTURE_POPSTATE: true,
  CAPTURE_ON_INPUT_BLUR: true,
  CLEAR_INPUT_CACHE_ON_NAVIGATION: true
};

export const SCROLL_CAPTURE_CONFIG = {
  THROTTLE_DELAY: 500,
  CAPTURE_DIRECTION: true,
  CAPTURE_PERCENTAGE: true,
  MIN_SCROLL_DISTANCE: 50
};

export const FORM_CAPTURE_CONFIG = {
  CAPTURE_FIELD_VALUES: true,
  CAPTURE_EMPTY_FORMS: false,
  MASK_PASSWORDS: true,
  CAPTURE_FILE_NAMES: true,
  DEDUPLICATION_WINDOW_MS: 1000
};

export const XPATH_CONFIG = {
  STRATEGIES: {
    TIER_0: ['exactVisibleText'],
    TIER_1: ['testAttributes'],
    TIER_2: ['stableId'],
    TIER_3: ['visibleTextNormalized'],
    TIER_4: ['precedingContext'],
    TIER_5: ['descendantContext'],
    TIER_6: ['attrTextCombo'],
    TIER_7: ['followingContext'],
    TIER_8: ['frameworkAttrs'],
    TIER_9: ['multiAttrFingerprint'],
    TIER_10: ['ariaRoleLabel'],
    TIER_11: ['labelAssociation'],
    TIER_12: ['partialTextMatch'],
    TIER_13: ['hrefPattern'],
    TIER_14: ['parentChildAxes'],
    TIER_15: ['siblingAxes'],
    TIER_16: ['semanticAncestor'],
    TIER_17: ['classAttrCombo'],
    TIER_18: ['ancestorChain'],
    TIER_19: ['tableRowContext'],
    TIER_20: ['svgVisualFingerprint'],
    TIER_21: ['spatialTextContext'],
    TIER_22: ['guaranteedPath']
  },
  EXECUTION_MODE: 'parallel',
  MAX_FALLBACKS: 2,

  STATIC_PRIORITY_ATTRIBUTES: [
    'data-testid', 'data-test', 'data-qa', 'data-cy', 'data-automation-id',
    'id', 'name', 'aria-label', 'aria-labelledby', 'for'
  ],
  
  SEMANTIC_TAGS: [
    'form', 'nav', 'header', 'footer', 'main', 'section', 'article',
    'aside', 'dialog', 'table', 'fieldset', 'figure'
  ]
};

export const PROFILER_CONFIG = {
  ENABLED: true,

  MIN_SAMPLE_SIZE: 100, 
  MAX_SAMPLE_SIZE: 1000, 
  SAMPLE_PERCENTAGE: 0.2,
  MIN_INTERACTIVE_SIZE: 10,

  MIN_UNIQUENESS_RATE: 0.8,
  MIN_COVERAGE: 0.03,

  MAX_PROFILES: 500,
  PROFILE_TTL_DAYS: 7,

  IDLE_TIMEOUT_MS: 3000,
  IDLE_DEADLINE_MS: 200,

  // EMA for confidence updates (future use)
  EMA_NEW_WEIGHT: 0.2,
  EMA_HISTORICAL_WEIGHT: 0.8,

  TRIGGER_ON_PAGE_IDLE: true, 
  TRIGGER_ON_FULL_PAGE_SCAN: true
};



export const CSS_CONFIG = {
  STRATEGIES: [
    'id-selector',
    'data-attributes',
    'combined-attributes',
    'class-attribute',
    'parent-child',
    'pseudo-classes'
  ],
  TIMEOUT: 20
};

// Enrichment configuration with adaptive timeout/concurrency integration
// Base values used by HeuristicsEngine for adaptive scaling
export const ENRICHMENT_CONFIG = {
  MAX_ENRICHMENT_TIME: 100,
  PARALLEL_TIMEOUT: 50,
  MAX_BATCH_TIME: 60000,
  BATCH_CONCURRENCY: 15,
  SKIP_INVISIBLE_IN_INTERACTIONS: true,
  INCLUDE_INVISIBLE_IN_SCANS: false,
  ENABLE_COMPRESSION: true,
  ENABLE_PERFORMANCE_TRACKING: false,
  ENABLE_PAGE_CONTEXT_CACHE: true,
  CACHE_EXPIRY_MS: 60000,
  MAX_PARENTS: 3,
  MAX_LABEL_LENGTH: 100,
  MAX_CLASSES_PER_ELEMENT: 2
};

// Streaming configuration for progressive result delivery
// CHUNK_SIZE removed: use heuristicsEngine.computeBatchConcurrency() instead
export const STREAMING_CONFIG = {
  ENABLED: true,
  USE_IDLE_CALLBACK: true,
  IDLE_CALLBACK_TIMEOUT: 1000,
  PARTIAL_RESULT_EVENTS: true
};

export const IFRAME_BACKOFF_CONFIG = {
  ENABLED: true,
  DEBOUNCE_MS: 200,
  BATCH_THRESHOLD: 50,
  MAX_BACKOFF_EXPONENT: 3,
  BASE_MULTIPLIER: 2
};

export const LABEL_CACHE_CONFIG = {
  ENABLED: true,
  MAX_SIZE: 500,
  EVICTION_POLICY: 'LRU'
};

export const CONTEXT_CONFIG = {
  ENABLED: true,
  SEARCH_RADIUS: 400,
  MAX_ELEMENTS: 4,
  MAX_PARENT_DEPTH: 7,
  GENERATE_XPATH: false,
  XPATH_TIMEOUT_MS: 20,
  XPATH_TIERS: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
  ENABLE_TABLE_AWARENESS: true,
  SAME_ROW_PRIORITY_BOOST: 500,
  INTERACTIVE_ELEMENTS: [
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    'label',
    '[data-testid]',
    '[data-qa]',
    '[data-test]',
    '[role="button"]',
    '[role="link"]',
    '[onclick]'
  ],
  ELEMENT_PRIORITY: {
    'data-testid': 100,
    'stable-id': 95,
    'a[href]': 90,
    '[data-*]': 80,
    'aria': 75,
    'name': 70,
    'text': 60,
    'button': 50,
    'input': 45
  }
};

export const FRAME_CHANNEL_CONFIG = {
  MIN_INTERACTIVE_WIDTH: 20,
  MIN_INTERACTIVE_HEIGHT: 20,
  MAX_HANDSHAKE_RETRIES: 5,
  CONNECTION_TIMEOUT: 8000,
  PING_INTERVAL: 15000,
  PONG_TIMEOUT: 10000,
  MAX_MISSED_PONGS: 5
};

export const SESSION_CONFIG = {
  TTL_MS: 24 * 60 * 60 * 1000,
  CLEANUP_INTERVAL_MS: 60 * 60 * 1000
};

export const ERROR_TRACKING_CONFIG = {
  MAX_ERROR_HISTORY: 1000,
  MAX_ERRORS_BY_CODE: 100,
  MAX_ERRORS_BY_SESSION: 1000,
  DEDUPLICATION_WINDOW_MS: 5000,
  MAX_DEDUPE_CACHE_SIZE: 100
};

export const RETRY_CONFIG = {
  MAX_ATTEMPTS: 5,
  BASE_DELAY_MS: 50,
  MAX_DELAY_MS: 5000,
  JITTER_FACTOR: 0.3,
  BACKOFF_MULTIPLIER: 2
};

export const CIRCUIT_BREAKER_CONFIG = {
  ENABLED: true,
  FAILURE_THRESHOLD: 5,
  SUCCESS_THRESHOLD: 2,
  TIMEOUT_MS: 60000,
  HALF_OPEN_MAX_CALLS: 3
};

export const TRANSIENT_ERROR_PATTERNS = [
  /timeout/i,
  /network/i,
  /fetch.*failed/i,
  /temporarily unavailable/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /temporarily locked/i,
  /rate limit/i
];