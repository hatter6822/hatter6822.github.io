# seLe4n Simulator — Design Specification

> Status: **living spec**. Phases 1 and 3 (trace schema **v3**, six scenes) are
> implemented and shipped in this repository (`run.html`, `assets/js/trace-engine.js`,
> `assets/js/run.js`, `assets/css/run.css`, `data/execution-traces.json`,
> `scripts/lib/trace-analysis.mjs`, `scripts/lib/trace-anchors.mjs`,
> `scripts/validate-traces.mjs`, `scripts/run-smoke.mjs`). Anything marked
> *roadmap* or *Phase 2+* is specified here and not yet built.
>
> Audience: contributors to the seLe4n website and the upstream kernel trace-export tooling.

---

## 1. Vision

The codebase map (`map.html`) answers *"what is the kernel made of?"* — modules,
imports, theorem coupling, declarations. It is a **static structure** view.

The **Simulator** (`run.html`) answers a different question:

> *"What does the kernel **do** at each step, **how** does it check that the step is
> allowed, and **why** is the result safe?"*

It is a **dynamic behavior** view: an interactive, replayable, proof-aware
visualization of the seLe4n microkernel stepping through scenarios. Threads move
between the CPU, the run queue and IPC wait queues; capabilities are minted, attenuated
and revoked; untyped memory is carved and reset; declassifications are audited. For
every step the page shows three things side by side: the **state change**, the
**checked syscall path** that allowed or refused it (down to the stage that refused and
the `KernelError` it returned), and the **security properties and invariants** the step
relies on, each linked to the Lean declaration that states or proves it.

The tagline: **"What the kernel does, how it checks, and why it is safe."**

The scenarios shipped today are a hand-written fixture (`source: "fixture"`), not a
replay of a kernel run — the kernel does not export traces yet (§6). What *is* the
kernel's own is every name a step cites: each function, theorem, predicate, syscall,
right and error is resolved in the pinned seLe4n checkout by the sync, which refuses to
publish a trace naming anything the kernel does not have (§7).

### 1.1 Why this is uniquely possible for seLe4n

Two properties of the kernel make a faithful execution visualizer tractable and
honest in a way it would *not* be for a conventional C kernel:

1. **Every transition is a deterministic pure function.** The kernel monad is
   `KernelM σ ε α := σ → Except ε (α × σ)` (`SeLe4n.Prelude`), and
   `Kernel := KernelM SystemState KernelError` (`SeLe4n.Model.State`). Given the same
   input state and the same syscall you always get the same result, so a trace is a
   *reproducible* artifact, not a recording of nondeterministic hardware. The type says
   one more thing the page relies on: an `error` carries **no successor state**, so a
   refused syscall cannot leave a partial change behind. That is why a refused step in
   a trace may carry no state-changing op (§4.7), and why the page's "a refused syscall
   changes nothing" card cites `KernelM` and `Kernel` rather than a theorem.

2. **The invariants are proved, not just tested.** Each invariant the page lists is a
   Lean predicate over the whole `SystemState`, and the guarantee that it holds is its
   **preservation theorems** — a transition that starts in a state satisfying the
   predicate ends in one that satisfies it too. `syscallEntry_preserves_proofLayerInvariantBundle`
   lifts the 16-conjunct bundle to the syscall entry, taking per-operation
   preservation as a hypothesis that the per-operation theorems discharge. `SeLe4n.Testing.InvariantChecks` also carries
   executable boolean checks (`schedulerRunQueueUniqueB`, `currentThreadValidB`,
   `cdtChildMapConsistentCheck`, …) that the kernel's test harness runs; those are
   **tests**, and the page labels them "test harness, not a proof". The website does
   not *assert* that an invariant holds; it names the predicate and the theorems that
   prove it is preserved, and links both at the commit they were read from.

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
| **Replay** (default) | Playback of the bundled trace: a kernel export once one exists, the hand-written fixture today. | The fold is exact, but the steps are only as true as their source: a `fixture` step is an illustration whose *names* are grounded in the kernel; a `kernel` step would be a real run. The source badge says which. |
| **Sandbox** (opt-in, always labeled) | The user perturbs the *displayed* state with simple structural edits and watches a small set of **client-side** structural checks respond. | **Unverified** — JS checks, shown only to build intuition for what the proofs guarantee. |

The sandbox is deliberately limited and *honestly framed*. It exists to make the
proofs visceral: perturb the run queue to contain a duplicate, and watch the
`runQueueUnique` invariant go red — *"this is exactly the state the Lean proof
guarantees the real kernel can never reach."* The sandbox never claims to execute
syscalls; it never writes back into a "verified" channel; and every sandbox surface
carries an **Unverified preview** banner.

---

## 3. Information architecture

```
run.html
├── shared chrome (nav, theme toggle, language switcher, footer)
├── hero
│   ├── title ("What the kernel does, how it checks, and why it is safe") + lead
│   ├── SOURCE BADGE  (kernel export · vX  |  hand-written scenarios · names grounded in seLe4n vX)
│   ├── provenance  ("Every link opens the kernel at commit <sha7>", linked to that tree)
│   ├── status line (loading / error, aria-live)
│   └── fixture note (why the scenarios are hand-written, and what is still the kernel's own)
└── theater
    ├── SCENARIO BAR    scenario ▾ | summary | "Demonstrates" property chips
    ├── TRANSPORT BAR   ◀ ▶/⏸ ▶ | ━━━●━━ scrubber | step n/N | [Sandbox]
    ├── caption (current step title, aria-live)
    ├── GRID
    │   ├── STAGE      (scene tabs + SVG scene — the kernel state)
    │   └── INSPECTOR  (what happened · kernel path · why it's safe · state changes · source
    │                   · selected object)
    ├── SECURITY GUARANTEES band  (one card per property; the step's own highlighted)
    ├── KERNEL INVARIANTS <details> (catalogue grouped by subsystem; per-step status)
    ├── SANDBOX PANEL  (hidden until toggled; Unverified preview)
    └── STEPS LOG      ([TAG] lines with the refusal error, click to jump)
```

### 3.1 Scenario bar and transport

- **Scenario selector** — choose among the trace scenarios in the dataset. Beside it,
  the scenario's `summary` and a **Demonstrates** row: one chip per id in
  `scenario.properties`, each linking to that property's card in the guarantees band.
- **Step controls** — previous / play-pause / next. Play auto-advances at a fixed
  cadence and stops at the last step.
- **Scrubber** — a range input over `[0, steps-1]` for O(1) seeking to any step.
- **Step counter** + **caption** — `n / N` and the current step's title.
- **Sandbox toggle** — enters/exits the unverified sandbox mode.

Keyboard: `Space` play/pause · `←`/`→` (or `h`/`l`) step · `Home`/`End` first/last.
All transport state is mirrored to the URL for deep links (§9).

### 3.2 The Stage (scenes)

The stage renders one **scene** at a time, switchable via a tab strip in the stage
header (and the `&scene=` URL parameter). Six scenes ship (`SCENES` in `run.js`), each a
different lens over the same folded state and the same step:

| Scene | Offered when | What it draws |
|-------|--------------|---------------|
| **Kernel path** (`path`) | any step is a syscall or a dispatch | The registers the kernel decodes (x0 CPtr, x1 `MessageInfo` split into its length / extraCaps / label bit fields, x2–x5 message registers, x7 syscall number); the CPtr walked through the caller's CSpace, guard bits then radix bits per CNode, to the slot it lands on and the capability's rights against the one required; the six-stage gate pipeline (`entry → decode → lookup → rights → flow → operation`) with each stage passed, failed with its `KernelError`, or not reached. A timer step draws the budget tick; a dispatch draws the scheduler's selection: every candidate it weighed, why each one lost (lower priority, later deadline, FIFO order, no budget, wrong domain) and the bucket fallback when the top bucket has no eligible thread. |
| **IPC** (`ipc`) | the state has an endpoint or a notification | Threads on the left; endpoints (send and receive queues), notifications (the pending word drawn bit by bit, its state and its waiters) and reply objects (the caller waiting for the answer) on the right. Wait edges join each blocked thread to the object it waits on; a delivered message is drawn sender → object → receiver with its label, length and badge. |
| **Scheduler** (`scheduler`) | always | One box per core: the running thread with its time-slice or budget meter, then the run queue as priority buckets, highest first, with the next pick marked and every ineligible entry labelled with the reason. Not-runnable threads below, then the scheduling contexts (budget, remaining, period, EDF deadline, next refill). |
| **CSpace** (`cspace`) | the state has a CNode | Each CNode as its slot strip (2^radix slots) with its geometry: depth = guard bits (and guard value) + radix bits. An occupied slot shows its kind, target, rights and badge; a slot this step looked up, inserted, deleted or revoked is marked. Derivation edges arch over the grid from parent slot to child slot. |
| **Memory** (`memory`) | the state has an untyped region or an address space | Untyped regions drawn to scale, with the carved children laid out from the base and the watermark marked. A refused retype draws the request where it would have gone, cut with a jagged edge at the region's end (`untypedRegionExhausted`). Each address space lists its mappings with permissions, a W^X verdict and the core's TLB state (cached, uncached, shot down); a refused W+X mapping is drawn as a rejected row and never stored. |
| **Information flow** (`infoflow`) | the state has at least two labels | The four-point label lattice (confidentiality low/high × integrity trusted/untrusted) with the order arrows, each label's members, the declassification policy as curves under the lattice, this step's flow checks recomputed from the labels (allowed, denied, same label), and the declassification audit log. |

A scenario names its own default scene as `focus`; the URL's `scene=` overrides it
when that scene is offered. The tabs are a WAI-ARIA tablist: arrow keys, `Home` and
`End` move between them.

**Every scene is drawn at 1:1.** The SVG takes its natural width (`max-width: none` at
every viewport) and the stage shell scrolls when it is wider; `.theater-page
.container` widens to 92rem so the 954px stage fits a 1440px desktop without scrolling.
A label that could outgrow its box is measured and clipped with an ellipsis, the full
text in a `<title>`, rather than overflowing; `scripts/run-smoke.mjs` walks every
scene of every step of every scenario and fails on any text past the SVG's edge.

**Motion communicates causality.** Every object the step's ops touch is marked
(`E.touched(ops)`, computed from the op list, not from a structural diff — exact and
cheap); a delivered message's path draws itself in. Animation is suppressed under
`prefers-reduced-motion`.

Every drawn object carries `data-object`; clicking it (or pressing Enter on it) opens
it in the inspector.

### 3.3 Security guarantees band and invariant catalogue

Schema v1 had one "invariant rail" that labelled every invariant green at every step
and named a test function as the evidence. Schema v2 separates the two things a reader
wants to know — *what is guaranteed* and *what is preserved* — and names a proof for
each.

**Security guarantees** (`#guarantees`, a full-width band beneath the workspace) renders
one card per entry of `propertyCatalog` (§4.3). The scenario's own properties come first,
in the order `scenario.properties` lists them, then the rest of the catalogue; the cards
keep their places as the step moves, so the highlight is the only thing that changes.
Each card shows the property's `label`, its `statement`, its `caveat` under **Scope**
when it has one, the theorems that state or prove it (each a grounded source link), and
chips for the invariants it rests on, linking into the catalogue below (a chip is marked
when the current step preserves that invariant). A card is **highlighted** when the
current step lists it in `step.guarantees`. A summary line above the grid says what the
step relies on:

- a refused step: "Refused with `<error>` at the `<stage>` stage: the kernel returned
  no successor state, so nothing changed";
- a step with guarantees: "This step relies on …" with their labels;
- the boot step: an introduction to the highlighted cards;
- anything else: "This step is bookkeeping: it relies on no security property beyond
  the invariants it preserves."

**Kernel invariants** (`#invariant-details`, a collapsed `<details>`) renders
`invariantCatalog` (§4.4) grouped by subsystem (IPC, Scheduler, Capabilities, Memory,
Information flow, then any other). Each entry shows its `label`, its `meaning`, its
**Predicate**, its **Preserved by** theorems and, when present, its **Runtime check**
labelled "test harness, not a proof" — all grounded links. Its status at the current
step is one of:

- **preserved** — the step lists it in `step.invariants.preserved`: this transition is
  covered by a preservation theorem;
- **holds** — part of the kernel's proved state and not touched here;
- **violated** — only in the sandbox, when `E.checkState` reports it broken (§3.6).

Following a link to an `#invariant-…` anchor opens the `<details>` first, so an anchor is
never inside a closed disclosure. In **sandbox** mode the catalogue opens, the
executable mirrors (§3.6) decide the status of the invariants they approximate, each
violation shows its reason, and the summary explains that these checks are unverified
JavaScript.

### 3.4 Inspector

The inspector answers *what happened, how the kernel checked it, and why it is safe*,
in that order. Sections appear only when the step has something to put in them.

1. **Head** — kind badge (`boot`/`syscall`/`schedule`/`timer`/…), trace tag, an
   **outcome badge** (`completed`, or `refused · <KernelError>`) and the actor; then the
   step title and its plain-language **narrative**.
2. **Kernel path** — for a syscall: the `SyscallId`, the right it **requires**
   (`syscall.requiredRight`, checked against `syscallRequiredRight` by the sync), and the
   `capPath` the caller's CSpace resolved. Below it, a **stage strip** over `step.path`
   (entry → decode → lookup → rights → flow → operation): each stage shows its label and
   grounded source link and is marked pass ✓, fail ✕ or skip –. The refusing stage names
   the `KernelError` it returns; every stage after it reads "not reached".
3. **Why it's safe** — on a refused step, a failure-atomicity note (a transition has
   type `σ → Except ε (α × σ)`, so an error carries no state and cannot leave a partial
   change). Then each property in `step.guarantees` with its first theorem, and each
   invariant in `step.invariants.preserved` with its first preservation theorem.
4. **State changes** — field-level before→after for every entity the step touched
   (diffing the previous and current folded states — e.g.
   `client · ipcState: ready → blockedOnReply:ep.svc`), including CDT `derived` /
   `destroyed` rows and a `derivations` count when a revoke prunes descendants, untyped
   `watermark` and carved `objects`, VSpace mappings and TLB entries, and the audit log's
   `entries`. When nothing changed the section says so ("None: the kernel state after
   this step equals the state before it") rather than going blank — on a refused step
   that sentence *is* the point. A human-readable list of the delta's ops follows,
   event-only ops marked as such.
5. **Source** — each `step.sourceRefs` entry as a grounded link to its line, plus a
   link to its module on the code map (production `SeLe4n.*` modules only; the
   testing framework is not on the map).
6. **Selected object** — when a chip/box is selected, a field table projected from the
   current folded state (TCB fields, endpoint queues, notification state, …).

### 3.5 Steps log

The `[TAG]`-prefixed trace lines (e.g. `ICR-001 syscall client → call(service-ep)`),
mirroring the kernel's existing human-readable harness output; a refused step carries its
`KernelError` at the end of the line. The active line is
highlighted and kept visible **within the log panel only** (its own `scrollTop` is
nudged — never `scrollIntoView`, which would scroll the whole window down to this
bottom-of-page card on every replay step); clicking any line seeks to that step. This is
the bridge between the visual stage and the textual trace that
`SeLe4n.Testing.MainTraceHarness` already emits today.

### 3.6 Sandbox

Toggling **Sandbox** reveals a panel of perturbations and a reset. Each perturbation
edits a **copy** of the displayed state to break one invariant the catalogue names, and
is offered only where it applies to that state:

| Perturbation | Breaks |
|--------------|--------|
| enqueue the running thread | `queueCurrentConsistent` |
| duplicate a run-queue entry | `runQueueUnique` |
| wake a blocked thread | `blockedNotRunnable` |
| orphan a derivation (CDT edge to an empty slot) | `cdtLinksAgree` |
| map a page writable and executable | `wxExclusive` |
| leave a stale TLB entry | `tlbConsistent` |
| overspend a scheduling-context budget | `budgetWithinBounds` |
| carve overlapping objects | `untypedNonOverlap` |

The verdict comes from `E.checkState` — the same executable mirrors the validator runs
over every bundled step — so the invariant catalogue opens and marks what broke, with
the reason. The panel's banner says **Unverified preview**: the mirrors are JavaScript
approximations, not the Lean proofs, and the sandbox never runs a syscall.

---

## 4. Data model

### 4.1 Trace schema (v3)

A dataset is a single JSON document. Top level:

| Field | Type | Notes |
|-------|------|-------|
| `schemaVersion` | `3` | `SCHEMA_VERSION` in `assets/js/trace-engine.js`; the browser refuses any other value. |
| `source` | `"kernel"` \| `"fixture"` | Provenance. Drives the source badge; `validate-traces.mjs` warns when it is not `kernel`. |
| `generator` | string | Tool that produced the file (`hand-authored-reference-fixture` today). |
| `disclaimer` | string | Honest description of provenance. |
| `kernelVersion`, `leanToolchain` | string | Upstream identity. The sync overwrites `kernelVersion` with the version it read from the checkout. |
| `generatedAt` | ISO-8601 | When the document was produced. |
| `sourceRef` | 40-hex commit | **Stamped by the sync**: the seLe4n commit every `path`/`line` was read at. Every source link opens this revision. |
| `kernelCommit` | string | Stamped by the sync: the first seven characters of `sourceRef`. |
| `propertyCatalog[]` | object[] | The security guarantees (§4.3). Non-empty. |
| `invariantCatalog[]` | object[] | The kernel invariants (§4.4). Non-empty. |
| `scenarios[]` | object[] | The replayable executions (§4.2). Non-empty. |

The bundled document has 10 scenarios (60 steps), 9 properties and 17 invariants:

| Scenario | Opens on | Demonstrates | Refused steps |
|----------|----------|--------------|---------------|
| `ipc-call-reply` | IPC | authority, flowPolicy, invariants, scheduling | — |
| `capability-gate` | Kernel path | authority, failureAtomic | `illegalAuthority`, `invalidCapability` |
| `notification-signal` | IPC | authority, flowPolicy, invariants | — |
| `scheduler-buckets` | Scheduler | scheduling, invariants | — |
| `budget-edf` | Scheduler | scheduling, invariants | — |
| `capability-derivation` | CSpace | authority, attenuation, failureAtomic, invariants | `invalidCapability` |
| `untyped-retype` | Memory | memoryIsolation, authority, failureAtomic, invariants | `revocationRequired`, `untypedRegionExhausted` |
| `vspace-wx` | Memory | wx, memoryIsolation, authority, failureAtomic | `invalidSyscallArgument` |
| `information-flow` | Information flow | flowPolicy, noninterference, failureAtomic, authority | `flowDenied` |
| `smp-affinity` | Scheduler | authority, scheduling, failureAtomic | `threadOnDifferentCore` |

### 4.2 Scenario

| Field | Type | Notes |
|-------|------|-------|
| `id`, `title`, `summary` | string | Identity + human description. |
| `properties[]` | string[] | **Required, non-empty.** Ids from `propertyCatalog` this scenario demonstrates; the scenario bar's "Demonstrates" chips and the guarantees band's ordering. |
| `focus` | string | Optional. The scene the scenario opens on (one of `SCENES`). |
| `initialState` | State | The bootstrap state (§4.6). |
| `steps[]` | Step | The ordered transitions (§4.7). Step 0 is the `boot` step and changes nothing. |

Schema v2's `tags`, `primaryScene` and `objects` are gone: every object names itself in
the state, and `focus` replaces the scene hint.

### 4.3 Property catalog entry

A property is a security guarantee the kernel states or proves, in one sentence a
reader can check against the theorems it names.

```json
{
  "id": "authority",
  "label": "No capability, no access",
  "statement": "A syscall reaches its operation only after the caller's CSpace resolves …",
  "caveat": "…optional: what the theorem does not say…",
  "theorems": [ { "name": "syscallLookupCap_implies_capability_held", "module": "SeLe4n.Kernel.API" } ],
  "invariants": []
}
```

`id`, `label` and `statement` are required non-empty strings. `caveat`, when present,
states the property's scope honestly — four of the nine carry one (non-interference is
stated over the `NonInterferenceStep` relation; invariant preservation is compositional;
scheduling optimality is over the top priority bucket; failure atomicity holds by the
type of a transition rather than by a theorem). `theorems` is a non-empty list of
references (§4.5). `invariants` lists catalogue ids the property rests on; every id must
resolve.

### 4.4 Invariant catalog entry

```json
{
  "id": "dualQueue",
  "label": "Endpoint queues well-formed",
  "subsystem": "ipc",
  "meaning": "Every endpoint's send and receive queues are well-formed intrusive lists …",
  "predicate":   { "name": "dualQueueSystemInvariant", "module": "SeLe4n.Kernel.IPC.Invariant.Defs" },
  "preservedBy": [ { "name": "endpointCall_preserves_dualQueueSystemInvariant",
                     "module": "SeLe4n.Kernel.IPC.Invariant.Structural.StoreObjectFrame" } ],
  "runtimeCheck": { "name": "endpointDualQueueWellFormedB", "module": "SeLe4n.Testing.InvariantChecks" }
}
```

`id`, `label`, `subsystem` and `meaning` are required non-empty strings; ids are unique.
`predicate` is the Lean definition the invariant stands for; `preservedBy` names at
least one theorem that preserves it — that is the evidence the page cites. The optional
`runtimeCheck` names an executable check in the test harness, shown as such and never as
a proof (nine of the sixteen have one).

### 4.5 Reference object

Every declaration the document names — property theorems, invariant predicates,
preservation theorems and runtime checks, step `sourceRefs`, and each path stage's
`ref` — is a reference:

```json
{ "name": "syscallLookupCap", "module": "SeLe4n.Kernel.API",
  "path": "SeLe4n/Kernel/API.lean", "line": 310 }
```

An author (or a kernel exporter) writes `name` and `module`. The sync stamps `path` and
`line` (§7.1); the validator accepts them only as a string and a positive integer. A
reference without a stamp is rendered as plain text, never as a link.

### 4.6 State projection

The state is a **display projection** of `SystemState` — faithful to the kernel's
structure, compact, and free of the internal representation (`RHTable`, `FrozenMap`,
…) that the page does not need. Every object is addressed by its `id`; a capability slot
by `"<cnode>/<slot>"`.

```jsonc
{
  "cores":   [ { "id": 0, "current": "server", "domain": 0 } ],   // current: thread id or null
  "threads": [ { "id", "name", "priority",            // 0–255
                 "domain", "core",                     // the core it is affine to
                 "ipc": { "state", "object", "replyTo" },   // ThreadIpcState constructor name
                 "timeSlice", "cspace", "label", "sc",      // CSpace root, security label, sched context
                 "msg", "pendingReply" } ],
  "runQueues": { "0": [ { "thread", "prio" } ] },      // per core, in insertion order
  "endpoints":     [ { "id", "name", "label", "send": [tid], "recv": [tid] } ],
  "notifications": [ { "id", "name", "label", "pending", "waiters": [tid] } ],   // pending: badge word or null
  "replies":       [ { "id", "name", "caller" } ],
  "schedContexts": [ { "id", "budget", "remaining", "period", "deadline", "refillIn" } ],
  "cnodes": [ { "id", "name", "label", "depth", "guardWidth", "guardValue", "radixWidth",
                "slots": { "1": { "kind", "target", "rights": ["read", …], "badge", "derivation" } } } ],
  "cdt":     { "cn.root/1": ["cn.app/2"] },            // derivation parent slot → child slots
  "untyped": [ { "id", "name", "base", "size", "watermark",
                 "children": [ { "id", "kind", "offset", "size" } ] } ],   // newest first
  "vspaces": [ { "id", "name", "asid", "mappings": [ { "vaddr", "frame", "perms": "rw-" } ],
                 "tlb": [ "vaddr" ] } ],               // translations cached on this core
  "labels":  [ { "id", "name", "conf": "low|high", "integ": "trusted|untrusted" } ],
  "declassify": [ { "from", "to" } ],                  // the declassification policy (never edited by a step)
  "audit":   [ { "from", "to", "actor", "target", "core" } ]
}
```

The CNode geometry is the kernel's: a lookup consumes `guardWidth` bits that must equal
`guardValue`, then `radixWidth` bits that index one of `2^radixWidth` slots, and `depth`
is their sum. A run queue's entries carry the priority they were inserted at, which is
the bucket the scheduler reads. A security label is a point in the
`SecurityLabel` lattice: confidentiality may only rise and integrity may only fall.

### 4.7 Step, outcome, path + delta op vocabulary

```jsonc
{
  "index": 1,                       // sequential from 0
  "kind": "syscall",                // boot|syscall|schedule|timer|interrupt|fault
  "core": 0,                        // the core the step runs on
  "actor": "app",
  "title": "app: send with a read-only capability",
  "traceTag": "SEND",
  "syscall": {
    "id": "send",                   // a SyscallId constructor
    "number": 0,                    // x7 — must equal SyscallId.toNat
    "msgInfo": { "length": 1, "extraCaps": 0, "label": 0 },   // x1, decoded (MessageInfo.decode bounds)
    "args": [ { "reg": "x2", "name": "message word 0", "value": 1 } ],   // x2–x5, in order
    "capPtr": 1,                    // x0 — the CPtr the lookup resolves
    "requiredRight": "write"        // present exactly when the path has a rights stage
  },
  "path": [
    { "stage": "entry",  "label": "Checked syscall entry", "ref": {…}, "result": "pass" },
    { "stage": "decode", "label": "Decode x0, x1 and x7",  "ref": {…}, "result": "pass" },
    { "stage": "lookup", "label": "Resolve x0 in the caller's CSpace (slot 1)", "ref": {…}, "result": "pass" },
    { "stage": "rights", "label": "Require the write right", "ref": {…},
      "result": "fail", "error": "illegalAuthority" },
    { "stage": "flow",   "label": "Sender → endpoint flow gate", "ref": {…}, "result": "skip" },
    { "stage": "operation", "label": "Send", "ref": {…}, "result": "skip" }
  ],
  "outcome": { "status": "error", "error": "illegalAuthority" },   // or { "status": "ok" }
  "narrative": "…plain language…",
  "sourceRefs": [ { "name": "syscallResolveCap", "module": "SeLe4n.Kernel.API" } ],
  "guarantees": [ "authority", "failureAtomic" ],                    // propertyCatalog ids
  "invariants": { "preserved": [ "runQueueUnique" ] },              // invariantCatalog ids
  "delta": { "ops": [] }
}
```

- **`outcome`** is required: `status` is `ok` or `error`; an `error` names the
  `KernelError` constructor, and only an error may carry one.
- **`path`** stages come from `PATH_STAGES` — `entry`, `decode`, `lookup`, `rights`,
  `flow`, `operation` — in that order, each at most once (a stage the call does not go
  through is absent). Each carries a `label`, an optional `ref` (§4.5) and a `result` of
  `pass`, `fail` or `skip`.
- **`guarantees`** lists the properties this step relies on; **`invariants.preserved`**
  the invariants a preservation theorem covers for this transition. Schema v2's
  `invariants.failed` is gone: a bundled step never breaks an invariant (the validator
  checks every state), and only the sandbox shows a violation.

**A refused step changes nothing.** A kernel transition is
`σ → Except ε (α × σ)`: the error branch carries no state. So when `outcome.status` is
`error`, `delta.ops` may contain only the event ops in `EVENT_OPS` — `flowCheck`,
`vspaceReject`, `note` — and the validator (and the browser) reject a refused step
whose delta would change state.

The **op vocabulary** is structural — it records *effects*; the decisions behind them
are recomputed and checked (§4.8):

| Op | Effect on the projected state |
|----|------------------------------|
| `dispatch {core, thread}` | Make `thread` (or `null`) current on `core`, removing it from that core's run queue. |
| `deschedule {core, thread}` | Take a thread off a core: out of its run queue, and no longer current. |
| `enqueue {core, thread, prio}` | Insert into a core's run queue at `prio` (idempotent). |
| `threadPatch {id, set}` | Merge fields into a TCB; a `null` value removes the field. |
| `message {from, to, via, words, label, badge?}` | Deliver a message: the receiver's `msg` records it. |
| `epEnqueue` / `epPopHead {endpoint, queue, thread}` | Append to, or pop the head of, an endpoint's `send`/`recv` queue (popping anything but the head is an error). |
| `ntfnEnqueue` / `ntfnPopHead {notification, thread}` | The same for a notification's waiters. |
| `ntfnPatch` / `replyPatch` / `scPatch {id, set}` | Merge fields into a notification, reply object or scheduling context. |
| `capInsert {slot, cap, parent?}` | Fill an empty, addressable slot; with `parent`, record the derivation edge. |
| `capDelete {slot}` | Empty a slot; its children are spliced up to its parent. |
| `capRevoke {slot}` | Delete every descendant of the slot's capability, deepest first, and **keep the capability** (`cspaceRevoke`). |
| `untypedCarve {untyped, child}` | Carve an object at the watermark and advance it (`retypeFromUntyped`); it must fit. |
| `untypedReset {untyped}` | Drop every carved object and reset the watermark. The kernel refuses this (`revocationRequired`) while children are live, so a trace revokes them first. |
| `vspaceMap {vspace, mapping, cache?}` | Add a mapping; with `cache`, the executing core caches the translation. |
| `vspaceUnmap {vspace, vaddr}` | Remove a mapping and shoot down its TLB entry. |
| `auditAppend {entry}` | Append a declassification record; both labels must exist. It **never edits the policy**. |
| `flowCheck {from, to, allowed}` | Event-only: a flow the kernel checked. |
| `vspaceReject {vspace, vaddr, perms}` | Event-only: a mapping the kernel refused. |
| `note {text}` | Event-only annotation. |

Replaying = folding each step's ops over `initialState` (`E.scenarioStates`). There is
**one** fold: `assets/js/trace-engine.js` (`window.sele4nTraceEngine`) is plain ES5 with
no DOM, the page loads it before `run.js`, and `trace-analysis.mjs` evaluates the same
file in Node. Before schema v3 the page and the validator each carried a copy, and
only a test kept them equal.

**Retired in v3:** `setCurrent`, `rqInsert`/`rqRemove` (now `dispatch`, `deschedule`,
`enqueue`, per core), `epDequeue` (an endpoint queue is FIFO: `epPopHead`),
`notifPatch` (`ntfnPatch`), the `cdt*` node ops (capabilities live in CNode slots, so
`capInsert`/`capDelete`/`capRevoke` act on slots and the CDT is slot → slots),
`untypedRetype` (`untypedCarve`), and `message` as an event op (it now records the
delivery on the receiver). `OPS` is an allow-list, so every retired name is rejected.

### 4.8 Validation

`scripts/lib/trace-analysis.mjs#validateTraceDataObject` (run by the sync, by
`scripts/validate-traces.mjs`, and by the unit tests) checks the document's shape and
then **recomputes every decision the trace records**, with the shared engine.

Shape:

- `schemaVersion === 3`, `source` in `kernel`/`fixture`, ISO `generatedAt`.
- Catalogues: non-empty, unique ids; an invariant has `id`, `label`, `subsystem`,
  `meaning`, a `predicate`, at least one `preservedBy` and a well-formed `runtimeCheck`
  when present; a property has `id`, `label`, `statement`, at least one theorem, a
  non-empty `caveat` when present and `invariants` that all resolve.
- Every reference has a non-empty `name` and a Lean module name; `path`/`line`, when
  stamped, are a string and a positive integer.
- Per scenario: identifier `id`, `title`, `summary`, known `properties`, a `focus` from
  `SCENES` when present, and a well-formed `initialState` (at least one core, priorities
  0–255, known IPC states, run queues keyed by declared cores, CNode geometry with a
  guard value that fits its width, label coordinates on the lattice, capabilities of a
  known kind with known rights).
- Per step: sequential `index`; step 0 is `boot` and carries no ops; `title`,
  `traceTag` and `narrative`; op names from `OPS`; a syscall step has an `actor` and a
  `path`, `syscall.number` (x7), `msgInfo` within `MessageInfo` bounds, `args` in x2–x5
  order, `capPtr` (x0) when the call looks a capability up, and `requiredRight` exactly
  when the path has a rights stage.
- **Path rules:** stages in `PATH_STAGES` order with no repeats; a refused step has
  **exactly one** `fail` stage whose `error` equals `outcome.error`, and every stage
  after it is `skip`; a successful step has no `fail`; `error` appears only on the
  refusing stage. A refused step carries only `EVENT_OPS`.

Recomputed against the state before the step:

- **The caller is current** on the step's core; otherwise `dispatchSyscallChecked`
  would refuse with `illegalState`.
- **The lookup:** `E.resolveCap` walks x0 through the caller's CSpace (guard, then
  radix bits, one level per CNode). It must fail exactly when the lookup stage says
  `fail`, with the same error.
- **The rights:** the resolved capability must lack `requiredRight` exactly when the
  rights stage fails, and a missing right is `illegalAuthority`.
- **The flow:** a `flow` stage needs a `flowCheck`, and every `flowCheck` must agree
  with `E.flowsTo` over the two labels (`securityFlowsTo`); a denied flow is
  `flowDenied`.
- **The scheduler:** every `dispatch` must name the thread `E.selectOnCore` picks
  (`chooseBestInBucketEffective`: highest bucket, EDF within a priority, FIFO on a tie,
  domain and budget eligibility, full-scan fallback). Only a `ready` thread may be
  enqueued.
- **Attenuation:** a minted or copied capability names its parent's object and gains no
  right over it (`capAttenuates`).
- **The fold** applies every op (an op that names a missing object, pops a non-head, fills
  an occupied slot or overruns an untyped region throws), and after the initial state
  and after every step `E.checkState` must report nothing: the sixteen executable
  mirrors (`runQueueUnique`, `currentThreadValid`, `queueCurrentConsistent`,
  `blockedNotRunnable`, `dualQueue`, `queueNoDup`, `notificationWaiters`,
  `replyWaiters`, `budgetWithinBounds`, `cdtLinksAgree`, `cdtAcyclic`,
  `untypedWatermark`, `untypedNonOverlap`, `vspaceAsidUnique`, `wxExclusive`,
  `tlbConsistent`), each of which must have a catalogue entry.

What the validator cannot check — that a name exists in the kernel, that a syscall's
number and required right are the kernel's — is checked by grounding (§7.1).

---

## 5. Scene catalog

All six scenes ship (§3.2). The kernel concepts each one stands on:

| Scene | Backing kernel concepts |
|-------|------------------------|
| **Kernel path** | `syscallEntryChecked`, `decodeSyscallArgsFromState`, `MessageInfo.decode`, `resolveCapAddress`, `syscallRequiredRight`, `chooseBestInBucketEffective`. |
| **IPC** | `Endpoint` dual queues, `ThreadIpcState`, `notificationSignal`/`notificationWait`, reply objects. |
| **Scheduler** | `RunQueue` priority buckets, per-core scheduling, scheduling contexts (budget, period, EDF deadline, refill). |
| **CSpace** | `CNode` guard/radix geometry, capability rights and badges, the capability derivation tree, `cspaceRevoke`. |
| **Memory** | `UntypedObject` watermark, `retypeFromUntyped`, page mappings, `PagePermissions.wxCompliant`, per-core TLB shootdown. |
| **Information flow** | `SecurityLabel`, `securityFlowsTo`, the declassification policy and its audit log. |

Future depth, none of it built: priority-inheritance chains, domain-schedule timelines
and page-table levels.

---

## 6. Upstream integration — how the kernel emits traces

The site ships a **hand-authored reference fixture** (`source: "fixture"`) that
conforms to schema v3. Its steps are illustrations, written by hand; its *names* are
not — every declaration, syscall, right and error is checked against the pinned kernel
checkout at every sync (§7.1). The honest end state is for the **kernel** to emit the
artifact, so the steps become a replay of real runs (`source: "kernel"`). That is
roadmap: the kernel does not export traces today.

Proposed upstream work (in the `hatter6822/seLe4n` repo, *roadmap*):

1. **`SeLe4n/Testing/TraceExport.lean`** — a structured-trace recorder. Today
   `MainTraceHarness` interleaves `IO.println "[TAG] …"` calls. The recorder wraps the
   same operations so that, for each transition, it captures: the syscall, its required
   right and the checked-entry path it took (§4.7), the `KernelError` when it refused,
   the structured effects (as the op vocabulary above — none on a refusal), the
   `traceTag`, and the declarations it ran as `{ name, module }` references.
2. **JSON encoding** — a small `ToJson`-style encoder for the projection (the kernel is
   Lean; it can serialize the display projection directly; the website never parses
   `reprStr`).
3. **CI artifact** — emit `docs/execution-traces.json` alongside the existing
   `docs/codebase_map.json`, at the same commit.
4. **Determinism guarantee** — because transitions are pure, the exported trace is
   reproducible and diffable in CI (a regression in behavior shows up as a trace diff).

The website side is already wired: `scripts/sync-upstream.mjs` adopts
`docs/execution-traces.json` from the synced checkout when it exists and keeps the
bundled fixture when it does not, and **either way** validates, grounds and refuses to
write a document with any issue. A kernel export gets no exemption: it must pass the same
validator and name only declarations the same checkout has.

Crucially, the **schema is the contract** between kernel and website: the op
vocabulary, the path stages and outcomes, and references by name and module. The
recorder emits them; the website folds the ops and stamps the references. Neither side
needs to understand the other's internals.

A concrete, reference-level implementation plan — the `SystemState`→projection mapping,
two op-emission strategies (instrumented vs. snapshot-diff), a Lean `TraceExport.lean`
sketch, and the end-to-end verification loop — lives in
[UPSTREAM_TRACE_EXPORT.md](UPSTREAM_TRACE_EXPORT.md).

---

## 7. Website data pipeline

The trace rides the same one-clone, one-revision pipeline as the code map, and the page
is **bundle-only** — like the landing page, it fetches its bundled snapshot and nothing
else:

```
upstream docs/execution-traces.json   (when the kernel ships one; else the bundled fixture)
        │  scripts/sync-upstream.mjs  writeTraces():
        │    1. validateTraceDataObject — refuse on any error
        │    2. groundTrace — stamp path/line on every reference, check syscall ids,
        │       required rights and errors against the kernel; refuse on any issue
        │    3. fold dry-run of every scenario
        ▼
data/execution-traces.json            (bundled snapshot, committed; sourceRef = map-data commitSha)
        │  scripts/validate-traces.mjs (CI): schema + grounding cross-check against map-data
        ▼
run.html → assets/js/run.js           fetch("data/execution-traces.json") → isValidTraceData → render
```

There is no `localStorage` trace cache and no live refresh. A live refresh could only
have fetched a document grounded at a *different* revision from the one the links,
the code map and the fixture's narrative were written against — and the kernel exports
no such document anyway. A failed fetch leaves a status message, not a stale or partial
view. The browser still checks what it loads (`isValidTraceData`: schema version,
catalogues, outcomes, the failure-atomicity rule, path stage names, reference integrity
and a fold dry-run) before adopting it.

### 7.1 Grounding (`scripts/lib/trace-anchors.mjs`)

A trace names kernel declarations everywhere, and a name is a claim about the kernel.
The 0.33.6 fixture showed how such claims rot: by kernel 0.36.41 one cited declaration
had been retired, two named modules rather than declarations, and fifteen named
functions no executed path reaches any more — and nothing failed, because nothing
checked. Grounding checks:

- **`collectTraceRefs`** gathers every `{ name, module }` reference: property
  theorems, invariant `predicate` / `preservedBy` / `runtimeCheck`, step `sourceRefs`
  and `path[].ref`.
- **`anchorTraceRefs`** resolves each one in the module's own file in the pinned
  checkout (`SeLe4n.Kernel.API` → `SeLe4n/Kernel/API.lean`), trying the qualified name
  first and then its last segment (`VSpaceRoot.mapPage` is written `def mapPage` inside
  `namespace VSpaceRoot`), with comments stripped, and stamps `path` and `line`. A
  reference it cannot place is reported, never guessed: a declaration that left its
  module is an editorial call, the same rule the landing page's deep links follow
  (`source-anchors.mjs`).
- **`checkTraceKernelFacts`** checks what a step *restates* about the kernel's
  interface: every `syscall.id` is a constructor of `inductive SyscallId`
  (`SeLe4n/Model/Object/Types.lean`); every `requiredRight` equals the arm of
  `syscallRequiredRight` for that syscall (`SeLe4n/Kernel/API.lean`); every
  `outcome.error` and `path[].error` is a `KernelError` constructor
  (`SeLe4n/Model/KernelError.lean`). The 0.33.6 fixture said `cspaceCopy` needed write
  (it needs grant), `reply` needed grantReply (it needs write), and named a syscall
  `declassifyStore` that does not exist.
- **`groundTrace`** runs both and records the revision: `sourceRef` (the 40-hex
  commit), `kernelCommit` (its first seven characters) and `kernelVersion`.

`scripts/validate-traces.mjs` then checks the committed snapshot against the other
snapshot from the same run (`validateGrounding`): `sourceRef` must equal
`map-data.json`'s `commitSha`; every reference must carry its stamp; and wherever the
reference's module is on the code map (production modules — `SeLe4n.Testing` and
`SeLe4n.Prelude` are not), the name must be one of that module's declarations in
`moduleMeta[].symbols.byKind` **at the stamped line**. A hand edit that renames a
declaration or moves a line, or a fixture left over from an older sync, fails CI instead
of shipping a link to the wrong line.

**Files (shipped):**

| File | Role |
|------|------|
| `run.html` | Page skeleton (mirrors `map.html`: CSP, theme-init, i18n, nav, background wash, footer). Loads `trace-engine.js` before `run.js`. |
| `assets/js/trace-engine.js` | The one engine: op vocabulary, fold, scheduler selection, CPtr resolution, flow lattice, `MessageInfo` encoding and the executable invariant mirrors. Plain ES5, no DOM; the page and the Node validator both evaluate it. |
| `assets/js/run.js` | Runtime: the six SVG scenes, inspector, guarantees band, invariant catalogue, log, transport, sandbox, bundle load. |
| `assets/css/run.css` | Page styles (reuses `style.css` tokens). |
| `data/execution-traces.json` | Bundled reference fixture, schema v3 (10 scenarios, 60 steps, 9 properties, 17 invariants), grounded at `sourceRef`. |
| `scripts/sync-upstream.mjs` | `writeTraces()`: adopts upstream `docs/execution-traces.json` if it exists, else the bundled fixture; validates, grounds and refuses to write on any issue. |
| `scripts/lib/trace-analysis.mjs` | Loads the engine in Node; the validator (§4.8). |
| `scripts/lib/trace-anchors.mjs` | Grounding: reference collection, line stamping, kernel-fact checks (syscall, x7 number, required right, errors). |
| `scripts/lib/trace-analysis.test.mjs` | Unit tests for the engine, validator and grounding (`node:test`). |
| `scripts/lib/run-runtime.test.mjs` | Headless `run.js` execution test (§11). |
| `scripts/validate-traces.mjs` | CLI validator (Tier 2): schema, grounding cross-check against `map-data.json`, fold. |
| `scripts/run-smoke.mjs` | Playwright probe (Tier 4, §11). |
| `locales/*.json` | `run.*`, `nav.run`, `meta.run_*` keys. |

---

## 8. Technology & cross-cutting concerns

- **Rendering** — hand-rolled **SVG** + the **Web Animations API**, consistent with
  `map.js`. SVG is accessible, theme-able via CSS custom properties, and crisp at any
  zoom. No frameworks, no D3, no bundler.
- **Strict CSP** — as tight as `index.html`: `default-src 'self'`, `script-src 'self'`,
  `style-src 'self'`, `img-src 'self' data:`, **`connect-src 'self'`**, because the page
  fetches nothing beyond its bundled snapshot (§7, §10). No inline scripts/styles, no
  `eval`, no `innerHTML` from trace data (all data rendered via
  `textContent`/`createElement`).
- **Performance** — delta-fold with per-step snapshots precomputed on scenario load
  (O(1) seeking); DOM lookups cached at boot; CSS `contain` on the stage; touched-entity highlighting computed from ops (no diff).
  At larger scale: keyframe snapshots every N steps + virtualized event log.
- **Accessibility** — full keyboard transport; `prefers-reduced-motion` disables
  animation and snaps to states; `aria-live` on caption/status/inspector; chips and
  the stage are focusable and labeled; the guarantee summary is `aria-live`; the
  invariant catalogue is a native `<details>` of semantic lists with links.
- **i18n** — `data-i18n` on static chrome + `window.sele4nI18n.t()` (with English
  literal fallbacks) for dynamic strings; re-render on `sele4n:locale-changed`. The
  first locale load dispatches no such event, so `setupLocaleReady()` registers on
  `sele4nI18n.onReady()` before anything paints and repaints once if a lookup fell back
  to English before the locale arrived — the same pattern as `map.js`. Trace content
  (titles, narratives, statements) is English data, not locale strings.
- **Theming** — light/dark via `data-theme` and the shared tokens; the theme toggle is
  `theme-init.js`'s, as on every page.
- **Layout** — every scene is drawn at 1:1 at every width (§3.2); a scene wider than
  the stage scrolls inside the stage shell, never the page. Single-column grid and
  enlarged touch targets on a phone.

## 9. URL state & deep links

`run.html?scenario=<id>&step=<n>&scene=<scene>&object=<id>&sandbox=1`, where `<scene>`
is one of `path`, `ipc`, `scheduler`, `cspace`, `memory`, `infoflow`. State is written
with `history.replaceState` (no history spam) and parsed on load, so any step of any
scenario in any scene is shareable and bookmarkable — including a selected object. Every
value is whitelisted (`ID_RE`, a 1–4 digit step, `SCENES`); an unknown one is ignored,
and a scene the scenario does not offer falls back to its `focus`. Schema v3 renamed
scenarios and scenes, so a link shared before it opens the first scenario at its
default scene rather than the step it named. In-page anchors `#property-<id>` and
`#invariant-<id>` address a guarantee card and an invariant entry.

## 10. Security posture

- **Bundle-only, no new origins.** `run.js` fetches `data/execution-traces.json` from
  `self` (`credentials: "same-origin"`, `redirect: "error"`) and nothing else; the CSP
  says so with `connect-src 'self'`. The `api.github.com` dns-prefetch and the
  `raw.githubusercontent.com` allowance the v1 live refresh needed are gone.
- **Links are built from a whitelist, never copied from data.** `sourceHref()` emits
  `https://github.com/hatter6822/seLe4n/blob/<sourceRef>/<path>#L<line>` only when
  `sourceRef` matches `SHA_RE` (40 lowercase hex), `path` matches `LEAN_PATH_RE` (slash-
  separated identifier segments ending in `.lean`) and `line` is a positive integer —
  the fields the sync stamped. A reference failing any check renders as plain text.
  `mapHref()` emits `map.html?module=…` only for `SeLe4n(.X)*` module names outside
  `SeLe4n.Testing`. So a malformed or hostile trace document cannot put an arbitrary
  URL on the page. External links carry `rel="noopener noreferrer"`.
- **Data is untrusted.** Adoption is gated by `isValidTraceData` (schema version,
  catalogues, outcomes and the failure-atomicity rule, path stage names, op reference
  integrity, a fold dry-run with the shared engine); rendering never interpolates data
  into HTML. *Roadmap:* cap
  payload size and step counts.
- The sandbox cannot escape into the verified channel; it operates on a throwaway state
  clone and is always labeled unverified.

## 11. Testing strategy

| Tier | Scope | Command |
|------|-------|---------|
| 0 | JS syntax | `node --check assets/js/run.js` · `node --check assets/js/trace-engine.js` |
| 1 | Unit: engine, validator and grounding; headless `run.js` execution test | `node scripts/lib/trace-analysis.test.mjs` · `node scripts/lib/run-runtime.test.mjs` |
| 2 | Bundled trace integrity + grounding cross-check against `map-data.json` | `node scripts/validate-traces.mjs` |
| 3 | Manual browser (desktop + mobile, light + dark, reduced-motion) | — |
| 4 | Playwright probe for `run.html` (CI runs it on every push) | `node scripts/run-smoke.mjs` |

`scripts/lib/trace-analysis.test.mjs` takes the bundled document and breaks one thing
per test: a dispatch the selection rule would not make, a CPtr that resolves where the
lookup says it fails (and the reverse), a capability with the required right where the
rights stage refuses, a flow check that disagrees with the lattice, a mint that gains a
right, an enqueue of a blocked thread, a refused step that changes state, a second
`fail` stage, the state checks (each of which must have a catalogue entry), and the
retired v2 ops. It also pins the engine's semantics directly (the selection rule's
tie-breaks and fallback, guard and radix resolution, revoke keeping the capability,
carve and reset, TLB caching and shootdown, the `MessageInfo` word) and grounding
(`collectTraceRefs`, `anchorTraceRefs`, `requiredRightTable`, `syscallNumberTable`,
`checkTraceKernelFacts` rejecting an unknown syscall, a wrong x7, a wrong right and an
unknown error).

`scripts/lib/run-runtime.test.mjs` boots the real `trace-engine.js` and `run.js` inside a
`vm` context backed by a minimal DOM shim (no jsdom dependency) and asserts, without a
browser: every scenario offers the scenes its state supports and opens on its `focus`;
each scene draws its signature elements (register cells and the gate pipeline, queues and
wait edges, priority buckets and budget meters, slot strips and derivation edges,
watermarks and W^X rows, the lattice and its audit log); exactly the step's guarantees
and invariants are highlighted; every grounded name links to its line at the bundle's
commit and nothing else does; transport, deep-link restore and object selection; each of
the eight sandbox perturbations breaking the invariant it names, and reset; strict
adoption refusing malformed documents; that every `run.*` key the runtime asks for exists
in `en.json`; and that the page fetches the bundled snapshot and nothing else.

`scripts/run-smoke.mjs` renders the page in headless Chromium and walks every scene of
every step of every scenario at 1440px: each drawn at 1:1, none wider than the stage, no
text past the SVG's edge. It then checks the scene tabs answer the keyboard and update
the URL, a click opens an object in the inspector, the sandbox breaks and reset restores
an invariant, a phone draws at 1:1 and scrolls inside the stage, the Spanish locale
translates the tabs, legend and scene labels, and the console stays clean with no request
leaving the origin.

---

## 12. Phased roadmap

- **Phase 1 — Vertical slice (shipped).** Property and invariant catalogues, step
  outcomes and checked-entry paths; validator and grounding with unit tests; the headless
  runtime test; `sync-upstream.mjs` validating and grounding the trace at the code map's
  revision; the inspector, guarantees band, invariant catalogue, steps log, transport,
  deep links and the clearly-labelled sandbox; full chrome/i18n/theming. Honest
  provenance via the source badge, the grounding commit and the fixture note.
- **Phase 3 — Scene depth (shipped, schema v3).** One shared engine; the kernel's
  decisions recomputed rather than believed (§4.8); six scenes drawn from the kernel's
  own structures — registers and the gate pipeline, endpoint and notification queues,
  priority buckets and scheduling contexts, CNode slot strips with guard/radix geometry,
  untyped watermarks and W^X mappings, the label lattice; a ten-scenario fixture; an
  eight-perturbation sandbox judged by the executable mirrors; the Playwright probe.
- **Phase 2 — Upstream truth.** Add `SeLe4n/Testing/TraceExport.lean` + a CI artifact in
  the kernel repo, then flip the bundled snapshot to `source: "kernel"` — the
  website-side adoption, validation and grounding are already in place.
- **Phase 4 — Hardware depth.** Per-core timers and IPIs, multi-level page-table walks,
  priority-inheritance chains and domain-schedule timelines.
- **Phase 5 — Exploration.** A per-step causality graph; guided sandbox challenges;
  trace search/filter.

## 13. Documentation sync

Changes here must keep in sync: `README.md` (page list + commands), `CONTRIBUTING.md`
(required checks), `docs/TESTING.md` (tiers + commands), `docs/DEVELOPER_GUIDE.md` (file
orientation), `docs/UPSTREAM_TRACE_EXPORT.md` (the kernel-side contract — whenever the
schema changes), `CLAUDE.md` (build commands + file tables), and — when scenes/schema
change — this spec.
