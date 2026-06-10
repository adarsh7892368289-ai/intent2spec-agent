// ===========================================================================
// XPath Strategies: 22-Strategy Tier-Based Generation Collection
// Stateless strategy implementations organized by stability (0=most, 22=least).
// Follows Single Responsibility Principle for each strategy.
// Dependencies: text-utils, xpath-utils, dom-utils for utilities
// ===========================================================================

import { isDebugEnabled } from '../shared/config.js';
import { getDataAttributes } from '../helpers/dom-utils.js';
import { cleanText } from '../helpers/text-utils.js';
import { escapeXPath } from '../helpers/xpath-utils.js';

const MODULE_DEBUG = false;
const DEBUG = isDebugEnabled(MODULE_DEBUG);

class XPathStrategies {
  
  // Tier 0: Exact visible text match (highest stability for static text elements)
  // Contract: Returns empty if text >150 chars or dynamic; filters non-static text via isStaticText
  static strategyExactVisibleText(element, tag) {
    const results = [];
    const visibleText = cleanText(element.textContent);
    
    if (!visibleText || visibleText.length === 0 || visibleText.length > 150) return results;
    if (!this.isStaticText(visibleText)) return results;
    
    results.push({
      xpath: `//${tag}[text()=${escapeXPath(visibleText)}]`,
      strategy: 'exact-text',
      robustness: 99
    });
    
    return results;
  }

  // Tier 1: Test automation attributes (data-testid, data-qa, etc)
  // Contract: Prioritizes data-key/data-record-id with robustness 100, other test attrs 98
  static strategyTestAttributes(element, tag) {
    const results = [];
    const testAttrs = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'data-automation-id', 
                       'data-key', 'data-record-id', 'data-component-id', 'data-row-key-value'];
    
    for (const attr of testAttrs) {
      const value = element.getAttribute(attr);
      if (value && this.isStableValue(value)) {
        results.push({
          xpath: `//${tag}[@${attr}=${escapeXPath(value)}]`,
          strategy: `test-attr-${attr}`,
          robustness: attr.startsWith('data-key') || attr.startsWith('data-record') ? 100 : 98
        });
      }
    }
    return results;
  }

  // Tier 2: Stable ID attribute (not auto-generated or dynamic)
  // Contract: Filters IDs via isStableId pattern matching; robustness 95
  static strategyStableId(element, tag) {
    const results = [];
    const id = element.id;
    
    if (id && this.isStableId(id)) {
      results.push({
        xpath: `//${tag}[@id=${escapeXPath(id)}]`,
        strategy: 'stable-id',
        robustness: 95
      });
    }
    return results;
  }

  // Tier 3: Normalized visible text (whitespace-trimmed)
  // Contract: Uses normalize-space() XPath function; filters non-static text
  static strategyVisibleTextNormalized(element, tag) {
    const results = [];
    const visibleText = cleanText(element.textContent);
    
    if (!visibleText || visibleText.length === 0 || visibleText.length > 150) return results;
    if (!this.isStaticText(visibleText)) return results;
    
    results.push({
      xpath: `//${tag}[normalize-space()=${escapeXPath(visibleText)}]`,
      strategy: 'normalized-text',
      robustness: 94
    });
    
    return results;
  }

  // Tier 4: Preceding sibling with stable attribute as anchor
  // Contract: Searches up to 3 preceding siblings; generates following-sibling axis paths; includes fallback for elements without attrs
  static async strategyPrecedingContext(element, tag, getBestAttributeFn, collectStableAttributesFn, getUniversalTagFn) {
    const results = [];
    let sibling = element.previousElementSibling;
    let depth = 0;

    while (sibling && depth < 3) {
      const siblingAttr = await getBestAttributeFn(sibling);
      if (siblingAttr) {
        const siblingTag = getUniversalTagFn(sibling);
        const elementAttrs = await collectStableAttributesFn(element);
        for (const elemAttr of elementAttrs.slice(0, 2)) {
          results.push({
            xpath: `//${siblingTag}[@${siblingAttr.name}=${escapeXPath(siblingAttr.value)}]/following-sibling::${tag}[@${elemAttr.name}=${escapeXPath(elemAttr.value)}]`,
            strategy: 'preceding-sibling-attr',
            robustness: 88 - (depth * 5)
          });
        }

        const elementText = cleanText(element.textContent);
        if (elementText && this.isStaticText(elementText) && elementText.length < 80) {
          results.push({
            xpath: `//${siblingTag}[@${siblingAttr.name}=${escapeXPath(siblingAttr.value)}]/following-sibling::${tag}[normalize-space()=${escapeXPath(elementText)}]`,
            strategy: 'preceding-sibling-text',
            robustness: 86 - (depth * 5)
          });
        }
        if (elementAttrs.length === 0 && !elementText) {
          const inputType = element.getAttribute('type');
          const role = element.getAttribute('role');
          const className = element.className;

          if (inputType) {
            results.push({
              xpath: `//${siblingTag}[@${siblingAttr.name}=${escapeXPath(siblingAttr.value)}]/following::${tag}[@type=${escapeXPath(inputType)}]`,
              strategy: 'preceding-sibling-type-following',
              robustness: 77 - (depth * 5)
            });
          }

          if (role) {
            results.push({
              xpath: `//${siblingTag}[@${siblingAttr.name}=${escapeXPath(siblingAttr.value)}]/following::${tag}[@role=${escapeXPath(role)}]`,
              strategy: 'preceding-sibling-role-following',
              robustness: 76 - (depth * 5)
            });
          }

          if (className && typeof className === 'string' && className.trim() && this.isStableClass(className)) {
           results.push({
              xpath: `//${siblingTag}[@${siblingAttr.name}=${escapeXPath(siblingAttr.value)}]/following::${tag}[@class=${escapeXPath(className)}]`,
              strategy: 'preceding-sibling-class-following',
              robustness: 75 - (depth * 5)
            });
          }
        }
      }

      sibling = sibling.previousElementSibling;
      depth++;
    }
    return results;
  }

  // Tier 5: Parent with stable attribute + descendant axis
  // Contract: Searches up to 6 parent levels; generates descendant:: paths; includes direct child:: variant for depth=0
  static async strategyDescendantContext(element, tag, getBestAttributeFn, collectStableAttributesFn, getUniversalTagFn) {
    const results = [];
    let parent = element.parentElement;
    let depth = 0;

    while (parent && depth < 6) {
      const parentAttr = await getBestAttributeFn(parent);
      
      if (parentAttr) {
        const parentTag = getUniversalTagFn(parent);
        const childAttrs = await collectStableAttributesFn(element);
        for (const childAttr of childAttrs.slice(0, 2)) {
          results.push({
            xpath: `//${parentTag}[@${parentAttr.name}=${escapeXPath(parentAttr.value)}]/descendant::${tag}[@${childAttr.name}=${escapeXPath(childAttr.value)}]`,
            strategy: 'parent-descendant-attr',
            robustness: 85 - (depth * 5)
          });
        }

        const childText = cleanText(element.textContent);
        if (childText && this.isStaticText(childText) && childText.length < 80) {
          results.push({
            xpath: `//${parentTag}[@${parentAttr.name}=${escapeXPath(parentAttr.value)}]/descendant::${tag}[normalize-space()=${escapeXPath(childText)}]`,
            strategy: 'parent-descendant-text',
            robustness: 83 - (depth * 5)
          });
        }
        if (depth === 0 && childAttrs.length > 0) {
          results.push({
            xpath: `//${parentTag}[@${parentAttr.name}=${escapeXPath(parentAttr.value)}]/child::${tag}[@${childAttrs[0].name}=${escapeXPath(childAttrs[0].value)}]`,
            strategy: 'parent-child-direct-attr',
            robustness: 84 - (depth * 5)
          });
        }
        if (childAttrs.length === 0 && !childText) {
          const inputType = element.getAttribute('type');
          const role = element.getAttribute('role');
          const className = element.className;

          if (inputType) {
            results.push({
              xpath: `//${parentTag}[@${parentAttr.name}=${escapeXPath(parentAttr.value)}]/descendant::${tag}[@type=${escapeXPath(inputType)}]`,
              strategy: 'parent-descendant-type',
              robustness: 72 - (depth * 5)
            });
          }

          if (role) {
            results.push({
              xpath: `//${parentTag}[@${parentAttr.name}=${escapeXPath(parentAttr.value)}]/descendant::${tag}[@role=${escapeXPath(role)}]`,
              strategy: 'parent-descendant-role',
              robustness: 71 - (depth * 5)
            });
          }

          if (className && typeof className === 'string' && className.trim() && this.isStableClass(className)) {
            results.push({
              xpath: `//${parentTag}[@${parentAttr.name}=${escapeXPath(parentAttr.value)}]/descendant::${tag}[@class=${escapeXPath(className)}]`,
              strategy: 'parent-descendant-class',
              robustness: 70 - (depth * 5)
            });
          }
        }
      }

      parent = parent.parentElement;
      depth++;
    }
    return results;
  }

  // Tier 6: Stable attribute combined with text content
  // Contract: Combines first 2 stable attrs with both text() and normalize-space(); filters non-static text
  static async strategyAttrTextCombo(element, tag, collectStableAttributesFn) {
    const results = [];
    const attrs = await collectStableAttributesFn(element);
    const visibleText = cleanText(element.textContent);
    
    if (attrs.length === 0 || !visibleText || visibleText.length > 80) return results;
    if (!this.isStaticText(visibleText)) return results;
    
    for (const attr of attrs.slice(0, 2)) {
      results.push({
        xpath: `//${tag}[@${attr.name}=${escapeXPath(attr.value)} and text()=${escapeXPath(visibleText)}]`,
        strategy: 'attr-text-combo',
        robustness: 93
      });
      
      results.push({
        xpath: `//${tag}[@${attr.name}=${escapeXPath(attr.value)} and normalize-space()=${escapeXPath(visibleText)}]`,
        strategy: 'attr-text-normalized',
        robustness: 92
      });
    }
    
    return results;
  }

  // Tier 7: Following stable element as anchor (reverse direction)
  // Contract: Queries document for anchor elements, uses following:: axis; includes descendant:: variant if anchor contains element
  static async strategyFollowingContext(element, tag, getBestAttributeFn, collectStableAttributesFn, getUniversalTagFn) {
    const results = [];
    const elementAttrs = await collectStableAttributesFn(element);
    
    const anchors = Array.from(document.querySelectorAll('[id], [data-testid], [data-qa], [data-key], [data-record-id]')).slice(0, 15);
    
    for (const anchor of anchors) {
      if (anchor === element) continue;
      
      const anchorAttr = await getBestAttributeFn(anchor);
      if (!anchorAttr) continue;
      
      const position = anchor.compareDocumentPosition(element);
      
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
        const anchorTag = getUniversalTagFn(anchor);
        for (const elemAttr of elementAttrs.slice(0, 1)) {
          results.push({
            xpath: `//${anchorTag}[@${anchorAttr.name}=${escapeXPath(anchorAttr.value)}]/following::${tag}[@${elemAttr.name}=${escapeXPath(elemAttr.value)}]`,
            strategy: 'following-anchor',
            robustness: 80
          });
        }

        if (anchor.contains(element)) {
          for (const elemAttr of elementAttrs.slice(0, 1)) {
            results.push({
              xpath: `//${anchorTag}[@${anchorAttr.name}=${escapeXPath(anchorAttr.value)}]/descendant::${tag}[@${elemAttr.name}=${escapeXPath(elemAttr.value)}]`,
              strategy: 'following-anchor-descendant',
              robustness: 82
            });
          }
        }

        if (elementAttrs.length === 0) {
          const elementText = cleanText(element.textContent);
          if (elementText && this.isStaticText(elementText)) {
            results.push({
              xpath: `//${anchorTag}[@${anchorAttr.name}=${escapeXPath(anchorAttr.value)}]/following::${tag}[normalize-space()=${escapeXPath(elementText)}]`,
              strategy: 'following-anchor-text',
              robustness: 78
            });
          }
          
          const inputType = element.getAttribute('type');
          if (inputType) {
            results.push({
              xpath: `//${anchorTag}[@${anchorAttr.name}=${escapeXPath(anchorAttr.value)}]/following::${tag}[@type=${escapeXPath(inputType)}]`,
              strategy: 'following-anchor-type',
              robustness: 76
            });
          }

          const role = element.getAttribute('role');
          if (role) {
            results.push({
              xpath: `//${anchorTag}[@${anchorAttr.name}=${escapeXPath(anchorAttr.value)}]/following::${tag}[@role=${escapeXPath(role)}]`,
              strategy: 'following-anchor-role',
              robustness: 75
            });
          }
        }
      }
    }
    return results;
  }

  // Tier 8: Framework-specific data attributes
  // Contract: Prioritizes data-key/data-record attributes with robustness 88, other data-* attrs 82
  static strategyFrameworkAttributes(element, tag, framework) {
    const results = [];
    const dataAttrs = getDataAttributes(element);
    
    for (const [attrName, attrValue] of Object.entries(dataAttrs)) {
      if (this.isStableValue(attrValue)) {
        const robustness = attrName.includes('key') || attrName.includes('record') ? 88 : 82;
        results.push({
          xpath: `//${tag}[@${attrName}=${escapeXPath(attrValue)}]`,
          strategy: `framework-${attrName}`,
          robustness: robustness
        });
      }
    }
    return results;
  }

  // Tier 9: Multi-attribute fingerprint (2-3 attributes combined)
  // Contract: Creates AND-combined conditions; generates triple/double/single variants with decreasing robustness
  static async strategyMultiAttributeFingerprint(element, tag, collectStableAttributesFn) {
    const results = [];
    const attrs = await collectStableAttributesFn(element);
    
    if (attrs.length >= 3) {
      const [a1, a2, a3] = attrs;
      results.push({
        xpath: `//${tag}[@${a1.name}=${escapeXPath(a1.value)} and @${a2.name}=${escapeXPath(a2.value)} and @${a3.name}=${escapeXPath(a3.value)}]`,
        strategy: 'triple-attr',
        robustness: 78
      });
    }
    
    if (attrs.length >= 2) {
      const [a1, a2] = attrs;
      results.push({
        xpath: `//${tag}[@${a1.name}=${escapeXPath(a1.value)} and @${a2.name}=${escapeXPath(a2.value)}]`,
        strategy: 'double-attr',
        robustness: 75
      });
    }
    
    if (attrs.length >= 1) {
      const a1 = attrs[0];
      results.push({
        xpath: `//${tag}[@${a1.name}=${escapeXPath(a1.value)}]`,
        strategy: 'single-attr',
        robustness: 70
      });
    }
    return results;
  }

  // Tier 10: ARIA role + label combination
  // Contract: Combines role and aria-label attributes; robustness 76
  static strategyAriaRoleLabel(element, tag) {
    const results = [];
    const role = element.getAttribute('role');
    const ariaLabel = element.getAttribute('aria-label');
    
    if (role && ariaLabel && this.isStableValue(ariaLabel)) {
      results.push({
        xpath: `//${tag}[@role=${escapeXPath(role)} and @aria-label=${escapeXPath(ariaLabel)}]`,
        strategy: 'role-aria-label',
        robustness: 76
      });
    }
    return results;
  }

  // Tier 11: Label association for form inputs
  // Contract: Searches for label[for=id], parent label, or adjacent label; generates variants with type attribute
  static strategyLabelAssociation(element, tag, extractTagFromUniversalFn) {
    const results = [];
    const formTags = ['input', 'select', 'textarea'];
    const tagLower = extractTagFromUniversalFn(tag);
    
    if (!formTags.includes(tagLower)) {
      return results;
    }
    
    const id = element.id;
    if (id && this.isStableId(id)) {
      const labels = Array.from(document.querySelectorAll(`label[for="${id}"]`));
      if (labels.length === 1) {
        results.push({
          xpath: `//label[@for=${escapeXPath(id)}]/following::${tag}[@id=${escapeXPath(id)}]`,
          strategy: 'label-following-id',
          robustness: 80
        });
      }
    }

    const parentLabel = element.closest('label');
    if (parentLabel) {
      const labelText = cleanText(parentLabel.textContent);
      if (labelText && this.isStaticText(labelText) && labelText.length < 100) {
        const inputType = element.getAttribute('type');
        
        if (inputType) {
          results.push({
            xpath: `//label[normalize-space()=${escapeXPath(labelText)}]/descendant::${tag}[@type=${escapeXPath(inputType)}]`,
            strategy: 'label-nested-type',
            robustness: 82
          });
        }
        
        results.push({
          xpath: `//label[normalize-space()=${escapeXPath(labelText)}]/descendant::${tag}`,
          strategy: 'label-nested-tagonly',
          robustness: 78
        });

        results.push({
          xpath: `//label[contains(normalize-space(), ${escapeXPath(labelText)})]/descendant::${tag}`,
          strategy: 'label-nested-contains',
          robustness: 75
        });
      }
    }

    const previousSibling = element.previousElementSibling;
    if (previousSibling && previousSibling.tagName.toLowerCase() === 'label') {
      const labelText = cleanText(previousSibling.textContent);
      if (labelText && this.isStaticText(labelText)) {
        const inputType = element.getAttribute('type');
        
        if (inputType) {
          results.push({
            xpath: `//label[normalize-space()=${escapeXPath(labelText)}]/following-sibling::${tag}[@type=${escapeXPath(inputType)}]`,
            strategy: 'label-adjacent-type',
            robustness: 79
          });
        }
        
        results.push({
          xpath: `//label[normalize-space()=${escapeXPath(labelText)}]/following-sibling::${tag}`,
          strategy: 'label-adjacent-tagonly',
          robustness: 76
        });
      }
    }

    return results;
  }

  // Tier 12: Partial text match using contains() or starts-with()
  // Contract: Uses 70% of text or max 50 chars; generates both contains() and starts-with() variants
  static strategyPartialTextMatch(element, tag) {
    const results = [];
    const visibleText = cleanText(element.textContent);
    
    if (!visibleText || visibleText.length < 20 || visibleText.length > 200) return results;
    if (!this.isStaticText(visibleText)) return results;
    
    const partialLength = Math.min(50, Math.floor(visibleText.length * 0.7));
    const partialText = visibleText.substring(0, partialLength);
    
    results.push({
      xpath: `//${tag}[contains(text(), ${escapeXPath(partialText)})]`,
      strategy: 'partial-text-contains',
      robustness: 72
    });
    
    results.push({
      xpath: `//${tag}[starts-with(text(), ${escapeXPath(partialText)})]`,
      strategy: 'partial-text-starts',
      robustness: 74
    });
    
    return results;
  }

  // Tier 13: Href pattern matching for links
  // Contract: Strips query params from href; combines with title attribute; filters javascript: hrefs
  static strategyHrefPattern(element, tag) {
    const results = [];
    const href = element.getAttribute('href');
    
    if (!href || href.startsWith('javascript:')) return results;
    
    const hrefPath = href.split('?')[0];
    const title = element.getAttribute('title');
    
    if (hrefPath.length > 5 && title && this.isStableValue(title)) {
      results.push({
        xpath: `//a[@title=${escapeXPath(title)} and contains(@href, ${escapeXPath(hrefPath)})]`,
        strategy: 'href-title',
        robustness: 74
      });
    }
    return results;
  }

  // Tier 14: Parent-child axes with attribute-based parent identification
  // Contract: Searches up to 3 parent levels; uses child:: axis for direct children, descendant:: as fallback
  static async strategyParentChildAxes(element, tag, getBestAttributeFn, collectStableAttributesFn, getUniversalTagFn) {
    const results = [];
    let parent = element.parentElement;
    let depth = 0;

    while (parent && depth < 3) {
      const parentAttr = await getBestAttributeFn(parent);
      
      if (parentAttr) {
        const parentTag = getUniversalTagFn(parent);
        const elementAttrs = await collectStableAttributesFn(element);
        
        if (elementAttrs.length > 0) {
          results.push({
            xpath: `//${parentTag}[@${parentAttr.name}=${escapeXPath(parentAttr.value)}]/child::${tag}[@${elementAttrs[0].name}=${escapeXPath(elementAttrs[0].value)}]`,
            strategy: 'parent-child-direct-attr',
            robustness: 68 - (depth * 5)
          });
        }
        
        results.push({
          xpath: `//${parentTag}[@${parentAttr.name}=${escapeXPath(parentAttr.value)}]/descendant::${tag}`,
          strategy: 'parent-descendant-tagonly',
          robustness: 66 - (depth * 5)
        });
      }

      parent = parent.parentElement;
      depth++;
    }
    return results;
  }

  // Tier 15: Sibling axes (preceding-sibling and following-sibling)
  // Contract: Searches up to 2 siblings in each direction; uses reverse axes from stable siblings
  static async strategySiblingAxes(element, tag, getBestAttributeFn, collectStableAttributesFn, getUniversalTagFn) {
    const results = [];
    
    let sibling = element.nextElementSibling;
    let depth = 0;
    while (sibling && depth < 2) {
      const siblingAttr = await getBestAttributeFn(sibling);
      
      if (siblingAttr) {
        const siblingTag = getUniversalTagFn(sibling);
        const elementAttrs = await collectStableAttributesFn(element);
        
        for (const elemAttr of elementAttrs.slice(0, 1)) {
          results.push({
            xpath: `//${siblingTag}[@${siblingAttr.name}=${escapeXPath(siblingAttr.value)}]/preceding-sibling::${tag}[@${elemAttr.name}=${escapeXPath(elemAttr.value)}]`,
            strategy: 'following-sibling-reverse',
            robustness: 66 - (depth * 5)
          });
        }
      }

      sibling = sibling.nextElementSibling;
      depth++;
    }
    
    sibling = element.previousElementSibling;
    depth = 0;
    while (sibling && depth < 2) {
      const siblingAttr = await getBestAttributeFn(sibling);
      
      if (siblingAttr) {
        const siblingTag = getUniversalTagFn(sibling);
        
        results.push({
          xpath: `//${siblingTag}[@${siblingAttr.name}=${escapeXPath(siblingAttr.value)}]/following-sibling::${tag}`,
          strategy: 'preceding-sibling-tagonly',
          robustness: 64 - (depth * 5)
        });
      }

      sibling = sibling.previousElementSibling;
      depth++;
    }
    
    return results;
  }

  // Tier 16: Semantic ancestor (form, nav, header, etc) as location anchor
  // Contract: Searches up to 8 levels for semantic tag; requires stable attribute on semantic parent
  static async strategySemanticAncestor(element, tag, getBestAttributeFn, collectStableAttributesFn, getUniversalTagFn, findBestSemanticAncestorFn) {
    const results = [];
    const semanticParent = await findBestSemanticAncestorFn(element);

    if (!semanticParent) return results;
    
    const parentTag = getUniversalTagFn(semanticParent);
    const parentAttr = await getBestAttributeFn(semanticParent);
    const childAttrs = await collectStableAttributesFn(element);
    
    if (parentAttr) {
      for (const childAttr of childAttrs.slice(0, 1)) {
        results.push({
          xpath: `//${parentTag}[@${parentAttr.name}=${escapeXPath(parentAttr.value)}]/descendant::${tag}[@${childAttr.name}=${escapeXPath(childAttr.value)}]`,
          strategy: 'semantic-ancestor',
          robustness: 64
        });
      }
    }
    return results;
  }

  // Tier 17: Class + attribute combination
  // Contract: Combines first stable class with first stable attribute using contains(@class)
  static async strategyClassAttributeCombo(element, tag, collectStableAttributesFn) {
    const results = [];
    const classes = Array.from(element.classList).filter(c => this.isStableClass(c));
    const attrs = await collectStableAttributesFn(element);
    
    if (classes.length > 0 && attrs.length > 0) {
      const cls = classes[0];
      const attr = attrs[0];
      
      results.push({
        xpath: `//${tag}[contains(@class, ${escapeXPath(cls)}) and @${attr.name}=${escapeXPath(attr.value)}]`,
        strategy: 'class-attr-combo',
        robustness: 60
      });
    }
    return results;
  }

  // Tier 18: Ancestor chain (builds path through multiple stable ancestors)
  // Contract: Uses up to 3 ancestors with stable attributes; decreasing robustness by depth
  static async strategyAncestorChain(element, tag, collectStableAttributesFn, getStableAncestorChainFn, getUniversalTagFn) {
    const results = [];
    const ancestors = getStableAncestorChainFn(element, 3);
    
    if (ancestors.length === 0) return results;
    
    const childAttrs = await collectStableAttributesFn(element);
    
    for (let i = 0; i < ancestors.length; i++) {
      const ancestor = ancestors[i];
      const ancestorTag = getUniversalTagFn(ancestor.element);
      
      for (const childAttr of childAttrs.slice(0, 1)) {
        results.push({
          xpath: `//${ancestorTag}[@${ancestor.attr.name}=${escapeXPath(ancestor.attr.value)}]/descendant::${tag}[@${childAttr.name}=${escapeXPath(childAttr.value)}]`,
          strategy: `ancestor-chain-${i}`,
          robustness: 58 - (i * 4)
        });
      }
    }
    return results;
  }

  // Tier 19: Table row context (highly specialized for tabular data)
  // Contract: Finds tr ancestor; uses row attributes or row cell text; prioritizes class + type combinations
  static async strategyTableRowContext(element, tag, collectStableAttributesFn, getUniversalTagFn, extractTagFromUniversalFn) {
    const results = [];
    
    const applicableTags = ['input', 'span', 'td', 'th', 'a', 'button', 'label', 'svg', 'path'];
    const tagLower = extractTagFromUniversalFn(tag);
    
    if (!applicableTags.includes(tagLower) && !tag.includes('local-name')) {
      return results;
    }
    
    const row = element.closest('tr');
    if (!row) return results;
    
    const rowAttrs = await collectStableAttributesFn(row);
    for (const rowAttr of rowAttrs.slice(0, 2)) {
      const inputType = element.getAttribute('type');
      const elementClass = element.className;
      
      if (elementClass && this.isStableClass(elementClass)) {
        results.push({
          xpath: `//tr[@${rowAttr.name}=${escapeXPath(rowAttr.value)}]/descendant::${tag}[@class=${escapeXPath(elementClass)}]`,
          strategy: 'table-row-attr-class',
          robustness: 94
        });
        
        results.push({
          xpath: `//tr[@${rowAttr.name}=${escapeXPath(rowAttr.value)}]/child::*/descendant::${tag}[@class=${escapeXPath(elementClass)}]`,
          strategy: 'table-row-attr-class-child',
          robustness: 93
        });
      }
      
      if (inputType) {
        results.push({
          xpath: `//tr[@${rowAttr.name}=${escapeXPath(rowAttr.value)}]/descendant::${tag}[@type=${escapeXPath(inputType)}]`,
          strategy: 'table-row-attr-type',
          robustness: 92
        });
      }
      
      results.push({
        xpath: `//tr[@${rowAttr.name}=${escapeXPath(rowAttr.value)}]/descendant::${tag}`,
        strategy: 'table-row-attr',
        robustness: 90
      });
    }
    
    const cells = Array.from(row.querySelectorAll('td, th, a'));
    
    for (const cell of cells) {
      if (cell.contains(element) || cell === element) continue;
      
      const cellText = cleanText(cell.textContent);
      if (!cellText || cellText.length === 0 || cellText.length > 100) continue;
      if (!this.isStaticText(cellText)) continue;
      
      const cellTag = getUniversalTagFn(cell);
      const inputType = element.getAttribute('type');
      const elementClass = element.className;
      
      if (elementClass && this.isStableClass(elementClass)) {
        results.push({
          xpath: `//tr[.//${cellTag}[normalize-space()=${escapeXPath(cellText)}]]/descendant::${tag}[@class=${escapeXPath(elementClass)}]`,
          strategy: 'table-row-text-class',
          robustness: 93
        });
        
        results.push({
          xpath: `//${cellTag}[normalize-space()=${escapeXPath(cellText)}]/following::${tag}[@class=${escapeXPath(elementClass)}]`,
          strategy: 'table-row-text-class-following',
          robustness: 91
        });

        results.push({
          xpath: `//${cellTag}[normalize-space()=${escapeXPath(cellText)}]/preceding::${tag}[@class=${escapeXPath(elementClass)}]`,
          strategy: 'table-row-text-class-preceding',
          robustness: 90
        });
      }
      
      if (inputType) {
        results.push({
          xpath: `//tr[.//${cellTag}[normalize-space()=${escapeXPath(cellText)}]]/descendant::${tag}[@type=${escapeXPath(inputType)}]`,
          strategy: 'table-row-text-type',
          robustness: 91
        });
      }
      
      results.push({
        xpath: `//tr[.//${cellTag}[normalize-space()=${escapeXPath(cellText)}]]/descendant::${tag}`,
        strategy: 'table-row-text',
        robustness: 89
      });
      
      if (cellText.length > 20) {
        const shortText = cellText.substring(0, 25);
        results.push({
          xpath: `//tr[.//${cellTag}[contains(normalize-space(), ${escapeXPath(shortText)})]]/descendant::${tag}`,
          strategy: 'table-row-text-partial',
          robustness: 87
        });
      }
    }
    
    if (rowAttrs.length > 0) {
      const targetCell = element.closest('td, th');
      if (targetCell) {
        const columnIndex = Array.from(row.children).indexOf(targetCell) + 1;
        if (columnIndex > 0) {
          const rowAttr = rowAttrs[0];
          const elementClass = element.className;
          
          if (elementClass && this.isStableClass(elementClass)) {
            results.push({
              xpath: `//tr[@${rowAttr.name}=${escapeXPath(rowAttr.value)}]//*[${columnIndex}]/descendant::${tag}[@class=${escapeXPath(elementClass)}]`,
              strategy: 'table-row-column-class',
              robustness: 87
            });
          }
          
          results.push({
            xpath: `//tr[@${rowAttr.name}=${escapeXPath(rowAttr.value)}]//*[${columnIndex}]/descendant::${tag}`,
            strategy: 'table-row-column',
            robustness: 83
          });
        }
      }
    }
    
    return results;
  }

  // Tier 20: SVG visual fingerprint (specialized for SVG/icon elements)
  // Contract: Handles SVG elements and paths; uses data-key, button containers, viewBox, path d attribute
  static async strategySVGVisualFingerprint(element, tag, getBestAttributeFn, getUniversalTagFn) {
    const results = [];
    
    const tagLower = element.tagName.toLowerCase();
    const isSvgElement = element.namespaceURI === 'http://www.w3.org/2000/svg' || 
                        ['svg', 'path', 'g', 'circle', 'rect', 'line', 'polygon'].includes(tagLower);
    
    const svgParent = tagLower === 'svg' ? element : element.closest('svg');
    const isSvgPath = tagLower === 'path' && svgParent;
    
    if (isSvgElement || isSvgPath) {
      if (svgParent) {
        const dataKey = svgParent.getAttribute('data-key');
        if (dataKey && this.isStableValue(dataKey)) {
          results.push({
            xpath: `//*[local-name()='svg'][@data-key=${escapeXPath(dataKey)}]`,
            strategy: 'svg-data-key',
            robustness: 98
          });
          
          if (isSvgPath && tagLower === 'path') {
            results.push({
              xpath: `//*[local-name()='svg'][@data-key=${escapeXPath(dataKey)}]//*[local-name()='path']`,
              strategy: 'svg-data-key-path',
              robustness: 96
            });
          }
        }
        
        const interactiveParent = svgParent.closest('button, a, [role="button"], lightning-button');
        if (interactiveParent) {
          const parentAttr = await getBestAttributeFn(interactiveParent);
          if (parentAttr) {
            const parentTag = getUniversalTagFn(interactiveParent);
            
            results.push({
              xpath: `//${parentTag}[@${parentAttr.name}=${escapeXPath(parentAttr.value)}]/descendant::*[local-name()='svg']`,
              strategy: 'svg-in-button-descendant',
              robustness: 95
            });
            
            results.push({
              xpath: `//${parentTag}[@${parentAttr.name}=${escapeXPath(parentAttr.value)}]/child::*[local-name()='svg']`,
              strategy: 'svg-in-button-child',
              robustness: 94
            });
            
            if (isSvgPath && tagLower === 'path') {
              results.push({
                xpath: `//${parentTag}[@${parentAttr.name}=${escapeXPath(parentAttr.value)}]/descendant::*[local-name()='path']`,
                strategy: 'svg-path-in-button',
                robustness: 93
              });
            }
          }
          
          const ariaLabel = interactiveParent.getAttribute('aria-label');
          const title = interactiveParent.getAttribute('title');
          
          if (ariaLabel && this.isStableValue(ariaLabel)) {
            const parentTag = getUniversalTagFn(interactiveParent);
            results.push({
              xpath: `//${parentTag}[@aria-label=${escapeXPath(ariaLabel)}]/descendant::*[local-name()='svg']`,
              strategy: 'svg-in-labeled-button',
              robustness: 92
            });
          }
          
          if (title && this.isStableValue(title)) {
            const parentTag = getUniversalTagFn(interactiveParent);
            results.push({
              xpath: `//${parentTag}[@title=${escapeXPath(title)}]/descendant::*[local-name()='svg']`,
              strategy: 'svg-in-titled-button',
              robustness: 91
            });
          }
        }
        
        const svgClasses = Array.from(svgParent.classList);
        const iconClasses = svgClasses.filter(c => 
          c.includes('icon') && !c.match(/^icon-\d+$/) && this.isStableClass(c)
        );
        
        if (iconClasses.length > 0) {
          iconClasses.sort((a, b) => b.length - a.length);
          
          results.push({
            xpath: `//*[local-name()='svg'][contains(@class, ${escapeXPath(iconClasses[0])})]`,
            strategy: 'svg-icon-class',
            robustness: 88
          });
          
          if (isSvgPath && tagLower === 'path') {
            results.push({
              xpath: `//*[local-name()='svg'][contains(@class, ${escapeXPath(iconClasses[0])})]//*[local-name()='path']`,
              strategy: 'svg-icon-class-path',
              robustness: 86
            });
          }
        }
        
        const viewBox = svgParent.getAttribute('viewBox');
        if (viewBox && viewBox.length < 50) {
          results.push({
            xpath: `//*[local-name()='svg'][@viewBox=${escapeXPath(viewBox)}]`,
            strategy: 'svg-viewbox',
            robustness: 80
          });
        }
      }
      
      if (isSvgPath && tagLower === 'path') {
        const pathD = element.getAttribute('d');
        if (pathD && pathD.length > 20 && pathD.length < 300) {
          results.push({
            xpath: `//*[local-name()='path'][@d=${escapeXPath(pathD)}]`,
            strategy: 'svg-path-data',
            robustness: 90
          });
        }
      }
    }
    
    const classes = Array.from(element.classList);
    const iconClasses = classes.filter(c => 
      c.includes('icon') || c.includes('fa-') || c.includes('material-') || 
      c.includes('glyphicon') || c.includes('bi-') || c.includes('slds-icon')
    );
    
    if (iconClasses.length > 0) {
      const stableIconClasses = iconClasses.filter(c => this.isStableClass(c));
      
      for (const iconClass of stableIconClasses.slice(0, 2)) {
        results.push({
          xpath: `//${tag}[contains(@class, ${escapeXPath(iconClass)})]`,
          strategy: 'icon-class',
          robustness: 72
        });
      }
      
      if (stableIconClasses.length >= 2) {
        results.push({
          xpath: `//${tag}[contains(@class, ${escapeXPath(stableIconClasses[0])}) and contains(@class, ${escapeXPath(stableIconClasses[1])})]`,
          strategy: 'icon-multi-class',
          robustness: 75
        });
      }
    }
    
    const role = element.getAttribute('role');
    if (role === 'img' || role === 'icon') {
      const ariaLabel = element.getAttribute('aria-label');
      if (ariaLabel && this.isStableValue(ariaLabel)) {
        results.push({
          xpath: `//${tag}[@role=${escapeXPath(role)} and @aria-label=${escapeXPath(ariaLabel)}]`,
          strategy: 'icon-role-label',
          robustness: 78
        });
      }
    }
    
    return results;
  }

  // Tier 21: Spatial text context (uses nearby text elements as anchors)
  // Contract: Finds up to 3 nearby text elements within 200px; uses following/preceding axes based on direction
  static strategySpatialTextContext(element, tag, getUniversalTagFn, findNearbyTextElementsFn) {
    const results = [];
    
    const nearbyTextElements = findNearbyTextElementsFn(element, 200);
    
    for (let i = 0; i < Math.min(nearbyTextElements.length, 3); i++) {
      const textEl = nearbyTextElements[i];
      const textContent = cleanText(textEl.text);
      
      if (!textContent || !this.isStaticText(textContent) || textContent.length > 80) continue;
      
      const textElTag = getUniversalTagFn(textEl.element);
      const direction = textEl.direction;
      
      if (direction === 'before') {
        results.push({
          xpath: `//${textElTag}[normalize-space()=${escapeXPath(textContent)}]/following::${tag}`,
          strategy: 'spatial-text-following',
          robustness: 65 - (i * 3)
        });
        
        const inputType = element.getAttribute('type');
        if (inputType) {
          results.push({
            xpath: `//${textElTag}[normalize-space()=${escapeXPath(textContent)}]/following::${tag}[@type=${escapeXPath(inputType)}]`,
            strategy: 'spatial-text-following-type',
            robustness: 67 - (i * 3)
          });
        }
      }
      
      if (direction === 'after') {
        results.push({
          xpath: `//${textElTag}[normalize-space()=${escapeXPath(textContent)}]/preceding::${tag}`,
          strategy: 'spatial-text-preceding',
          robustness: 64 - (i * 3)
        });
      }
      
      if (textContent.length > 10) {
        const shortText = textContent.substring(0, 30);
        results.push({
          xpath: `//${textElTag}[contains(normalize-space(), ${escapeXPath(shortText)})]/following::${tag}`,
          strategy: 'spatial-text-partial',
          robustness: 62 - (i * 3)
        });
      }
    }
    
    return results;
  }

  // Tier 22: Guaranteed path (last resort - builds full attribute path from root)
  // Contract: Walks up DOM tree adding attributes; returns first unique path found
  static async strategyGuaranteedPath(element, tag, getBestAttributeFn, getUniversalTagFn, strictValidateFn) {
    const results = [];
    const path = this.buildGuaranteedPathNoIndex(element, tag, getBestAttributeFn, getUniversalTagFn, strictValidateFn);

    if (path.xpath) {
      results.push({
        xpath: path.xpath,
        strategy: 'guaranteed-path',
        robustness: path.robustness
      });
    }
    return results;
  }

  // Helper: Builds guaranteed unique path using parent attributes, without positional indexes
  // Contract: Tests uniqueness at each level; returns first unique path or complete path after 12 levels
  static async buildGuaranteedPathNoIndex(element, tag, getBestAttributeFn, getUniversalTagFn, strictValidateFn) {
    const segments = [];
    let current = element;
    let robustnessScore = 100;
    let depth = 0;

    while (current && current !== document.body && depth < 12) {
      const currentTag = getUniversalTagFn(current);
      const attr = await getBestAttributeFn(current);

      if (attr) {
        segments.unshift(`${currentTag}[@${attr.name}=${escapeXPath(attr.value)}]`);
        robustnessScore -= 3;
      } else {
        segments.unshift(currentTag);
        robustnessScore -= 10;
      }

      const testXpath = '//' + segments.join('/');
      if (strictValidateFn(testXpath, element).isUnique) {
        return {
          xpath: testXpath,
          robustness: Math.max(30, robustnessScore)
        };
      }

      current = current.parentElement;
      depth++;
    }

    return {
      xpath: '//' + segments.join('/'),
      robustness: Math.max(20, robustnessScore)
    };
  }

  // Stability validation helpers
  
  // Checks if ID is stable (not auto-generated or framework-managed)
  // Contract: Returns false for numeric-only, UUID, framework-prefixed, or Salesforce-pattern IDs
  static isStableId(id) {
    const UNSTABLE_ID_PATTERNS = [
      /^\d+$/, /^[0-9]{8,}$/, /^[a-f0-9]{8}-[a-f0-9]{4}/i,
      /^(ember|react|vue|angular)\d+$/i, /^uid-\d+$/i, /^temp[-_]?\d+$/i,
      /brandBand_\d+/i, /^gen\d+$/i, /^aura-\d+$/i, 
      /^lightning-\w+-\d+$/i, /^sldsModal\d+$/i, /^forceRecord\w+_\d+$/i,
      /^[0-9]+:[0-9]+;[a-z]$/i, /-\d+-\d+$/, /-\d{2,}$/,
      /lgt-datatable.*-\d+-\d+/i, /check-button-label-\d+-\d+/i,
      /-check-id-\d+-\d+/i, /datatable.*-\d+/i, /-\d+-\d+-\d+/
    ];
    
    if (!id || id.length < 2 || id.length > 200) return false;
    return !UNSTABLE_ID_PATTERNS.some(pattern => pattern.test(id));
  }

  // Checks if attribute value is stable (not dynamic or generated)
  // Contract: Returns false for long numerics, UUIDs, framework signatures
  static isStableValue(value) {
    const UNSTABLE_VALUE_PATTERNS = [
      /^[0-9]{8,}$/, /^[a-f0-9]{8}-[a-f0-9]{4}/i, /data-aura-rendered/i,
      /^ember\d+$/i, /^react\d+$/i, /^\d{13}$/, /^tt-for-\d+$/i,
      /^[0-9]+:[0-9]+;[a-z]$/i, /-\d+-\d+$/
    ];
    
    if (!value || typeof value !== 'string') return false;
    if (value.length < 1 || value.length > 200) return false;
    return !UNSTABLE_VALUE_PATTERNS.some(pattern => pattern.test(value));
  }

  // Checks if CSS class is stable (not auto-generated by CSS-in-JS or frameworks)
  // Contract: Returns false for Material-UI, JSS, Emotion, LWC patterns
  static isStableClass(className) {
    if (!className || typeof className !== 'string' || className.trim().length === 0) {
      return false;
    }

    const trimmed = className.trim();

    const unstablePatterns = [
      /^Mui[A-Z]\w+-\w+-\d+$/, /^makeStyles-/, 
      /^css-[a-z0-9]+$/i, /^jss\d+$/,
      /^[a-z]{1,3}\d{5,}$/i, /^_[a-z0-9]{6,}$/i,
      /^sc-[a-z]+-[a-z]+$/i, /^emotion-\d+$/,
      /^[0-9]+:[0-9]+;[a-z]$/i, /lwc-[a-z0-9]+/i
    ];

    return !unstablePatterns.some(pattern => pattern.test(trimmed));
  }

  // Checks if text content is static (not dynamic like timestamps, UUIDs, currency)
  // Contract: Returns false for numeric-only, dates, loading indicators, money values
  static isStaticText(text) {
    if (!text || typeof text !== 'string') return false;
    if (text.length < 2 || text.length > 200) return false;
    
    const dynamicPatterns = [
      /^\d+$/, /^[0-9]{8,}$/, /^[a-f0-9]{8}-[a-f0-9]{4}/i,
      /^\d{1,2}:\d{2}/, /^\d{1,2}\/\d{1,2}\/\d{2,4}$/,
      /^loading/i, /^processing/i, /^\$\d+\.\d{2}$/
    ];
    
    return !dynamicPatterns.some(pattern => pattern.test(text));
  }
}

export default XPathStrategies;
