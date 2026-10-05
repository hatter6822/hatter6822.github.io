# seLe4n Simulator — Design Specification

> Status: **living spec**. Phase 1 (vertical slice, trace schema **v2**) is implemented
> and shipped in this repository (`run.html`, `assets/js/run.js`, `assets/css/run.css`,
> `data/execution-traces.json`, `scripts/lib/trace-analysis.mjs`,
> `scripts/lib/trace-anchors.mjs`, `scripts/validate-traces.mjs`). Anything marked
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
├── shared chrome (nav, theme toggle, bg toggle, language switcher, footer)
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
header (and the `&scene=` URL parameter). Each scene is an SVG projection of the
current `SystemState`, laid out so that a kernel object lives in exactly the
structural location the kernel itself puts it. Phase 1 ships six scenes — **System**,
**Scheduler**, **Capability**, **Memory**, **VSpace** and **Information flow** (`SCENES`
in `run.js`); later phases deepen them (§5). System and Scheduler are always offered;
each of the others appears only when the scenario's `initialState` carries the state it
draws (`cdt`, `untyped`, `vspace`, `infoflow`). There is no Services scene: the
schema-v1 services scenario drove its start / fault / restart lifecycle through no
reachable kernel syscall path, so nothing it showed could be grounded, and schema v2
removed it with its state block and op.

On a phone (under 40rem) the scene SVG is drawn at 1:1 and the stage scrolls
horizontally rather than shrinking the diagram until its labels are unreadable.

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
`smp-affinity` scenario shows two cores scheduling independently and a thread migrating
between them (and a `tcbSetAffinity` refused with `threadOnDifferentCore`) — and the
System scene likewise renders one CPU box per core.

The **Capability scene** draws the capability derivation tree; a revoke
(`cdtRevoke`) removes the revoked capability's descendants and keeps the capability
itself. The **Memory scene** draws untyped regions as watermarked bars with the objects
carved from them; a reset (`untypedReset`) reclaims the region, and the fixture shows the
kernel refusing it (`revocationRequired`) until the children's capabilities are revoked.
The **VSpace scene** draws page mappings with their permissions and W^X status plus a TLB
row; a write-and-execute request is drawn as a rejected row, never stored (the decoder
refuses it with `invalidSyscallArgument` before any lookup). The **Information-flow scene** draws the security-domain lattice with its policy
arcs, the current step's flow check (allowed or blocked), and the **declassification
audit log**: a declassification appends an `{from, to, actor}` entry to the log and
never edits the policy.

**Motion communicates causality.** Between steps:

- Entities touched by the current step's delta **pulse** (computed from the op list,
  not from a structural diff — exact and cheap).
- `message` ops animate a small **envelope** travelling from the sender chip to the
  receiver chip (Web Animations API; suppressed under `prefers-reduced-motion`).

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
- **violated** — the step lists it in `step.invariants.failed`, or the sandbox broke it.

Following a link to an `#invariant-…` anchor opens the `<details>` first, so an anchor is
never inside a closed disclosure. In **sandbox** mode the catalogue opens, the four
client-side checks (§3.6) override the status of the invariants they approximate, and
the summary explains that these checks are unverified JavaScript.

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

Toggling **Sandbox** reveals a panel with three perturbations of the displayed state
(enqueue the running thread, duplicate a run-queue entry, wake a blocked thread) and a
reset. Each operates on a clone of the current state; `jsChecks()` then evaluates four
client-side structural checks keyed by the catalogue ids they approximate —
`runQueueUnique`, `currentThreadValid`, `queueCurrentConsistent`, `blockedNotRunnable` —
and the invariant catalogue opens to show which one broke. The panel's banner says
**Unverified preview**: the checks are JavaScript, not Lean, and the sandbox never runs a
syscall.

---

## 4. Data model

### 4.1 Trace schema (v2)

A dataset is a single JSON document. Top level:

| Field | Type | Notes |
|-------|------|-------|
| `schemaVersion` | `2` | `SCHEMA_VERSION` in `trace-analysis.mjs`; the browser refuses any other value. |
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

The bundled document has 9 scenarios (48 steps), 9 properties and 16 invariants:

| Scenario | Demonstrates | Refused steps |
|----------|--------------|---------------|
| `ipc-call-reply` | authority, invariants, scheduling | — |
| `capability-gate` | authority, failureAtomic | `illegalAuthority`, `invalidCapability` |
| `notification-signal` | authority, invariants | — |
| `edf-budget-preempt` | scheduling, invariants | — |
| `capability-mint-revoke` | attenuation, authority, failureAtomic | `illegalAuthority`, `revocationRequired` |
| `untyped-lifecycle` | memoryIsolation, authority, failureAtomic | `untypedRegionExhausted`, `revocationRequired` |
| `infoflow-noninterference` | flowPolicy, noninterference, failureAtomic | `flowDenied` |
| `vspace-wx` | wx, memoryIsolation, failureAtomic | `invalidSyscallArgument` |
| `smp-affinity` | scheduling, failureAtomic | `threadOnDifferentCore` |

### 4.2 Scenario

| Field | Type | Notes |
|-------|------|-------|
| `id`, `title`, `summary` | string | Identity + human description. |
| `properties[]` | string[] | **Required, non-empty.** Ids from `propertyCatalog` this scenario demonstrates; the scenario bar's "Demonstrates" chips and the guarantees band's ordering. |
| `tags[]` | string[] | e.g. `["ipc","scheduler","capability"]`. |
| `primaryScene` | string | Default scene for this scenario. |
| `objects` | map | `id → { label, kind }` display metadata (legend). |
| `initialState` | State | The bootstrap state (§4.6). |
| `steps[]` | Step | The ordered transitions (§4.7). |

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
  "runQueue":      { "0": [tid] },           // per-core, priority-ordered  "cdt": {                                   // capability derivation tree (optional)
    "nodes": [ { "id", "label", "slot", "target", "rights", "badge" } ],
    "edges": [ [parentId, childId] ]
  },
  "untyped": [                               // untyped memory regions (optional)
    { "id", "label", "regionBase", "regionSize", "watermark", "isDevice",
      "children": [ { "id", "type", "size" } ] }
  ],
  "infoflow": {                              // security-domain flow policy (optional)
    "domains": [ { "id", "label", "confidentiality", "integrity" } ],
    "policy": [ [fromDomainId, toDomainId] ], // allowed flows (never edited by a step)
    "audit":  [ { "from", "to", "actor" } ]  // declassification audit log
  },
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
`cdt`, `untyped`, `vspace` and `infoflow` blocks feed the Capability, Memory, VSpace and
Information-flow scenes (and decide whether their tabs are offered). Schema v1's
`services` block is gone with the Services scene (§3.2): no reachable syscall path
drove it, and no op can touch it. The optional `vspace[].tlb` array
holds the virtual addresses with cached translations; `vspaceMap` caches a page and
`vspaceUnmap` shoots it down, so the VSpace scene can show stale-entry eviction. Later
phases extend the projection further with `cnodes` (§5) — all additive.

### 4.7 Step, outcome, path + delta op vocabulary

```jsonc
{
  "index": 1,                       // sequential from 0
  "kind": "fault",                  // boot|syscall|schedule|timer|ipc|fault|interrupt
  "title": "app → send(service-ep) — refused",
  "traceTag": "GATE-001",           // mirrors harness [TAG] codes
  "actor": "th.app",
  "syscall": {                      // optional; for a syscall step
    "id": "send",                   // a SyscallId constructor
    "requiredRight": "write",       // read|write|grant|grantReply|retype — must equal syscallRequiredRight
    "capPath": "app CSpace slot 4 → service-ep capability (rights: r)",
    "args": { "msgRegisters": 1 }
  },
  "path": [                         // optional; the checked syscall path, in kernel order
    { "stage": "entry",     "label": "Checked syscall entry", "ref": {…}, "result": "pass" },
    { "stage": "lookup",    "label": "Resolve the capability …", "ref": {…}, "result": "pass" },
    { "stage": "rights",    "label": "Require the write right", "ref": {…},
      "result": "fail", "error": "illegalAuthority" },
    { "stage": "operation", "label": "Endpoint send", "ref": {…}, "result": "skip" }
  ],
  "outcome": { "status": "error", "error": "illegalAuthority" },   // or { "status": "ok" }
  "narrative": "…plain language…",
  "sourceRefs": [ { "name": "syscallLookupCap", "module": "SeLe4n.Kernel.API" } ],
  "guarantees": [ "authority", "failureAtomic" ],                    // propertyCatalog ids
  "delta": { "ops": [] },
  "invariants": { "preserved": [], "failed": [] }                    // invariantCatalog ids
}
```

- **`outcome`** is required: `status` is `ok` or `error`; an `error` names the
  `KernelError` constructor, and only an error may carry one.
- **`path`** stages come from `PATH_STAGES` — `entry`, `decode`, `lookup`, `rights`,
  `flow`, `operation` — in that order, each at most once (a stage the call does not go
  through is simply absent). Each carries a `label`, an optional `ref` (§4.5) and a
  `result` of `pass`, `fail` or `skip`.
- **`guarantees`** lists the properties this step relies on; **`invariants.preserved`**
  the invariants a preservation theorem covers for this transition;
  **`invariants.failed`** (optional) any the trace records as broken — the page shows
  those as violated, never green.
- Schema v1's `syscall.gate`, `invariants.allHold` and `invariants.checked` are gone, and
  `sourceRefs` entries are references (`name`, not `label`).

**A refused step changes nothing.** A kernel transition is
`σ → Except ε (α × σ)`: the error branch carries no state. So when `outcome.status` is
`error`, `delta.ops` may contain only the event ops in `EVENT_OPS` — `flowCheck`,
`vspaceReject`, `message`, `note` — and the validator (and the browser) reject a refused
step whose delta would change state.

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
| `cdtRemove {node}` | Remove a CDT node and all its descendants (delete of a subtree). |
| `cdtRevoke {node}` | Remove every descendant of a CDT node and **keep the node** — revocation destroys a capability's derivations, not the capability. |
| `cdtPatch {id, set}` | Shallow-merge fields into a CDT node. |
| `untypedRetype {untyped, child}` | Carve a typed object out of an untyped region; advance the watermark by its size. |
| `untypedReset {untyped}` | Reclaim the region: drop every carved object and reset the watermark to zero. The kernel refuses this (`revocationRequired`) while children are live, so a trace revokes them first. |
| `flowCheck {from, to, allowed}` | Event-only; the Information-flow scene draws the attempted flow allowed or blocked. |
| `auditAppend {entry: {from, to, actor}}` | Append a declassification record to `infoflow.audit`; both domains must exist. It **never edits the policy**: a declassification is an audited release, not a new allowed flow. |
| `vspaceMap {vspace, mapping}` | Add a page mapping (`vaddr`→`paddr`, `perms`) to an address space; caches the `vaddr` in the TLB. |
| `vspaceUnmap {vspace, vaddr}` | Remove a page mapping and shoot down its TLB entry. |
| `vspaceReject {vspace, mapping}` | Event-only; the VSpace scene shows a W^X-violating map as rejected. |
| `message {from, to, endpoint, registers, caps}` | Event-only (animation/log); no state change. |
| `note {text}` | Event-only annotation. |

Replaying = folding each step's ops over `initialState`. The canonical fold engine
lives in `scripts/lib/trace-analysis.mjs` (Node, unit-tested); the browser runtime
(`assets/js/run.js`) carries a byte-faithful re-implementation of the *same* op
vocabulary so the two cannot drift (the test suite pins the canonical behavior).

**Retired in v2:** `untypedRevoke` (the kernel resets an untyped region; it does not
"revoke" one — revocation is a capability operation, `cdtRevoke`), `ifPolicyAdd` and
`ifPolicyRemove` (no kernel step edits the flow policy; declassification is
`auditAppend`), and `servicePatch` with the whole `services` block. `ALLOWED_OPS` is an
allow-list, so all four are rejected, and a unit test pins that a v1 trace using them
cannot slip through.

### 4.8 Validation

`scripts/lib/trace-analysis.mjs#validateTraceDataObject` (run by the sync, by
`scripts/validate-traces.mjs`, and by the unit tests) enforces:

- `schemaVersion === 2`, `source` in `kernel`/`fixture`, ISO `generatedAt`.
- A non-empty `invariantCatalog` with unique ids; each entry has `id`, `label`,
  `subsystem`, `meaning`, a `predicate` reference, at least one `preservedBy`
  reference, and a well-formed `runtimeCheck` when present.
- A non-empty `propertyCatalog` with unique ids; each entry has `id`, `label`,
  `statement`, at least one theorem reference, a non-empty `caveat` when present, and
  `invariants` that all resolve in the invariant catalogue.
- Every reference has a non-empty `name` and a Lean module name; `path`/`line`, when
  stamped, are a string and a positive integer.
- Per scenario: unique `id`; `title`, `summary`; a non-empty `properties` list of known
  property ids; a valid `initialState`; non-empty `steps` with **sequential** indices,
  allowed `kind`, non-empty `title`/`traceTag`, and op names from `ALLOWED_OPS`.
- Per step: `outcome.status` is `ok` or `error`; an error names a `KernelError`, and
  **its delta carries only `EVENT_OPS`**; `syscall.id` is non-empty and
  `syscall.requiredRight` is in `ACCESS_RIGHTS` (`read`, `write`, `grant`,
  `grantReply`, `retype`); `guarantees` and `invariants.preserved`/`failed` name only
  catalogue ids.
- **Path rules:** stages in `PATH_STAGES` order with no repeats; every stage has a
  `label` and a `result`; a refused step has **exactly one** `fail` stage whose `error`
  equals `outcome.error`, and every stage after it is `skip`; a successful step has no
  `fail` stage; no stage is `skip` unless an earlier one refused; `error` appears only on
  the refusing stage.
- A full **fold pass** over each scenario: every op reference resolves (no dangling
  thread, endpoint, notification, CDT, untyped, domain or address-space ids), and after
  the initial state and every step the structural checks hold — no thread in two
  run-queue slots across all cores (an echo of `schedulerRunQueueUniqueB`), CDT edges
  name existing nodes and form no cycle, untyped watermarks stay inside their regions
  and allocations inside their watermarks, policy edges name existing domains, no stored
  mapping is writable and executable, ASIDs are unique, and no TLB entry outlives its
  mapping.

What the validator cannot check — that a name exists in the kernel, that a syscall
needs the right the trace says — is checked by grounding (§7.1).

---

## 5. Scene catalog (roadmap)

The System scene (Phase 1) already exercises the scheduler + IPC structure. Future
scenes are focused lenses over the same fold engine and (extended) state projection:

| Scene | Shows | Backing kernel concepts |
|-------|-------|------------------------|
| **System** *(shipped)* | CPU, run queue, blocked lane, endpoints, notifications, message flow. | `SchedulerState`, `Endpoint`, `Notification`, `ThreadIpcState`. |
| **Scheduler** *(shipped)* | **SMP**: one column per core (CPU + priority buckets), EDF deadlines, CBS budget bars, thread migration, dimmed not-runnable lane. *(Per-domain partitioning and PIP boost chains are future depth.)* | `RunQueue`, `chooseThread`, `cbs_bandwidth_bounded`, `CrossSubsystemPerCore`. |
| **IPC** | Endpoints with dual queues, call/reply pairing, reply objects, donation chains, badge/notification signalling. | `IPC.DualQueue.*`, `donationChainAcyclic`, `notificationSignal/Wait`. |
| **Capabilities / CDT** *(shipped)* | The capability derivation tree as a tidy tree — minting/copying derive child capabilities, a revoke prunes the node's descendants and keeps the node — with target, rights, badge, and slot per node. *(A dedicated CNode-slot grid is future depth.)* | `CapDerivationTree` (`childMap`/`parentMap`), `cspaceRevokeCdtStrict`. |
| **Memory** *(untyped shipped)* | Untyped regions as watermarked bars with typed objects carved out (retype advances the watermark; a reset reclaims the region once the children are revoked). | `UntypedObject`, `retypeFromUntyped`, `untypedWatermarkInvariant`. |
| **VSpace** *(shipped)* | Per-address-space page-mapping rows with permissions and W^X status; a writable-and-executable map is rejected, never stored. A TLB row shows cached translations: a map caches its page, an unmap shoots it down (with a `⚡ shootdown` marker), and a validator flags any TLB entry left without a backing mapping. | `mapPage`/`unmapPage`, `PagePermissions.wxCompliant`, `vspaceAsidUniquenessChecks`, `tlbConsistent`. |
| **Information flow** *(shipped)* | Security-domain lattice (ordered by confidentiality) with allowed-flow policy arcs and the current step's flow check drawn allowed (green) or blocked (red), plus the declassification audit log — a declassification appends a record and leaves the policy unchanged. | `DomainFlowPolicy`, `NonInterferenceStep`, `securityFlowsTo`, `auditLogBounded`. |

Scene switching is additive: a scene tab strip in the stage header; the active scene
is part of the URL state (`&scene=`). Each scene reads the same folded state and the
same step deltas, projecting whichever facet it specializes in.

---

## 6. Upstream integration — how the kernel emits traces

Phase 1 ships a **hand-authored reference fixture** (`source: "fixture"`) that
conforms to schema v2. Its steps are illustrations, written by hand; its *names* are
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

**Files (Phase 1, shipped):**

| File | Role |
|------|------|
| `run.html` | Page skeleton (mirrors `map.html`: CSP, theme-init, i18n, nav, bg, footer). |
| `assets/js/run.js` | Runtime: fold engine, SVG stage, inspector, guarantees band, invariant catalogue, log, transport, sandbox, bundle load. |
| `assets/css/run.css` | Page styles (reuses `style.css` tokens). |
| `data/execution-traces.json` | Bundled reference fixture, schema v2 (9 scenarios, 48 steps, 9 properties, 16 invariants), grounded at `sourceRef`. |
| `scripts/sync-upstream.mjs` | `writeTraces()`: adopts upstream `docs/execution-traces.json` if it exists, else the bundled fixture; validates, grounds and refuses to write on any issue. |
| `scripts/lib/trace-analysis.mjs` | Canonical fold engine, op vocabulary, path stages and validator (Node). |
| `scripts/lib/trace-anchors.mjs` | Grounding: reference collection, line stamping, kernel-fact checks. |
| `scripts/lib/trace-analysis.test.mjs` | Unit tests for the fold engine, validator and grounding (`node:test`). |
| `scripts/lib/run-runtime.test.mjs` | Headless `run.js` execution test (§11). |
| `scripts/validate-traces.mjs` | CLI validator (Tier 2): schema, grounding cross-check against `map-data.json`, fold. |
| `locales/*.json` | `run.*`, `nav.run`, `meta.run_*` keys. |

**Files (Phase 2+, planned):** a `scripts/theater-smoke.py` Playwright probe.

---

## 8. Technology & cross-cutting concerns

- **Rendering** — hand-rolled **SVG** + the **Web Animations API**, consistent with
  `map.js`. SVG is accessible, theme-able via CSS custom properties, and crisp at any
  zoom. No frameworks, no D3, no bundler. WebGL is reserved for the background.
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
- **Theming** — light/dark via `data-theme` and the shared tokens; the theme + bg
  toggles reuse the exact `map.js` handlers.
- **Mobile** — single-column grid, scene tabs, enlarged touch targets; under 40rem the
  scene SVG keeps its 1:1 size and the stage scrolls horizontally instead of scaling the
  diagram down; message animation degrades gracefully.

## 9. URL state & deep links

`run.html?scenario=<id>&step=<n>&scene=<scene>&object=<id>&sandbox=1`, where `<scene>`
is one of `system`, `scheduler`, `capability`, `memory`, `vspace`, `infoflow` (`scene`
is omitted for `system`; an unknown value is ignored). State is written with
`history.replaceState` (no history spam) and parsed on load, so any step of any scenario
in any scene is shareable and bookmarkable — including a selected object. The schema-v2
redesign left these parameters unchanged, so links shared before it still open.
In-page anchors `#property-<id>` and `#invariant-<id>` address a guarantee card and an
invariant entry.

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
  integrity, fold dry-run); rendering never interpolates data into HTML. *Roadmap:* cap
  payload size and step counts.
- The sandbox cannot escape into the verified channel; it operates on a throwaway state
  clone and is always labeled unverified.

## 11. Testing strategy

| Tier | Scope | Command |
|------|-------|---------|
| 0 | JS syntax | `node --check assets/js/run.js` |
| 1 | Unit: fold engine, validator and grounding; headless `run.js` execution test | `node scripts/lib/trace-analysis.test.mjs` · `node scripts/lib/run-runtime.test.mjs` |
| 2 | Bundled trace integrity + grounding cross-check against `map-data.json` | `node scripts/validate-traces.mjs` |
| 3 | Manual browser (desktop + mobile, light + dark, reduced-motion) | — |
| 4 | Playwright probe for `run.html` *(roadmap — none exists yet)* | — |

`scripts/lib/trace-analysis.test.mjs` covers the fold engine (ordered, idempotent
`rqInsert`; `cdtRevoke` keeping the revoked node while `cdtRemove` prunes it;
`untypedRetype`/`untypedReset`; `auditAppend` leaving the policy unchanged; TLB caching
and shootdown; dangling references throwing), the validator (catalogue references,
predicate and preserving theorem required, a refused step that changes state, path
ordering and the single refusing stage, run-queue uniqueness across cores, CDT cycles,
W^X, duplicate ASIDs, stale TLB entries, the retired v1 ops), grounding
(`collectTraceRefs` coverage, `anchorTraceRefs` stamping and skipping comments,
`requiredRightTable`, `checkTraceKernelFacts` rejecting an unknown syscall, a wrong
right and an unknown error) and the bundled document folding cleanly.

`scripts/lib/run-runtime.test.mjs` boots the real `run.js` inside a `vm` context backed
by a minimal DOM shim (no jsdom dependency) and asserts, without a browser: the stage,
inspector, guarantees, invariants and log render from the bundle; exactly the step's
guarantees and invariants are highlighted; the kernel path names the refusing stage;
every grounded name links to its line at the bundle's commit and nothing else does;
transport, deep-link restore, scene tabs and per-scenario tab availability; each scene's
specifics (CBS bars, CDT revoke, untyped reset, blocked flow, declassification leaving
the policy unchanged, W^X rejection, TLB shootdown, one CPU per core); a recorded
invariant failure shown as violated; the sandbox breaking a structural check; strict
adoption refusing a dangling op or a refused step that changes state; and that the page
fetches the bundled snapshot and nothing else.

---

## 12. Phased roadmap

- **Phase 1 — Vertical slice (shipped).** Schema v2 with property and invariant
  catalogues, step outcomes and checked-entry paths; fold engine, validator and grounding
  with unit tests; the headless runtime test; `sync-upstream.mjs` validating and
  grounding the trace at the code map's revision; **six scenes** (System, Scheduler,
  Capability, Memory, VSpace, Information flow) with tab switching; the inspector (kernel
  path, why it's safe, state changes, source); the security guarantees band and the
  invariant catalogue; the steps log; transport and deep-link URL state; the
  clearly-labeled sandbox; full chrome/i18n/theming; SMP-aware Scheduler/System scenes;
  and a 9-scenario reference fixture (§4.1). Honest provenance via the source badge, the
  grounding commit and the fixture note.
- **Phase 2 — Upstream truth.** Add `SeLe4n/Testing/TraceExport.lean` + a CI artifact in
  the kernel repo, then flip the bundled snapshot to `source: "kernel"` — the
  website-side adoption, validation and grounding are already in place. Add a Playwright
  probe for `run.html`.
- **Phase 3 — Scene depth.** A dedicated IPC scene (call/reply pairing, donation chains)
  beyond the System scene's structure; a CNode-slot grid alongside the CDT; per-domain
  scheduler partitioning and PIP boost chains.
- **Phase 4 — Hardware depth.** TLB caching with shootdown-on-unmap already ships in the
  VSpace scene (with a stale-entry validator); remaining depth is richer multi-core visuals
  (per-core timers, IPI) and multi-level page-table walks.
- **Phase 5 — Exploration.** A per-step causality graph; a richer sandbox (more
  structural checks, guided challenges); trace search/filter.

## 13. Documentation sync

Changes here must keep in sync: `README.md` (page list + commands), `CONTRIBUTING.md`
(required checks), `docs/TESTING.md` (tiers + commands), `docs/DEVELOPER_GUIDE.md` (file
orientation), `docs/UPSTREAM_TRACE_EXPORT.md` (the kernel-side contract — whenever the
schema changes), `CLAUDE.md` (build commands + file tables), and — when scenes/schema
change — this spec.
