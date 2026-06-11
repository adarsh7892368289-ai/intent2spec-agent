// =============================================================================
// Attribute Profiler: Domain-Specific Attribute Learning for XPath Optimization
//
// Learns and profiles useful attributes per domain to improve XPath generation accuracy.
// Analyzes interactive elements to identify stable, unique attributes for better element targeting.
// Integrates with XPathEngine to provide domain-adaptive attribute prioritization.
// Dependencies: config.js (PROFILER_CONFIG, XPATH_CONFIG, STORAGE_KEYS, isDebugEnabled)
// =============================================================================

import { PROFILER_CONFIG, XPATH_CONFIG, isDebugEnabled } from "./config.js";

const MODULE_DEBUG = true;
const DEBUG = isDebugEnabled(MODULE_DEBUG);

// In-page profile store. The bundle runs inside a Playwright page with no
// persistent storage of its own, so profiles live in memory for the lifetime of
// the page. The main process seeds known profiles via seedProfiles() before a
// scan and harvests freshly learned ones via exportProfiles() afterward; the
// renderer persists them to IndexedDB across sessions (replaces chrome.storage).
let _profiles = Object.create(null);

// Static class for profiling and managing domain-specific attributes.
// Provides methods to learn useful attributes from page elements and merge them with static priorities.
// Used by XPathEngine to improve element targeting accuracy through domain-adaptive attribute selection.
class AttributeProfiler{

    // Seeds the in-memory profile map (called by the host before scanning so
    // previously learned, persisted profiles are available to XPath generation).
    static seedProfiles(profiles){
        if (profiles && typeof profiles === 'object') {
            _profiles = { ...profiles };
        }
    }

    // Returns a shallow copy of the current profile map so the host can persist
    // any profiles learned during this page's lifetime.
    static exportProfiles(){
        return { ..._profiles };
    }

    // Retrieves merged static and learned attributes for a domain.
    // Main entry point called by XPathEngine to get prioritized attributes for XPath generation.
    // Combines static priority attributes with domain-specific learned attributes that meet confidence thresholds.
    static async getMergedAttributes(domain){
        if(!PROFILER_CONFIG.ENABLED){
            return XPATH_CONFIG.STATIC_PRIORITY_ATTRIBUTES;
        }

        try{
            const profile = await this.loadProfile(domain);

            if(!profile || !profile.learned || profile.learned.length === 0){
                if(DEBUG) console.log('[AttributeProfiler] No profile for domain, using static');
                return XPATH_CONFIG.STATIC_PRIORITY_ATTRIBUTES;
            }

            const learnedAttrs = profile.learned
                .map(attr => attr.name);

            const learnedSet = new Set(learnedAttrs);
            const staticFiltered = XPATH_CONFIG.STATIC_PRIORITY_ATTRIBUTES.filter(attr => !learnedSet.has(attr));
            const merged = [...learnedAttrs, ...staticFiltered];

            if(DEBUG) console.log(`[AttributeProfiler] Merged attributes for ${domain}:`,{
                static: XPATH_CONFIG.STATIC_PRIORITY_ATTRIBUTES.length,
                learned: learnedAttrs.length,
                total: merged.length,
                attributes: merged
                
            });

            return merged;

        } catch(error){
            console.error('[AttributeProfiler] Error loading profile:', error);
            return XPATH_CONFIG.STATIC_PRIORITY_ATTRIBUTES;
        }
    }

    // Profiles the current page and updates domain storage with learned attributes.
    // Called via requestIdleCallback after page stabilizes to analyze interactive elements.
    // Samples elements, analyzes their attributes, and saves qualified attributes to storage.
    static async profilePage(domain, deadline){
        if(!PROFILER_CONFIG.ENABLED)return;

        const startTime = performance.now();

        try{
            if(DEBUG) console.log(`[AttributeProfiler] Profiling page for ${domain}`);

            const elements = this.sampleInteractiveElements();

            if(elements.length <10){
                if(DEBUG) console.log('[AttributeProfiler] Not enough elements to profile, skipping');
                return;
            }

            if(deadline && deadline.timeRemaining() < PROFILER_CONFIG.IDLE_DEADLINE_MS){
                if(DEBUG) console.log('[AttributeProfiler] Insufficient idle time, aborting ');
                return;
            }

            const attributeStats = this.analyzeAttributes(elements);

            const qualifiedAttrs = attributeStats
                .filter(stat => stat.uniquenessRate >= PROFILER_CONFIG.MIN_UNIQUENESS_RATE)
                .filter(stat => stat.coverage >= PROFILER_CONFIG.MIN_COVERAGE)
                .sort((a,b) => b.score - a.score)
                .slice(0,15);

            if(qualifiedAttrs.length ===0){
                if(DEBUG) console.log('[AttributeProfiler] No qualified attributes found');
                return;
            }

            await this.updateProfile(domain, qualifiedAttrs);

            const duration = Math.round(performance.now() - startTime);
            if(DEBUG) {
                console.log(`[AttributeProfiler] Profile complete for ${domain}`, {
                    duration: `${duration}ms`,
                    elementAnalyzed: elements.length,
                    attributesFound: attributeStats.length,
                    qualifiedAttributes: qualifiedAttrs.length,
                    topAttributes: qualifiedAttrs.slice(0,5).map(a => a.name)
                });
            }
        } catch(error){
            console.error('[AttributeProfiler] Profiling failed:', error);
        }
    } 

    // Loads the attribute profile for a domain from storage.
    // Checks for profile existence and expiration based on TTL configuration.
    // Returns null if no profile exists or if the profile has expired.
    static async loadProfile(domain){
        try{
            const profile = _profiles[domain];

            if(!profile) return null;

            const age = Date.now() - profile.lastUpdated;
            const maxAge = PROFILER_CONFIG.PROFILE_TTL_DAYS * 24 * 60 * 60 * 1000;

            if (age > maxAge) {
                if (DEBUG) console.log(`[AttributeProfiler] Profile expired for ${domain}`);
                return null;
            }

            return profile;
        } catch (error) {
            console.error('[AttributeProfiler] Load profile error:', error);
            return null;
        }
    }

    // Updates or creates the attribute profile for a domain in storage.
    // Manages profile count limits by evicting oldest profiles if necessary.
    // Stores learned attributes with their metrics for future use.
    static async updateProfile(domain, qualifiedAttrs){
        try {
            if(Object.keys(_profiles).length >= PROFILER_CONFIG.MAX_PROFILES){
                _profiles = this.evictOldestProfiles(_profiles,50);
            }

            _profiles[domain] = {
                learned: qualifiedAttrs.map(attr => ({
                    name: attr.name,
                    uniquenessRate: attr.uniquenessRate,
                    coverage: attr.coverage,
                    temporalScore: attr.temporalScore,
                    frameworkScore: attr.frameworkScore,
                    score: attr.score
                })),
                lastUpdated: Date.now(),
                version: 1
            };

            if(DEBUG) console.log(`[AttributeProfiler] Profile saved for ${domain}`);
        } catch (error) {
            console.error('[AttributeProfiler] Update profile error:', error);
        }
    }

    // Evicts the oldest profiles to maintain storage limits.
    // Removes the least recently updated profiles when maximum domain count is exceeded.
    // Ensures efficient storage management by keeping only the most recent profiles.
    static evictOldestProfiles(profiles, count){
        const entries = Object.entries(profiles);

        entries.sort((a,b) => a[1].lastUpdated - b[1].lastUpdated);

        const kept = entries.slice(count);

        return Object.fromEntries(kept);
    }

    // Samples interactive elements from the current page for attribute analysis.
    // Selects elements that are likely to be interactive based on common selectors.
    // Filters for visible elements and randomly samples up to the configured sample size.
    static sampleInteractiveElements(){
        const selectors = [
            'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea',
            '[role="button"]', '[role="link"]', '[onclick]',
            '[data-testid]', '[data-test]', '[data-qa]',
            
            //framework-specific selectors
            'lightning-button', 'lightning-input', 'lightning-combobox',
            '[lwc-host]', '[ng-reflect-name]', '[v-bind]',
            '[aria-controls]', '[aria-describedby]'
        ].join(',');

        const allElements = Array.from(document.querySelectorAll(selectors));

        const targetSampleSize = Math.min(
            PROFILER_CONFIG.MAX_SAMPLE_SIZE,
            Math.max(
                PROFILER_CONFIG.MIN_SAMPLE_SIZE,
                Math.floor(allElements.length * PROFILER_CONFIG.SAMPLE_PERCENTAGE)
            )
        );

        const visibleElements = allElements.filter(el => {
            const rect = el.getBoundingClientRect();
            const computedStyle = window.getComputedStyle(el);

            const hasSize = rect.width >= PROFILER_CONFIG.MIN_INTERACTIVE_SIZE && rect.height >= PROFILER_CONFIG.MIN_INTERACTIVE_SIZE;
            const notHIdden = computedStyle.display !== 'none' && computedStyle.visibility !== 'hidden';

            return hasSize || notHIdden;
        });

        const sampled = this.stratifiedSample(visibleElements, targetSampleSize);

        if(DEBUG) console.log('[AttributeProfiler] Sampled elements:', {
            total: allElements.length,
            visible: visibleElements.length,
            targetsample: targetSampleSize,
            actualsampled: sampled.length
        });

        return sampled;
    }

    static stratifiedSample(elements, targetSize){
        if (elements.length <= targetSize) return elements;

        const buckets = new Map();

        for (const el of elements) {
            let bucketKey = el.tagName.toLowerCase();

            if (bucketKey.startsWith('lightning-')) bucketKey = 'lightning-component';
            else if (el.hasAttribute('lwc-host')) bucketKey = 'lwc-component';
            else if (el.hasAttribute('ng-reflect-name')) bucketKey = 'angular-component';
            else if (el.hasAttribute('v-bind')) bucketKey = 'vue-component';

            if (!buckets.has(bucketKey)) buckets.set(bucketKey, []);
            buckets.get(bucketKey).push(el);
        }

        const sampled = [];
        const bucketEntries = Array.from(buckets.entries());

        for (const [key, bucket] of bucketEntries) {
            const proportion = bucket.length / elements.length;
            let bucketSampleSize = Math.max(1, Math.floor(proportion * targetSize));

            if(key.includes('component')){
                bucketSampleSize = Math.min(bucket.length, bucketSampleSize * 2);
            }

            const bucketSample = this.randomSample(bucket, Math.min(bucketSampleSize, bucket.length));
            sampled.push(...bucketSample);
        }

        if (sampled.length < targetSize) {
            const sampledSet = new Set(sampled);
            const remaining = elements.filter(el => !sampledSet.has(el));
            const additionalSample = this.randomSample(remaining, targetSize - sampled.length);
            sampled.push(...additionalSample);
        }

        if(DEBUG) {
            const bucketSummary = bucketEntries.map(([key, bucket]) => ({
                type: key,
                total: bucket.length,
                sampled: sampled.filter(el => {
                    let elKey = el.tagName.toLowerCase();
                    if (elKey.startsWith('lightning-')) elKey = 'lightning-component';
                    else if (el.hasAttribute('lwc-host')) elKey = 'lwc-component';
                    else if (el.hasAttribute('ng-reflect-name')) elKey = 'angular-component';
                    return elKey === key;
                }).length
            }));
            console.log('[AttributeProfiler] Stratified sample:', bucketSummary);
        }

        return sampled.slice(0, targetSize);
    }

    // Analyzes attributes of sampled elements to compute statistical metrics.
    // Calculates uniqueness rate, coverage, and scores for each attribute.
    // Filters to only analyzable attributes and computes confidence scores.
    static analyzeAttributes(elements){
        const stats = new Map();

        for (const el of elements){
            for (const attr of el.attributes){
                const attrName = attr.name;

                if(!this.isAnalyzableAttribute(attrName)) continue;
                if(!stats.has(attrName)) {
                    stats.set(attrName, {
                        name: attrName, 
                        appearanceCount: 0,
                        uniqueValues: new Set(),
                        elements: []
                    });
                }

                const stat = stats.get(attrName);
                stat.appearanceCount++;
                stat.uniqueValues.add(attr.value);
                stat.elements.push(el);
            }
        }

        const totalElements = elements.length;

        const attributeStats = Array.from(stats.values()).map(stat => {
            const uniquenessRate = stat.uniqueValues.size / stat.appearanceCount;
            const coverage = stat.elements.length / totalElements

            const temporalScore = this.assessTemporalStability(stat.name);
            const frameworkScore = this.assessFrameworkInvariance(stat.name);

            const score = (uniquenessRate * 0.6 + temporalScore * 0.2 + frameworkScore *0.15 + coverage * 0.05);

            return{
                name: stat.name,
                uniquenessRate,
                coverage,
                temporalScore,
                frameworkScore,
                score,
                appearances: stat.appearanceCount,
                uniqueValues: stat.uniqueValues.size
            };
        });

        const qualifiedAttrs = attributeStats
                .filter(stat => stat.uniquenessRate >= PROFILER_CONFIG.MIN_UNIQUENESS_RATE)
                .filter(stat => stat.coverage >= PROFILER_CONFIG.MIN_COVERAGE)
                .sort((a,b) => b.score - a.score)
                .slice(0,15);

        if (DEBUG) {
            const rejected = attributeStats.filter(stat => 
                stat.uniquenessRate < PROFILER_CONFIG.MIN_UNIQUENESS_RATE ||
                stat.coverage < PROFILER_CONFIG.MIN_COVERAGE
            );
            
            console.log('[AttributeProfiler] Rejection breakdown:', {
                total: attributeStats.length,
                qualified: qualifiedAttrs.length,
                rejected: rejected.length,
                rejectionReasons: rejected.map(stat => ({
                    name: stat.name,
                    uniqueness: stat.uniquenessRate.toFixed(2),
                    coverage: stat.coverage.toFixed(2),
                    failedUniqueness: stat.uniquenessRate < PROFILER_CONFIG.MIN_UNIQUENESS_RATE,
                    failedCoverage: stat.coverage < PROFILER_CONFIG.MIN_COVERAGE
                }))
            });
        }

        return attributeStats;
    }

    // Determines if an attribute name is suitable for analysis and profiling.
    // Considers data attributes and semantic HTML attributes as analyzable.
    // Filters out attributes that are not useful for element identification.
    static isAnalyzableAttribute(attrName){

        if (attrName.startsWith('data-')) return true;

        const frameworkPrefixes = ['lwc-', 'ng-', 'v', '_ngcontent-','_nghost-'];
        if (frameworkPrefixes.some(prefix => attrName.startsWith(prefix))) return true;

        if (attrName.startsWith('aria-')) return true;

        const semanticAttrs = ['id', 'name', 'class', 'aria-label', 'aria-labelledby', 'for', 'role'];
        if (semanticAttrs.includes(attrName)) return true;

        const rejectPatterns = [
            /^on[a-z]+$/i,        
            /^style$/i,           
            /^class$/i,           
            /^xmlns/i,            
            /^tabindex$/i,        
            /^draggable$/i,
            /^contenteditable$/i
        ];

        if(rejectPatterns.some(pattern => pattern.test(attrName))){
            return false;
        }
        
        return false;
    }


    // Assesses the temporal stability of an attribute name.
    // Returns a score indicating how likely the attribute is to remain stable over time.
    // Lower scores for attributes that contain patterns suggesting dynamic content.
    static assessTemporalStability(attrName){

        const unstablePatterns = [
            /session/i,
            /timestamp/i,
            /nonce/i,
            /temp/i,
            /random/i,
            /dynamic/i,
            /uid-\d+/,       
            /^ember\d+$/,
            /^react\d+$/,
            /rendered/i,
            /cache/i
        ];
            
        if (unstablePatterns.some(pattern => pattern.test(attrName))) {
            return 0.2;
        }

        return 0.9;
    }

    // Assesses the framework invariance of an attribute name.
    // Returns a score indicating how likely the attribute is to be framework-independent.
    // Lower scores for attributes that are generated by specific JavaScript frameworks.
    static assessFrameworkInvariance(attrName) {

        const stableFrameworkPatterns = [
            /^data-aura-rendered-by$/,
            /^data-aura-class$/,
            /^lwc-[a-z0-9-]+$/i,
            /^ng-reflect-[a-z-]+$/i,
            /^v-[a-z0-9-]+$/i
        ];

        if (stableFrameworkPatterns.some(pattern => pattern.test(attrName))) {
            return 1.0;
        }

        const unstableFrameworkPatterns = [
            /^data-reactid$/,     
            /^data-reactroot$/,   
            /^_ngcontent-[a-z]+-\d+$/,  
            /^_nghost-[a-z]+-\d+$/
        ];

        if (unstableFrameworkPatterns.some(pattern => pattern.test(attrName))) {
            return 0.1;
        }

        if(attrName.startsWith('data-') || attrName.startsWith('aria-')){
            return 0.8;
        }

        return 0.9;
    }
}

export default AttributeProfiler;