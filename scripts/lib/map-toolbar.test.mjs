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

console.log("map-toolbar.test: ok");
