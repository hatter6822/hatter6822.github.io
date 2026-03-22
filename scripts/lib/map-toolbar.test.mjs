import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";

const html = readFileSync(new URL("../../map.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../../assets/css/map.css", import.meta.url), "utf8");

const toolbarIndex = html.indexOf('id="map-toolbar"');
const interiorMenuIndex = html.indexOf('id="flow-node-interior-menu"');
assert(toolbarIndex !== -1, "map toolbar should exist");
assert(interiorMenuIndex !== -1, "flow node interior menu should exist");
assert(toolbarIndex < interiorMenuIndex, "map toolbar should render before flow node interior menu");
assert(!html.includes('class="interior-menu-header"'), "interior menu header shell should not render in map markup");

assert(/aria-label="Dependency and proof flow chart"/.test(html), "flow chart region should remain labeled for accessibility");

assert(/<form class="map-toolbar" id="map-toolbar" role="search" aria-label="Module controls" aria-controls="flowchart-wrap" data-density="compact">/.test(html), "toolbar should use compact styling and explicitly control the flowchart");
assert(!/class="map-toolbar\s+card"/.test(html), "toolbar should not use the generic card shell");
assert(/<label for="module-search"[^>]*>Context search<\/label>/.test(html), "toolbar should include context search label");
assert(/id="module-search"[^>]*enterkeyhint="search"/.test(html), "module search should provide search enter key hint");
assert(/id="module-search"[^>]*role="combobox"[^>]*aria-controls="module-search-options"/.test(html), "module search should expose combobox semantics for cross-browser suggestion support");
assert(/id="module-search-options"[^>]*role="listbox"/.test(html), "module search should include an explicit listbox suggestion container");
assert(/id="reset-view"/.test(html), "toolbar should include reset button");

const removedControls = ["focus-select", "flow-show-all", "proof-linked-only", "toolbar-summary"];
for (const controlId of removedControls) {
  assert(!html.includes(`id="${controlId}"`), `toolbar should not include ${controlId}`);
}

assert(/id="flow-node-interior-menu"[^>]*aria-live="polite"/.test(html), "interior menu should support live region for declaration context updates");

// CSS: .sr-only class must be defined for interior menu filter label accessibility
assert(/\.sr-only\b/.test(css), "map.css should define .sr-only class for screen-reader-only elements");
assert(/\.sr-only[^{]*\{[^}]*position:\s*absolute/s.test(css), ".sr-only should use absolute positioning");

// CSS: interior menu should hide when empty (no module selected yet)
assert(/\.flow-node-interior-menu:empty\s*\{[^}]*display:\s*none/.test(css), "interior menu should be hidden when empty via :empty pseudo-class");

// HTML: interior menu should start empty (no pre-rendered children)
const interiorMenuMatch = html.match(/<div\s+id="flow-node-interior-menu"[^>]*><\/div>/);
assert(interiorMenuMatch, "interior menu should be an empty container in initial HTML (no children)");

// CSS: declaration breadcrumb styles must exist for declaration context navigation
assert(/\.declaration-context-breadcrumb\b/.test(css), "map.css should define declaration-context-breadcrumb class");
assert(/\.breadcrumb-separator\b/.test(css), "map.css should define breadcrumb-separator class");
assert(/\.breadcrumb-current\b/.test(css), "map.css should define breadcrumb-current class for active declaration label");

// JS: declaration breadcrumb should use <nav> element for accessibility
const mapJs = readFileSync(new URL("../../assets/js/map.js", import.meta.url), "utf8");
assert(/createElement\("nav"\)/.test(mapJs), "declaration breadcrumb should use a <nav> element");
assert(/aria-label.*Declaration breadcrumb/.test(mapJs), "declaration breadcrumb should have an aria-label");

// JS: renderContextChooser should update label text for declaration and module context
assert(/label\.textContent\s*=.*[Cc]ontext search/.test(mapJs), "renderContextChooser should set context search label");
assert(/declaration/.test(mapJs) && /module/.test(mapJs), "renderContextChooser should distinguish declaration and module context");

// JS: renderAll should update flowchart-wrap aria-label dynamically
assert(/setAttribute\("aria-label",\s*"Declaration call graph for "/.test(mapJs), "renderAll should set declaration-context aria-label on flowchart-wrap");
assert(/setAttribute\("aria-label",\s*"Dependency and proof flow chart"\)/.test(mapJs), "renderAll should restore module-context aria-label on flowchart-wrap");

// HTML: flowchart-shell container should exist and wrap the flowchart
assert(/class="flowchart-shell"/.test(html), "flowchart-shell container should exist in map markup");
const shellIndex = html.indexOf('class="flowchart-shell"');
const wrapIndex = html.indexOf('id="flowchart-wrap"');
assert(shellIndex < wrapIndex, "flowchart-shell should wrap the flowchart-wrap container");

// HTML: mobile hint should exist within flowchart-shell
assert(/class="flowchart-mobile-hint"/.test(html), "flowchart-mobile-hint should exist for mobile users");
const hintIndex = html.indexOf('class="flowchart-mobile-hint"');
assert(hintIndex > shellIndex && hintIndex < wrapIndex, "mobile hint should render between flowchart-shell and flowchart-wrap");

// CSS: mobile hint should be hidden by default
assert(/\.flowchart-mobile-hint\s*\{[^}]*display:\s*none/s.test(css), "flowchart-mobile-hint should be hidden by default on desktop");

// CSS: flow node rect should have transition for smooth hover/focus effects
assert(/\.flow-node\s+rect\s*\{[^}]*transition:/s.test(css), "flow node rect should have CSS transition for smooth visual feedback");

// CSS: assurance bar indicator styles should be defined for all levels
assert(/\.flow-node\.assurance-linked\s+\.assurance-bar/.test(css), "assurance bar styles should be defined for linked level");
assert(/\.flow-node\.assurance-none\s+\.assurance-bar/.test(css), "assurance bar styles should be defined for none level");

// JS: shared buildFlowNodeGroup helper should exist for node construction
assert(/function buildFlowNodeGroup\(/.test(mapJs), "buildFlowNodeGroup shared helper should exist to reduce node creation duplication");

// JS: buildFlowNodeGroup should use role="img" (not role="note") for non-interactive nodes
assert(/role:\s*onActivate\s*\?\s*"button"\s*:\s*"img"/.test(mapJs), "buildFlowNodeGroup should use role='img' for non-interactive SVG nodes (not role='note')");

// JS: createFlowSvg should include aria-roledescription for screen reader context
assert(/aria-roledescription.*flowchart/.test(mapJs), "createFlowSvg should set aria-roledescription='flowchart' on the SVG element");

// JS: applyFlowScrollTarget should disable smooth scroll during programmatic positioning
assert(/scrollBehavior\s*=\s*"auto"/.test(mapJs), "applyFlowScrollTarget should temporarily disable smooth scroll for instant programmatic positioning");

// JS: declarationIndex should be built during normalizeMapData for O(1) lookups
assert(/declarationIndex/.test(mapJs), "normalizeMapData should build a declarationIndex for fast declaration metadata lookups");

// CSS: .control-group should have position: relative for search options dropdown
assert(/\.control-group\s*\{[^}]*position:\s*relative/s.test(css), ".control-group should include position: relative for dropdown positioning");

// CSS: .flowchart-wrap should use contain for rendering performance
assert(/\.flowchart-wrap\s*\{[^}]*contain:\s*layout\s+style/s.test(css), ".flowchart-wrap should use CSS containment for rendering performance");

// CSS: .interior-menu-item-navigable should indicate interactivity
assert(/\.interior-menu-item-navigable\s*\{[^}]*cursor:\s*pointer/s.test(css), ".interior-menu-item-navigable should use cursor pointer for interactive items");

// JS: createFlowLegend should use role="list" for accessibility
assert(/role.*list/.test(mapJs) && /role.*listitem/.test(mapJs), "createFlowLegend should use role=list and role=listitem for screen readers");

// JS: legend swatches should be aria-hidden for screen readers
assert(/aria-hidden.*true/.test(mapJs), "legend swatches should be aria-hidden");

// JS: drawFlowEdge should guard against same-node edges
assert(/from\.x === to\.x/.test(mapJs), "drawFlowEdge should guard against same-node self-edges");

// JS: declarationKindOf should not accept unused moduleName parameter
assert(/function declarationKindOf\(declName\)\s*\{/.test(mapJs), "declarationKindOf should have single parameter (no unused moduleName)");

// JS: declarationLineOf should not accept unused moduleName parameter
assert(/function declarationLineOf\(declName\)\s*\{/.test(mapJs), "declarationLineOf should have single parameter (no unused moduleName)");

// JS: interior menu should use DocumentFragment for batch DOM insertion
assert(/createDocumentFragment\(\)/.test(mapJs), "interior menu should use DocumentFragment for batch DOM insertion");

// CSS: interior menu items should use flex layout for proper kind-label alignment
assert(/\.interior-menu-item\s*\{[^}]*display:\s*flex/s.test(css), "interior menu items should use flex layout for content alignment");

// CSS: interior menu items should have hover state for visual feedback
assert(/\.interior-menu-item:hover\s*\{/.test(css), "interior menu items should have hover state for visual feedback");

// CSS: interior menu items should have transition for smooth visual feedback
assert(/\.interior-menu-item\s*\{[^}]*transition:/s.test(css), "interior menu items should have CSS transition for smooth hover effects");

// CSS: interior menu item kind label should not wrap
assert(/\.interior-menu-item::after\s*\{[^}]*white-space:\s*nowrap/s.test(css), "interior menu item kind label should not wrap to preserve layout");

// CSS: interior menu item kind label should use margin-left auto for right-alignment
assert(/\.interior-menu-item::after\s*\{[^}]*margin-left:\s*auto/s.test(css), "interior menu item kind label should right-align via margin-left auto");

// CSS: interior menu button should have focus-visible outline for keyboard navigation
assert(/\.interior-menu-item-btn:focus-visible\s*\{[^}]*outline:/s.test(css), "interior menu button should have focus-visible outline for keyboard accessibility");

// CSS: interior menu items list should use thin scrollbar for space efficiency
assert(/\.interior-menu-items\s*\{[^}]*scrollbar-width:\s*thin/s.test(css), "interior menu items list should use thin scrollbar");

// CSS: interior menu grid should use min() to prevent overflow on narrow screens
assert(/\.interior-menu-grid\s*\{[^}]*minmax\(min\(16rem,\s*100%\)/s.test(css), "interior menu grid should use min() in minmax to prevent overflow on narrow viewports");

// CSS: interior menu item navigable should prevent flex wrapping
assert(/\.interior-menu-item-navigable\s*\{[^}]*flex-wrap:\s*nowrap/s.test(css), "interior menu item navigable should prevent flex wrapping");

// JS: repaintList should guard against empty href for non-navigable items
assert(/nameSpan/.test(mapJs), "repaintList should use span fallback when symbolSourceHref returns empty");

// JS: interior menu should not render legacy "src" links beside declaration buttons
assert(!/interior-menu-item-src/.test(mapJs), "interior menu should not create legacy src-link elements in declaration rows");

// JS: declarationSearchMatch function should exist for dot-append declaration search
assert(/function declarationSearchMatch\(/.test(mapJs), "declarationSearchMatch function should exist for dot-append search");

// JS: declarationSearchMatches (plural) should exist for multi-result declaration search
assert(/function declarationSearchMatches\(/.test(mapJs), "declarationSearchMatches function should exist for multi-result declaration search");

// JS: declarationSearchMatch should be exposed via test hooks
assert(/declarationSearchMatch:\s*declarationSearchMatch/.test(mapJs), "declarationSearchMatch should be exported via test hooks");

// JS: declarationSearchMatches should be exposed via test hooks
assert(/declarationSearchMatches:\s*declarationSearchMatches/.test(mapJs), "declarationSearchMatches should be exported via test hooks");

// JS: moduleSearchMatches should be exposed via test hooks
assert(/moduleSearchMatches:\s*moduleSearchMatches/.test(mapJs), "moduleSearchMatches should be exported via test hooks");

// JS: search should attempt declaration match when module match fails
assert(/tryDeclarationSearch/.test(mapJs), "search should try declaration search as fallback");

// JS: buildDeclarationSearchIndex should pre-index declarations for efficient search
assert(/function buildDeclarationSearchIndex\(/.test(mapJs), "buildDeclarationSearchIndex should exist for pre-indexing declarations");

// JS: declarationSearchList should track the pre-built declaration search index
assert(/declarationSearchList/.test(mapJs), "state should include declarationSearchList for pre-indexed declaration search");

// JS: searchDeclarationsInModule helper should exist for module-scoped declaration search
assert(/function searchDeclarationsInModule\(/.test(mapJs), "searchDeclarationsInModule helper should exist for module-scoped declaration search");

// JS: edge layer should be marked aria-hidden for accessibility
assert(/flow-edge-layer.*aria-hidden/.test(mapJs) || /aria-hidden.*flow-edge-layer/.test(mapJs), "edge layer SVG group should be aria-hidden for screen readers");

// CSS: declaration suggestion option should have distinct styling
assert(/\.module-search-option-decl\s*\{/.test(css), "declaration search suggestion should have distinct styling");

// CSS: interior-menu-items should use scrollbar-gutter for stable layout
assert(/\.interior-menu-items\s*\{[^}]*scrollbar-gutter:\s*stable/s.test(css), "interior-menu-items should use scrollbar-gutter for stable layout");

// JS: search state should include searchDeclSuggestions
assert(/searchDeclSuggestions/.test(mapJs), "search state should track declaration suggestions");

// JS: option list mousedown should handle data-declaration attribute
assert(/data-declaration/.test(mapJs), "option list should support data-declaration attribute for declaration suggestions");

// HTML: context search label should use "Context search" (generalized from module-only)
assert(/<label for="module-search"[^>]*>Context search<\/label>/.test(html), "context search label should say 'Context search'");

// HTML: context search placeholder should mention dot-append declaration format
assert(/Module or Module\.declaration/.test(html), "context search placeholder should indicate Module.declaration format");

// JS: DOM caching should be implemented for performance
assert(/function cacheDomElements\(\)/.test(mapJs), "cacheDomElements function should exist for DOM caching");
assert(/DOM\.flowchartWrap/.test(mapJs), "DOM cache should include flowchartWrap");
assert(/DOM\.moduleSearch/.test(mapJs), "DOM cache should include moduleSearch");

// JS: selectDeclaration should sync context search bar to dot-append format
assert(/picker\.value\s*=\s*mod\s*\+\s*"\."\s*\+\s*declName/.test(mapJs), "selectDeclaration should sync context search bar");

// JS: label wrap cache should use batch eviction
assert(/LABEL_WRAP_CACHE_EVICT_BATCH/.test(mapJs), "label wrap cache should use batch eviction constant");

// JS: closeModuleSearchOptions should also clear searchDeclSuggestions
assert(/searchDeclSuggestions\s*=\s*\[\]/.test(mapJs), "closeModuleSearchOptions should clear declaration suggestions");

// JS: extensionDeclarationCount helper should exist for extension-aware assurance
assert(/function extensionDeclarationCount\(/.test(mapJs), "extensionDeclarationCount function should exist for extension-aware assurance");

// JS: verifiableSurfaceArea helper should exist for combined coverage denominator
assert(/function verifiableSurfaceArea\(/.test(mapJs), "verifiableSurfaceArea function should exist for combined coverage denominator");

// JS: extensionDeclarationCount should be exposed via test hooks
assert(/extensionDeclarationCount:\s*extensionDeclarationCount/.test(mapJs), "extensionDeclarationCount should be exported via test hooks");

// JS: verifiableSurfaceArea should be exposed via test hooks
assert(/verifiableSurfaceArea:\s*verifiableSurfaceArea/.test(mapJs), "verifiableSurfaceArea should be exported via test hooks");

// CSS: cross-module declaration nodes should have dashed border
assert(/\.flow-node\.cross-module\s+rect\s*\{[^}]*stroke-dasharray/s.test(css), "cross-module declaration nodes should have dashed stroke");

console.log("map-toolbar.test: ok");
