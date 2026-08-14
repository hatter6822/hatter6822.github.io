# seLe4n Simulator — Design Specification

> Status: **living spec**. Phase 1 (vertical slice) is implemented and shipped in this
> repository (`run.html`, `assets/js/run.js`, `assets/css/run.css`,
> `data/execution-traces.json`, `scripts/lib/trace-analysis.mjs`,
> `scripts/validate-traces.mjs`). Phases 2+ are specified here and not yet built.
>
> Audience: contributors to the seLe4n website and the upstream kernel trace-export tooling.

---

## 1. Vision

The codebase map (`map.html`) answers *"what is the kernel made of?"* — modules,
imports, theorem coupling, declarations. It is a **static structure** view.

The **Simulator** (`run.html`) answers a different question:

> *"What does the kernel **do**, step by step — and can I watch the machine-checked
> invariants hold while it does it?"*

It is a **dynamic behavior** view: an interactive, replayable, proof-aware
visualization of the seLe4n microkernel executing real traces. Threads move between
the CPU, the run queue, and IPC wait queues; capabilities are minted and revoked;
untyped memory is retyped; services start and stop — and at **every** step the
website surfaces the invariants that Lean has proven always hold.

The tagline: **"Watch the kernel run — and the proofs hold."**

### 1.1 Why this is uniquely possible for seLe4n

Two properties of the kernel make a faithful execution visualizer tractable and
honest in a way it would *not* be for a conventional C kernel:

1. **Every transition is a deterministic pure function.**
   `abbrev Kernel := SeLe4n.KernelM SystemState KernelError` is a state transformer
   `SystemState → Except KernelError (α × SystemState)`. Given the same input state
   and the same syscall, you always get the same output state. A trace is therefore a
   *reproducible* artifact, not a flaky recording of nondeterministic hardware.

2. **Every invariant is machine-checked.** `SeLe4n.Testing.InvariantChecks` exposes a
   library of *executable boolean* invariant checks (`endpointDualQueueWellFormedB`,
   `schedulerRunQueueUniqueB`, `currentThreadValidB`, `blockedOnReceiveNotRunnableChecks`,
   `cdtChildMapConsistentCheck`, …) that mirror the proven invariants
   (`apiInvariantBundle`, `proofLayerInvariantBundle`, and the 15 composed subsystem
   bundles). The kernel can evaluate these at every step of a trace and emit the
   results. The website doesn't *assert* the invariants hold — it *reports* that Lean
   proved they do, and that the executable checks agree at each replayed state.

This is the difference between a toy "OS animation" and a credible artifact: the
Simulator is a window onto a verified machine, not a re-imagining of one.

---

## 2. First principle: replay, do not re-simulate

**The website must never re-implement kernel semantics.** If JavaScript decided what
a syscall does, that logic would be unverified and could silently diverge from the
proven Lean kernel — quietly undermining the project's central claim.

Therefore the runtime is a **fold engine**, not a kernel. A trace records, for each
step, the *already-decided* effects as a small list of structured `ops` (a delta).
Replaying a scenario = folding those deltas over the initial state. The fold applies
effects; it never *computes* them.

### 2.1 The hybrid model (replay + clearly-labeled sandbox)

The product supports two modes, with a hard epistemic boundary between them:

| Mode | What it is | Trust |
|------|-----------|-------|
| **Replay** (default) | Faithful playback of kernel-emitted (or fixture) traces. | Verified — these are real machine-checked transitions. |
| **Sandbox** (opt-in, always labeled) | The user perturbs the *displayed* state with simple structural edits and watches a small set of **client-side** structural checks respond. | **Unverified** — JS checks, shown only to build intuition for what the proofs guarantee. |

The sandbox is deliberately limited and *honestly framed*. It exists to make the
proofs visceral: perturb the run queue to contain a duplicate, and watch
`schedulerRunQueueUnique` go red — *"this is exactly the state the Lean proof
guarantees the real kernel can never reach."* The sandbox never claims to execute
syscalls; it never writes back into a "verified" channel; and every sandbox surface
carries an **Unverified preview** banner.

---

## 3. Information architecture

```
run.html
├── shared chrome (nav, theme toggle, bg toggle, language switcher, footer)
├── hero
│   ├── title + lead
│   ├── status line + SOURCE BADGE  (verified kernel export · vX  |  reference fixture · schema vN)
│   └── provenance note (honest disclaimer when source ≠ kernel)
└── theater
    ├── TRANSPORT BAR   scenario ▾ | ◀ ▶/⏸ ▶ | ━━━●━━ scrubber | step n/N | [Sandbox]
    ├── caption (current step title, aria-live)
    ├── GRID
    │   ├── STAGE  (SVG scene — the kernel "in action")
    │   └── SIDE
    │       ├── INVARIANT RAIL   (machine-checked invariants; per-step status)
    │       └── INSPECTOR        (step detail: syscall, effects, source links; + selected object)
    ├── SANDBOX PANEL  (hidden until toggled; Unverified preview)
    └── EVENT LOG  ([TAG] trace lines, click to jump)
```

### 3.1 Transport bar

- **Scenario selector** — choose among the trace scenarios in the dataset.
- **Step controls** — previous / play-pause / next. Play auto-advances at a fixed
  cadence and stops at the last step.
- **Scrubber** — a range input over `[0, steps-1]` for O(1) seeking to any step.
- **Step counter** + **caption** — `n / N` and the current step's title.
- **Sandbox toggle** — enters/exits the unverified sandbox mode.

Keyboard: `Space` play/pause · `←`/`→` (or `h`/`l`) step · `Home`/`End` first/last.
All transport state is mirrored to the URL for deep links (§9).

### 3.2 The Stage (scenes)

The stage renders one **scene** at a time, switchable via a tab strip in the stage
header (and the `&scene=` URL parameter). Each scene is an SVG projection of the
current `SystemState`, laid out so that a kernel object lives in exactly the
structural location the kernel itself puts it. Phase 1 ships the **System**,
**Scheduler**, **Capability**, **Memory**, **VSpace**, **Information-flow**, and
**Services** scenes — covering every headline subsystem; later phases deepen them (§5).

The **System scene** is a two-column diagram:

- **Left column** — the scheduler's view of a core:
  - **CPU · core _k_** box holding the current thread chip.
  - **Run queue** box holding ready thread chips, ordered by descending priority
    (the same order `chooseThread` would consider them).
  - **Blocked (awaiting reply)** box holding threads that are blocked but not parked
    on a visible queue (e.g. `blockedOnReply`, `blockedOnCall`), which wait on a reply
    object rather than the endpoint's send/receive queues.
- **Right column** — IPC objects:
  - **Endpoint** boxes, each showing its `receiveQ` and `sendQ` with the blocked
    thread chips inside.
  - **Notification** boxes, each showing `state`, `badge`, and waiter chips.

A **thread chip** shows the thread label, a state dot colored by `threadState`
(Running / Ready / Blocked / Inactive), the abbreviated `ipcState`, and the priority.
A `pipBoost` badge appears when priority inheritance is active. Chips are clickable
(→ inspector) and keyboard-focusable.

The **Scheduler scene** re-projects the same state through the scheduler's eyes: the
current thread sits in a **CPU · core _k_** box, ready threads are grouped into
**priority buckets** (descending — the `RunQueue`'s `HashMap Priority (List ThreadId)`
shape), and threads the scheduler ignores fall into a dimmed **not-runnable** lane.
Each chip carries its **domain**, its **EDF deadline**, and a **CBS budget bar**
(`timeSlice / budgetMax`, turning red at zero) — so a viewer can *see* why
Earliest-Deadline-First breaks a priority tie, and watch a budget deplete until the
thread yields. The bundled `edf-budget-preempt` scenario drives exactly this. The scene
is **SMP-aware**: it renders one column (CPU + priority buckets) per core, so the
`smp-schedule` scenario shows two cores scheduling independently and a thread migrating
between them — and the System scene likewise renders one CPU box per core.

**Motion communicates causality.** Between steps:

- Entities touched by the current step's delta **pulse** (computed from the op list,
  not from a structural diff — exact and cheap).
- `message` ops animate a small **envelope** travelling from the sender chip to the
  receiver chip (Web Animations API; suppressed under `prefers-reduced-motion`).

### 3.3 Invariant rail

The rail lists the dataset's **invariant catalog** — each entry mapping a website
label to a real executable check in `SeLe4n.Testing.InvariantChecks` and to a
representative proof module. It is presented as a **full-width band beneath the
workspace**, grouped into subsystem mini-columns (IPC, Scheduler, Capabilities,
Memory, Information flow, Services) that tile responsively, with a summary chip
("All machine-checked invariants hold · N checked at this step"). This keeps the
catalog compact and scannable instead of a single long column. For the current step:

- Invariants the kernel **actively re-validated** at this transition
  (`step.invariants.checked`) are highlighted as **verified this step**.
- All others render as **holds** (green) — because the proofs guarantee they hold at
  every reachable state, exercised or not.
- Each rail item is a link to the relevant module on `map.html`
  (`map.html?module=<mapModule>`), tying the dynamic view back to the static proof
  structure. Hover reveals the underlying check function and Lean module.

In **sandbox** mode, the rail additionally runs the client-side structural checks and
flips the affected items to **violated** (red), with a summary banner explaining the
epistemics.

### 3.4 Inspector

Two stacked panels:

1. **Step detail** — kind badge (`boot`/`syscall`/`schedule`/`timer`/…), trace tag,
   actor; a plain-language **narrative**; a **state-changes** ribbon showing field-level
   before→after for every entity the step touched (diffing the previous and current
   folded states — e.g. `client · ipcState: ready → blockedOnReply:ep.svc`); the
   **syscall decode** (`id`, `gate`, `requiredRight`, `capPath`, `args`) when present; a
   human-readable **effects** list derived from the delta ops; and **source links** into
   `map.html` for each referenced declaration (`apiEndpointCall`, `chooseThread`, …).
2. **Selected object** — when a chip/box is selected, a field table projected from the
   current folded state (TCB fields, endpoint queues, notification state, …).

### 3.5 Event log

The `[TAG]`-prefixed trace lines (e.g. `ICR-001 syscall client → call(service-ep)`),
mirroring the kernel's existing human-readable harness output. The active line is
highlighted and kept visible **within the log panel only** (its own `scrollTop` is
nudged — never `scrollIntoView`, which would scroll the whole window down to this
bottom-of-page card on every replay step); clicking any line seeks to that step. This is
the bridge between the visual stage and the textual trace that
`SeLe4n.Testing.MainTraceHarness` already emits today.

---

## 4. Data model

### 4.1 Trace schema (v1)

A dataset is a single JSON document. Top level:

| Field | Type | Notes |
|-------|------|-------|
| `schemaVersion` | `1` | Bumped on breaking schema changes. |
| `source` | `"kernel"` \| `"fixture"` | Provenance. Drives the source badge + disclaimer. |
| `generator` | string | Tool that produced the file. |
| `disclaimer` | string | Honest description of provenance. |
| `kernelVersion`, `kernelCommit`, `leanToolchain` | string | Upstream identity. |
| `generatedAt` | ISO-8601 | Freshness (drives local-first selection). |
| `invariantCatalog[]` | object[] | The invariants surfaced in the rail (§4.3). |
| `scenarios[]` | object[] | The replayable executions (§4.2). |

### 4.2 Scenario

| Field | Type | Notes |
|-------|------|-------|
| `id`, `title`, `summary` | string | Identity + human description. |
| `tags[]` | string[] | e.g. `["ipc","scheduler","capability"]`. |
| `primaryScene` | string | Default scene for this scenario. |
| `objects` | map | `id → { label, kind }` display metadata (legend). |
| `initialState` | State | The bootstrap state (§4.4). |
| `steps[]` | Step | The ordered transitions (§4.5). |

### 4.3 Invariant catalog entry

```json
{
  "id": "schedulerRunQueueUnique",
  "label": "Run queue free of duplicates",
  "check": "schedulerRunQueueUniqueB",
  "module": "SeLe4n.Testing.InvariantChecks",
  "mapModule": "SeLe4n.Kernel.Scheduler.Invariant",
  "subsystem": "scheduler"
}
```

`check` is the executable boolean in `InvariantChecks`; `mapModule` is the proof
module the rail links to on `map.html`.

### 4.4 State projection

The state is a **display projection** of `SystemState` — faithful but compact, and
free of the internal representation (`RHTable`, `FrozenMap`, …) that the UI doesn't
need. Phase 1 fields:

```jsonc
{
  "current": { "thread": "th.client", "core": 0 },
  "threads": [
    { "id", "label", "priority", "domain", "ipcState", "threadState",
      "timeSlice", "deadline", "cspaceRoot", "vspaceRoot", "schedContext",
      "boundNotification", "pipBoost", "replyObject", "pendingReceiveReply" }
  ],
  "endpoints":     [ { "id", "label", "sendQ": [tid], "receiveQ": [tid] } ],
  "notifications": [ { "id", "label", "state", "waiters": [tid], "badge" } ],
  "runQueue":      { "0": [tid] },           // per-core, priority-ordered
  "cdt": {                                   // capability derivation tree (optional)
    "nodes": [ { "id", "label", "slot", "target", "rights", "badge" } ],
    "edges": [ [parentId, childId] ]
  },
  "untyped": [                               // untyped memory regions (optional)
    { "id", "label", "regionBase", "regionSize", "watermark", "isDevice",
      "children": [ { "id", "type", "size" } ] }
  ],
  "infoflow": {                              // security-domain flow policy (optional)
    "domains": [ { "id", "label", "confidentiality", "integrity" } ],
    "policy": [ [fromDomainId, toDomainId] ] // allowed flows
  },
  "services": [                              // service registry (optional)
    { "id", "label", "status", "deps": [serviceId] }
  ],
  "vspace": [                                // virtual address spaces (optional)
    { "id", "label", "asid",
      "mappings": [ { "vaddr", "paddr", "perms", "wx" } ],
      "tlb": [ "vaddr" ] }                    // cached translations (optional)
  ]
}
```

`ipcState` is a string; blocked states carry their target after a colon
(`"blockedOnReceive:ep.svc"`), mirroring the `ThreadIpcState` constructors. Scheduler
fields like `domain`, `deadline`, and `budgetMax` feed the Scheduler scene. The optional
`cdt`, `untyped`, `vspace`, `infoflow`, and `services` blocks feed the Capability,
Memory, VSpace, Information-flow, and Services scenes. The optional `vspace[].tlb` array
holds the virtual addresses with cached translations; `vspaceMap` caches a page and
`vspaceUnmap` shoots it down, so the VSpace scene can show stale-entry eviction. Later
phases extend the projection further with `cnodes` (§5) — all additive.

### 4.5 Step + delta op vocabulary

```jsonc
{
  "index": 1,                       // sequential from 0
  "kind": "syscall",                // boot|syscall|schedule|timer|ipc|fault|interrupt
  "title": "client → call(service-ep)",
  "traceTag": "ICR-001",            // mirrors harness [TAG] codes
  "actor": "th.client",
  "syscall": { "id", "gate", "requiredRight", "capPath", "args" },
  "narrative": "…plain language…",
  "sourceRefs": [ { "label": "apiEndpointCall", "module": "SeLe4n.Kernel.API" } ],
  "delta": { "ops": [ … ] },
  "invariants": { "allHold": true, "checked": ["…ids…"], "failed": [] }
}
```

The **op vocabulary** is intentionally small and structural — it expresses *effects*,
never *decisions*:

| Op | Effect on the projected state |
|----|------------------------------|
| `setCurrent {thread, core?}` | Set the current (running) thread / core. |
| `threadPatch {id, set}` | Shallow-merge fields into a TCB. |
| `epEnqueue {endpoint, queue, thread}` | Append a thread to an endpoint `sendQ`/`receiveQ`. |
| `epDequeue {endpoint, queue, thread}` | Remove a thread from an endpoint queue. |
| `rqInsert {core, thread}` | Insert into the run queue, priority-ordered, idempotent. |
| `rqRemove {core, thread}` | Remove from the run queue. |
| `notifPatch {id, set}` | Shallow-merge fields into a Notification. |
| `cdtInsert {node, parent?}` | Add a capability node to the CDT; optionally as a child of `parent` (mint/copy derivation). |
| `cdtRemove {node}` | Remove a CDT node and all its descendants (strict revoke / delete). |
| `cdtPatch {id, set}` | Shallow-merge fields into a CDT node. |
| `untypedRetype {untyped, child}` | Carve a typed object out of an untyped region; advance the watermark by its size. |
| `untypedRevoke {untyped}` | Reclaim every object carved from an untyped region; reset the watermark to zero. |
| `flowCheck {from, to, allowed}` | Event-only; the Information-flow scene draws the attempted flow allowed or blocked. |
| `ifPolicyAdd {from, to}` | Add an allowed-flow edge to the policy (authorized declassification). |
| `ifPolicyRemove {from, to}` | Remove an allowed-flow edge from the policy. |
| `servicePatch {id, set}` | Shallow-merge fields (e.g. `status`) into a service registry entry. |
| `vspaceMap {vspace, mapping}` | Add a page mapping (`vaddr`→`paddr`, `perms`) to an address space; caches the `vaddr` in the TLB. |
| `vspaceUnmap {vspace, vaddr}` | Remove a page mapping and shoot down its TLB entry. |
| `vspaceReject {vspace, mapping}` | Event-only; the VSpace scene shows a W^X-violating map as rejected. |
| `message {from, to, endpoint, registers, caps}` | Event-only (animation/log); no state change. |
| `note {text}` | Event-only annotation. |

Replaying = folding each step's ops over `initialState`. The canonical fold engine
lives in `scripts/lib/trace-analysis.mjs` (Node, unit-tested); the browser runtime
(`assets/js/run.js`) carries a byte-faithful re-implementation of the *same* op
vocabulary so the two cannot drift (the test suite pins the canonical behavior).

### 4.6 Validation

`scripts/lib/trace-analysis.mjs#validateTraceDataObject` and the
`scripts/validate-traces.mjs` CLI enforce:

- `schemaVersion`, `source`, ISO `generatedAt`.
- Non-empty, well-formed `invariantCatalog`; unique ids.
- Per-scenario: valid `initialState`; non-empty `steps`; **sequential** indices;
  allowed `kind`/op names; `invariants.allHold` boolean; every `checked` id resolves
  in the catalog; no `allHold && failed` contradiction.
- A full **fold pass**: every op reference resolves (no dangling thread/endpoint/
  notification ids), and **no run queue ever contains a duplicate** (a cheap structural
  echo of `schedulerRunQueueUniqueB` that also guards authored fixtures).

---

## 5. Scene catalog (roadmap)

The System scene (Phase 1) already exercises the scheduler + IPC structure. Future
scenes are focused lenses over the same fold engine and (extended) state projection:

| Scene | Shows | Backing kernel concepts |
|-------|-------|------------------------|
| **System** *(shipped)* | CPU, run queue, blocked lane, endpoints, notifications, message flow. | `SchedulerState`, `Endpoint`, `Notification`, `ThreadIpcState`. |
| **Scheduler** *(shipped)* | **SMP**: one column per core (CPU + priority buckets), EDF deadlines, CBS budget bars, thread migration, dimmed not-runnable lane. *(Per-domain partitioning and PIP boost chains are future depth.)* | `RunQueue`, `chooseThread`, `cbs_bandwidth_bounded`, `CrossSubsystemPerCore`. |
| **IPC** | Endpoints with dual queues, call/reply pairing, reply objects, donation chains, badge/notification signalling. | `IPC.DualQueue.*`, `donationChainAcyclic`, `notificationSignal/Wait`. |
| **Capabilities / CDT** *(shipped)* | The capability derivation tree as a tidy tree — minting/copying derive child capabilities, a strict revoke prunes a node and all its descendants — with target, rights, badge, and slot per node. *(A dedicated CNode-slot grid is future depth.)* | `CapDerivationTree` (`childMap`/`parentMap`), `cspaceRevokeCdtStrict`. |
| **Memory** *(untyped shipped)* | Untyped regions as watermarked bars with typed objects carved out (retype advances the watermark; revoke reclaims the region). | `UntypedObject`, `retypeFromUntyped`, `untypedWatermarkChecks`. |
| **VSpace** *(shipped)* | Per-address-space page-mapping rows with permissions and W^X status; a writable-and-executable map is rejected, never stored. A TLB row shows cached translations: a map caches its page, an unmap shoots it down (with a `⚡ shootdown` marker), and a validator flags any TLB entry left without a backing mapping. | `mapPage`/`unmapPage`, `PagePermissions.wxCompliant`, `vspaceAsidUniquenessChecks`, `tlbConsistent`. |
| **Services** *(shipped)* | Dependency DAG laid out by topological level, with lifecycle status (running/stopped/broken) and dependency-ordered start / fault / restart; the graph stays provably acyclic. | `Service.Operations`, `serviceGraphAcyclicityChecks`. |
| **Information flow** *(shipped)* | Security-domain lattice (ordered by confidentiality) with allowed-flow policy arcs and the current step's flow check drawn allowed (green) or blocked (red); an `ifPolicyAdd` declassification edge can unblock a flow. | `DomainFlowPolicy`, `NonInterferenceStep`, `securityFlowsTo`, `isDeclassificationAuthorized`. |

Scene switching is additive: a scene tab strip in the stage header; the active scene
is part of the URL state (`&scene=`). Each scene reads the same folded state and the
same step deltas, projecting whichever facet it specializes in.

---

## 6. Upstream integration — how the kernel emits traces

Phase 1 ships a **hand-authored reference fixture** (`source: "fixture"`) that
conforms to the schema. The honest end state is for the **kernel** to emit the
artifact, so the website replays real machine-checked runs (`source: "kernel"`).

Proposed upstream work (in the `hatter6822/seLe4n` repo):

1. **`SeLe4n/Testing/TraceExport.lean`** — a structured-trace recorder. Today
   `MainTraceHarness` interleaves `IO.println "[TAG] …"` calls. The recorder wraps the
   same operations so that, for each transition, it captures: the syscall/decode, the
   structured effects (as the op vocabulary above), `reprStr`-projected before/after
   state, the `traceTag`, and the result of `assertStateInvariantsFor` /
   `stateInvariantChecks` (→ `invariants.checked` + `allHold`).
2. **JSON encoding** — a small `ToJson`-style encoder for the projection (the kernel is
   Lean; it can serialize the display projection directly; the website never parses
   `reprStr`).
3. **CI artifact** — emit `docs/execution-traces.json` alongside the existing
   `docs/codebase_map.json`. The website's sync + live-refresh then consume it exactly
   like the map data.
4. **Determinism guarantee** — because transitions are pure, the exported trace is
   reproducible and diffable in CI (a regression in behavior shows up as a trace diff).

The website side is already wired: `scripts/sync-trace-data.mjs` fetches and validates
this artifact (schema + a full fold dry-run) and 404s gracefully to the bundled fixture,
so the only remaining work to reach `source: "kernel"` is upstream.

Crucially, the **op vocabulary is the contract** between kernel and website. The
recorder emits ops; the website folds them. Neither side needs to understand the
other's internals.

A concrete, reference-level implementation plan — the `SystemState`→projection mapping,
two op-emission strategies (instrumented vs. snapshot-diff), a Lean `TraceExport.lean`
sketch, and the end-to-end verification loop — lives in
[UPSTREAM_TRACE_EXPORT.md](UPSTREAM_TRACE_EXPORT.md).

---

## 7. Website data pipeline

Mirrors the established map/site pipeline (local-first, cache, graceful live refresh):

```
upstream docs/execution-traces.json  (source: "kernel")
        │  scripts/sync-trace-data.mjs   (fetch + validate + write — shipped)
        ▼
data/execution-traces.json            (bundled snapshot, committed)
        │  load order at runtime (assets/js/run.js):
        ▼
1. read localStorage cache (sele4n-exec-traces-v1, schema-versioned, TTL + max-stale)
2. fetch bundled data/execution-traces.json
3. choose freshest by generatedAt
4. best-effort live refresh from raw.githubusercontent.com/.../docs/execution-traces.json
   (404 today → silent fallback to local; no new CSP origin required)
```

All fetched payloads pass `isValidTraceData` (schema + foldability) before adoption, so
malformed remote data can never corrupt the view.

**Files (Phase 1, shipped):**

| File | Role |
|------|------|
| `run.html` | Page skeleton (mirrors `map.html`: CSP, theme-init, i18n, nav, bg, footer). |
| `assets/js/run.js` | Runtime: fold engine, SVG stage, rail, inspector, log, transport, sandbox, data load. |
| `assets/css/run.css` | Page styles (reuses `style.css` tokens). |
| `data/execution-traces.json` | Bundled reference fixture (9 scenarios, 45 steps). |
| `scripts/sync-trace-data.mjs` | Fetches + validates upstream `docs/execution-traces.json`; 404s gracefully to the bundled fixture. |
| `scripts/lib/trace-analysis.mjs` | Canonical fold engine + validator (Node). |
| `scripts/lib/trace-analysis.test.mjs` | Unit tests (14 tests, `node:test`). |
| `scripts/validate-traces.mjs` | CLI validator (Tier 2). |
| `locales/en.json` | `run.*`, `nav.run`, `meta.run_*` keys. |

**Files (Phase 2+, planned):** a `scripts/theater-smoke.py` Playwright probe.

---

## 8. Technology & cross-cutting concerns

- **Rendering** — hand-rolled **SVG** + the **Web Animations API**, consistent with
  `map.js`. SVG is accessible, theme-able via CSS custom properties, and crisp at any
  zoom. No frameworks, no D3, no bundler. WebGL is reserved for the background.
- **Strict CSP** — identical to the other pages (`default-src 'self'`,
  `script-src 'self'`, `connect-src` limited to `api.github.com` +
  `raw.githubusercontent.com`). No inline scripts/styles, no `eval`, no `innerHTML`
  from trace data (all data rendered via `textContent`/`createElement`).
- **Performance** — delta-fold with per-step snapshots precomputed on scenario load
  (O(1) seeking); `requestAnimationFrame`-batched renders; DOM lookups cached at boot;
  CSS `contain` on the stage; touched-entity highlighting computed from ops (no diff).
  At larger scale: keyframe snapshots every N steps + virtualized event log.
- **Accessibility** — full keyboard transport; `prefers-reduced-motion` disables
  animation and snaps to states; `aria-live` on caption/status/inspector; chips and
  the stage are focusable and labeled; the rail is a semantic list with links.
- **i18n** — `data-i18n` on static chrome + `window.sele4nI18n.t()` (with English
  literal fallbacks) for dynamic strings; re-render on `sele4n:locale-changed`.
- **Theming** — light/dark via `data-theme` and the shared tokens; the theme + bg
  toggles reuse the exact `map.js` handlers.
- **Mobile** — single-column grid, scene tabs, enlarged touch targets, scrollable
  stage; message animation degrades gracefully.

## 9. URL state & deep links

`run.html?scenario=<id>&step=<n>&scene=<system|scheduler>&object=<id>&sandbox=1`. State
is written with `history.replaceState` (no history spam) and parsed on load, so any
step of any scenario in any scene is shareable and bookmarkable — including a selected
object.

## 10. Security posture

- No new CSP origins. Trace data comes from `self` (bundled) or the already-allowed
  `raw.githubusercontent.com`.
- Remote/cached data is treated as **untrusted**: strict schema validation + a fold
  dry-run gate adoption; rendering never interpolates data into HTML; future work caps
  payload size and step counts to avoid pathological inputs.
- The sandbox cannot escape into the verified channel; it operates on a throwaway state
  clone and is always labeled unverified.

## 11. Testing strategy

| Tier | Scope | Command |
|------|-------|---------|
| 0 | JS syntax | `node --check assets/js/run.js` |
| 1 | Unit: fold engine + validator, and a headless `run.js` execution test | `node scripts/lib/trace-analysis.test.mjs` · `node scripts/lib/run-runtime.test.mjs` |
| 2 | Bundled trace integrity | `node scripts/validate-traces.mjs` |
| 3 | Manual browser (desktop + mobile, light + dark, reduced-motion) | — |
| 4 | Playwright transport/stepping probe *(Phase 2)* | `scripts/theater-smoke.py` |

`scripts/lib/run-runtime.test.mjs` boots the real `run.js` inside a `vm` context backed
by a minimal DOM shim (no jsdom dependency) and asserts the end-to-end pipeline — data
load → stage render → transport stepping → scene switching → deep-link state → sandbox
perturbation breaking a structural check — all without a browser.

---

## 12. Phased roadmap

- **Phase 1 — Vertical slice (shipped).** Schema v1, fold engine + tests + validator +
  headless runtime test + `sync-trace-data.mjs`, **all seven scenes** (System, Scheduler,
  Capability, Memory, VSpace, Information-flow, Services) covering every headline
  subsystem, with tab switching, the invariant rail, inspector, event log, transport,
  deep-link URL state (incl. `scene`), the clearly-labeled sandbox, full
  chrome/i18n/theming, a per-step state-diff ribbon, SMP-aware Scheduler/System scenes,
  and a 9-scenario reference fixture (IPC call/reply, notification signal/wait, EDF budget
  preemption, capability mint/revoke, untyped retype/reclaim, information-flow
  non-interference, service lifecycle, VSpace W^X, multi-core scheduling). Honest
  provenance via the source badge + disclaimer.
- **Phase 2 — Upstream truth.** Add `SeLe4n/Testing/TraceExport.lean` + a CI artifact in
  the kernel repo, then flip the bundled snapshot to `source: "kernel"` — the
  website-side `sync-trace-data.mjs` and the headless runtime test are already in place.
  Add a Playwright transport probe.
- **Phase 3 — Scene depth.** A dedicated IPC scene (call/reply pairing, donation chains)
  beyond the System scene's structure; a CNode-slot grid alongside the CDT; per-domain
  scheduler partitioning and PIP boost chains. *(All seven subsystem scenes, the scene-tab
  infrastructure, SMP scheduling, and the state-diff ribbon already ship in Phase 1.)*
- **Phase 4 — Hardware depth.** TLB caching with shootdown-on-unmap already ships in the
  VSpace scene (with a stale-entry validator); remaining depth is richer multi-core visuals
  (per-core timers, IPI) and multi-level page-table walks. 
- **Phase 5 — Exploration.** A per-step causality graph ("why did this happen"); a richer
  sandbox (more structural checks, guided challenges); trace search/filter.

## 13. Documentation sync

Changes here must keep in sync: `README.md` (page list + commands), `CONTRIBUTING.md`
(required checks), `docs/TESTING.md` (tiers + commands), `CLAUDE.md` (build commands +
file tables), and — when scenes/schema change — this spec.
