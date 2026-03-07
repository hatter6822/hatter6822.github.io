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
assert(/<label for="module-search">Current module context<\/label>/.test(html), "toolbar should include module context search");
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

// JS: renderContextChooser should update label text for declaration context
assert(/label\.textContent\s*=\s*"Current declaration context"/.test(mapJs), "renderContextChooser should set label to declaration context when in declaration flow");
assert(/label\.textContent\s*=\s*"Current module context"/.test(mapJs), "renderContextChooser should set label to module context when in module flow");

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

// CSS: light-theme assurance fallback colors should be defined
assert(/\[data-theme="light"\]\s*\.flow-node\.assurance-linked/.test(css), "light-theme assurance fallback colors should be defined for linked level");
assert(/\[data-theme="light"\]\s*\.flow-node\.assurance-none/.test(css), "light-theme assurance fallback colors should be defined for none level");

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

console.log("map-toolbar.test: ok");
