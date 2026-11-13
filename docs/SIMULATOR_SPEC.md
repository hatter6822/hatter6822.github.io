# seLe4n Simulator — Design Specification

> Status: **living spec**. Trace schema **v4** and seven scenes are implemented and
> shipped in this repository (`run.html`, `assets/js/trace-engine.js`,
> `assets/js/run-scenes.js`, `assets/js/run.js`, `assets/css/run.css`,
> `data/execution-traces.json`, `scripts/lib/trace-analysis.mjs`,
> `scripts/lib/trace-anchors.mjs`, `scripts/validate-traces.mjs`,
> `scripts/run-smoke.mjs`). Anything marked *roadmap* is specified here and not built.
>
> Audience: contributors to the seLe4n website and the upstream kernel trace-export tooling.

---

## 1. Vision

The codebase map (`map.html`) answers *"what is the kernel made of?"* It is a static
structure view. The **Simulator** (`run.html`) answers a different question:

> *"What does the kernel **do** at each step, **how** does it check that the step is
> allowed, and **why** is the result safe?"*

For every step of a scenario the page shows three things: the **state change**, drawn
as the kernel's own mechanism (the registers it decodes, the capability walk, the gates
in the order it runs them, the run queues, the refills, the derivation tree); the
**checked path** that allowed or refused it, down to the stage that refused and the
`KernelError` it returned; and the **security properties and invariants** the step
relies on, each linked to the Lean declaration that states or proves it.

The scenarios shipped today are a hand-written fixture (`source: "fixture"`), not a
replay of a kernel run: the kernel does not export traces yet (§6). What *is* the
kernel's own is every name a step cites and every decision a step shows. Each function,
theorem, predicate, syscall, right and error is resolved in the pinned seLe4n checkout
by the sync, and each decision (who is dispatched, where a CPtr lands, whether a right
is held, where a carve goes, what a tick charges) is recomputed by the trace engine and
compared with what the step records (§4.8).

### 1.1 Why this is possible for seLe4n

1. **Every transition is a deterministic pure function.** The kernel monad is
   `KernelM σ ε α := σ → Except ε (α × σ)` (`SeLe4n.Prelude`). The same state and the
   same syscall give the same result, so a trace is reproducible. The type says one more
   thing the page relies on: an `error` carries **no successor state**, so a refused
   syscall cannot leave a partial change behind. A refused step in a trace may carry no
   state-changing op (§4.7), and the "a refused syscall changes nothing" card cites
   `KernelM` and `Kernel` rather than a theorem.
2. **The invariants are proved, not just tested.** Each invariant the page lists is a
   Lean predicate, and the guarantee that it holds is its preservation theorems. The
   page names the predicate and, per transition, the theorems that are about that
   transition (§4.4). `SeLe4n.Testing.InvariantChecks` also carries executable boolean
   checks that the kernel's test harness runs; those are **tests**, and the page labels
   them "test harness, not a proof".

---

## 2. First principle: one engine, and it decides only what the state decides

The website must not re-implement kernel semantics in a way nothing checks. Two rules
follow.

**A trace records effects.** A step carries the already-decided effects as a list of
structured `ops`. Replaying a scenario is folding those ops over the initial state.

**The engine recomputes decisions, and the validator compares.** Where a kernel
decision is a pure function of the projected state and the step's registers, the engine
(`assets/js/trace-engine.js`) implements that function as a transcription of the Lean
definition, and `scripts/lib/trace-analysis.mjs` fails any step that disagrees with it.
A scenario that needs the kernel to decide differently from the engine is a bug in one
of the two; find which, against the Lean.

There is **one** engine. The browser loads it before the scenes and the controller; the
Node validator evaluates the same file with `new Function`. It is plain ES5 with no DOM.
Nothing in it is copied into `run-scenes.js`, `run.js` or the validator.

### 2.1 Replay and sandbox

| Mode | What it is | Trust |
|------|-----------|-------|
| **Replay** (default) | Playback of the bundled trace. | The fold is exact and every decision is recomputed, but the *sequence of events* is only as true as its source: a `fixture` step is an illustration; a `kernel` step would be a real run. The source badge says which. |
| **Sandbox** (opt-in, labelled) | The user perturbs a copy of the displayed state and the engine's executable mirrors respond. | **Unverified**: JavaScript approximations of the invariants, shown to build intuition for what the proofs rule out. |

---

## 3. Information architecture

```
run.html
├── shared chrome (nav, theme toggle, language switcher, footer)
├── hero: title, lead, SOURCE BADGE, provenance (commit), status line (aria-live),
│         fixture note
└── theater
    ├── SCENARIO BAR    scenario ▾ | summary | "Demonstrates" property chips
    ├── TRANSPORT       ◀ ▶/⏸ ▶ | scrubber | step n/N | [Sandbox]     (sticky)
    ├── STEP STRIP      one chip per step: kind, title, refused marker; click to jump
    ├── key hints
    ├── GRID
    │   ├── STAGE      step head (count, kind, tag, outcome, actor, title, narrative)
    │   │              scene tabs · Before/After toggle · the SVG scene · legend
    │   │              · text alternative (visually hidden, per scene)
    │   └── INSPECTOR  kernel path · state changes · why it is safe · source
    │                  · selected object
    ├── SECURITY GUARANTEES band  (one card per property; the step's own highlighted)
    ├── KERNEL INVARIANTS <details> (catalogue by subsystem; per-step proof coverage)
    └── SANDBOX PANEL  (hidden until toggled; Unverified preview)
```

### 3.1 Scenario bar, transport and step strip

- **Scenario selector**, the scenario's `summary`, and a **Demonstrates** row: one chip
  per id in `scenario.properties`, linking to that property's card.
- **Transport**: previous / play-pause / next, a range scrubber, the step counter and
  the sandbox toggle. It is sticky under the nav so it stays in reach while the page
  scrolls. Play advances at a fixed cadence and stops at the last step.
- **Step strip**: one chip per step with its kind and title; a refused step is marked.
  Exactly one chip is current (`aria-current="step"`).
- **Before / After**: every step after the first can be read as the state it found or
  the state it left. `B` and `A` switch; the URL carries `view=before`.

Keyboard: `Space` play/pause · `←`/`→` step · `Home`/`End` first/last · `B`/`A`
before/after. The scene tabs are a WAI-ARIA tablist (arrow keys, `Home`, `End`). Every
object on the stage is focusable and opens in the inspector on Enter.

### 3.2 The stage (scenes)

Seven scenes ship (`SCENES` in `run-scenes.js`, mirrored by the validator), each a lens
on the same folded state and the same step. `assets/js/run-scenes.js` draws them and
**decides nothing**: every fact is read off the state or asked of the engine
(`run-runtime.test.mjs` asserts the scenes call the engine's functions).

| Scene | Offered when | What it draws |
|-------|--------------|---------------|
| **Kernel path** (`path`) | the scenario has a syscall, a tick, a reschedule or an interrupt | For a syscall: the trap; the register file as the kernel decodes it (x0 CPtr, x1 `MessageInfo`, x2–x5 message words, x7 the syscall number, words past x5 from the IPC buffer); x1 bit by bit at the positions `MessageInfo.encode` uses (length 0–6, extraCaps 7–8, capsUnwrapped 9–11, label 12–63); x0 walked through the caller's CSpace, guard bits then radix bits, to the capability it lands on with its rights; **every gate in the order the kernel runs it** (`entry → decode → lookup → type → rights`, then the arm's own `args` and `flow` in the arm's order, then `operation`), each passed, failed with its `KernelError`, or not reached; the outcome. For a tick, a reschedule or an interrupt: that entry's own mechanism, as the engine computes it. |
| **IPC** (`ipc`) | the state has an endpoint or a notification | Threads with their IPC state; endpoints with their send and receive queues in FIFO order; notifications with the pending badge word and waiters; reply objects and the caller each holds. Below, what this step moved: the message (words, label, badge) from sender through the object to receiver, any capability transferred with it and where it was installed, and each thread's state transition before → after. |
| **Scheduler** (`scheduler`) | always | The kernel clock. Per core: the thread on the CPU, the run queue as priority buckets (highest first, FIFO within), each entry's eligibility (no budget, wrong domain) and the thread the core would pick now with the rule that picks it; the core's release queue in release order. Then every scheduling context: budget per period, deadline, the head refill as budget cells and each pending refill with its release time. |
| **CSpace** (`cspace`) | the state has a CNode | Each CNode's occupied slots with kind, target, rights and badge, and its geometry (guard bits, guard value, radix bits). The derivation tree drawn as a tree, each node labelled with how it was derived (minted, copied, retyped, transferred); what a delete or revoke removed is drawn struck through in the "before" reading and marked in "after". |
| **Memory** (`memory`) | the state has an untyped region or an address space | Each untyped region to scale with an address axis; carved children at their offsets; the gap an aligned carve skipped, hatched; the **free index of each untyped capability** (the free index is the capability's, not the region's); the request a refused retype made. Each address space: virtual address → frame, R/W/X, and whether the translation is cached in the TLB; a refused W+X request drawn as a rejected row that is never stored. |
| **Information flow** (`infoflow`) | the state has at least two labels | The four-point label lattice (confidentiality × integrity) with every flow `securityFlowsTo` admits between the labels present, each label's carriers, the flows this step asked the policy about with the two conjuncts spelled out (confidentiality does not fall; destination at least as trusted), and the declassification audit log. |
| **Interrupts** (`irq`) | the state declares interrupt lines | Each line (inactive, handler issued, masked) → the capability in its node slot → the notification it signals → the thread waiting on it; the delivery in order for an interrupt step (acknowledge and EOI, signal with the node capability's badge, wake or OR into the pending word, mask until acknowledged); and who holds the control and handler capabilities. |

A scenario names its default scene as `focus`; `scene=` overrides it when that scene is
offered.

**Every scene is drawn at 1:1, at every width.** `.theater-svg` is `max-width: none`; a
scene wider than the stage scrolls inside `#theater-stage-shell`. A label that could
outgrow its box goes through `fitText` with `clip` (ellipsis plus a `<title>`), and
`Canvas.text` grows the SVG to what it drew. `scripts/run-smoke.mjs` walks every scene
of every step, before and after, at desktop and phone widths, and fails on any text
past the SVG's edge or its box.

**Changes are marked, not animated into place.** Objects the step's ops touch are
marked from `E.touched(ops)` (the op list, not a structural diff). The only motion is a
short fade and a message path drawing itself in, both inside
`@media (prefers-reduced-motion: no-preference)`.

**Each scene has a text alternative**: a visually hidden paragraph that states what the
scene shows for this step, translated, and the SVG is labelled by it.

### 3.3 Security guarantees and the invariant catalogue

**Security guarantees** renders one card per `propertyCatalog` entry (§4.3): label,
statement, `caveat` under **Scope**, the theorems that state or prove it, and chips for
the invariants it rests on. A card is highlighted when the current step lists it in
`step.guarantees`.

**Kernel invariants** renders `invariantCatalog` (§4.4) by subsystem. For each entry:
its label, meaning, `scope` when it has one, its **Predicate**, its **Preserved by**
theorems and its **Runtime check** (labelled "test harness, not a proof"). Status at the
current step:

- **preserved by this step**: some theorem in the entry `covers` this step's transition
  (`E.proofsCovering`). Those theorems are listed first, each with the function it is
  about, the bundle it proves the predicate inside, and the transitions it covers. The
  entry's other theorems fold behind a disclosure.
- **holds**: the engine's mirror finds the predicate true of this state, and no theorem
  in this catalogue is about this transition. The page does not claim a proof here.
- **violated**: sandbox only, when `E.checkState` reports it.

A refused step and the boot step are covered by no theorem: the first changed nothing,
the second is the initial state. The summary line says which.

### 3.4 Inspector

1. **Kernel path** (syscall steps): the `SyscallId`, x7, the required right, and the
   stage strip over `step.path` with each stage's grounded source link.
2. **State changes**: the ops in order (event-only ops marked) and a field-level
   before → after for every entity the step touched. A refused step says that nothing
   changed.
3. **Why it is safe**: the failure-atomicity note on a refusal; each property in
   `step.guarantees` with its first theorem; each invariant a theorem covers for this
   transition with that theorem.
4. **Source**: `step.sourceRefs` as grounded links, plus a code-map link for production
   modules.
5. **Selected object**: a field table projected from the displayed state.

### 3.5 Sandbox

Each of the eight perturbations (`PERTURB` in `run.js`) edits a **copy** of the
displayed state to break one invariant the catalogue names, and is offered only where
it applies: enqueue the running thread (`queueCurrentConsistent`), duplicate a run-queue
entry (`runQueueUnique`), wake a blocked thread (`blockedNotRunnable`), orphan a
derivation (`cdtLinksAgree`), map a page writable and executable (`wxExclusive`), leave
a stale TLB entry (`tlbConsistent`), overspend a budget (`budgetWithinBounds`), carve
overlapping objects (`untypedNonOverlap`). The verdict is `E.checkState`'s, the same
mirrors the validator runs over every bundled state. There is no second set of
browser-only checks.

---

## 4. Data model

### 4.1 Trace schema (v4)

| Field | Type | Notes |
|-------|------|-------|
| `schemaVersion` | `4` | `SCHEMA_VERSION` in the engine; the page and the validator refuse any other value. |
| `source` | `"kernel"` \| `"fixture"` | Drives the source badge; `validate-traces.mjs` warns when it is not `kernel`. |
| `generator`, `disclaimer` | string | Provenance, in words. |
| `kernelVersion`, `kernelCommit`, `leanToolchain` | string | Upstream identity; the sync overwrites version and commit from the checkout. |
| `generatedAt` | ISO-8601 | |
| `sourceRef` | 40-hex commit | **Stamped by the sync**: the commit every `line` was read at. Every source link opens this revision. |
| `propertyCatalog`, `invariantCatalog`, `scenarios` | arrays | §4.3, §4.4, §4.2 |

### 4.2 Scenario

`{ id, title, summary, focus, properties, initialState, steps }`. `focus` is a scene id;
`properties` lists property ids; `steps[0]` is the `boot` step and carries no ops.

### 4.3 Property catalogue entry

`{ id, label, statement, caveat?, theorems: [ref], invariants: [invariantId] }`. Eleven
ship: `authority`, `attenuation`, `failureAtomic`, `noninterference`, `flowPolicy`,
`memoryIsolation`, `wx`, `invariants`, `scheduling`, `replenishment`, `interrupts`.

### 4.4 Invariant catalogue entry

```jsonc
{
  "id": "runQueueUnique", "label": "…", "subsystem": "scheduler", "meaning": "…",
  "predicate": { "name": "runQueueUniqueOnCore", "module": "…" },
  "preservedBy": [
    {
      "name": "timerTickOnCore_preserves_runQueueUniqueOnCore", "module": "…",
      "subject": { "name": "timerTickOnCore", "module": "…" },   // the function the theorem is about
      "within":  [ { "name": "…Bundle", "module": "…" } ],        // optional: the bundle(s) it proves the predicate inside
      "covers":  ["timer"]                                         // the transitions that function is
    }
  ],
  "runtimeCheck": { "name": "schedulerRunQueueUniqueB", "module": "SeLe4n.Testing.InvariantChecks" },
  "scope": "…"   // required when no theorem covers a live transition, or one is reference-only
}
```

**A theorem is cited for the transitions it is about, and nothing else.** Schema v3
listed `invariants.preserved` on each step and a flat list of theorems on each
invariant; nothing related the two, and by the time it was audited several theorems
cited for every step were about single-core reference functions (`endpointCall`,
`notificationSignal`, `timerTick`) that the dispatched per-core path never runs.

- A **transition key** is a syscall id, or the step kind for `timer`, `schedule` and
  `interrupt` (`E.transitionKey`). `"syscall"` (`E.ANY_SYSCALL`) covers every syscall:
  it is for theorems about the dispatcher itself.
- `covers: []` says the theorem is about the **reference model only**. The page shows
  it, labelled so, and never counts it as covering a step.
- A step no longer lists its invariants. `E.proofsCovering(inv, step)` derives them; it
  is empty for the boot step and for a refused step.
- `checkProofCoverage` (§4.8) holds every entry to the kernel's own call graph.

Eighteen entries ship. Seventeen have an executable mirror in `checkState`;
`auditLogBounded` has none (the engine does not model a capacity). Two entries
(`blockedNotRunnable`, `notificationWaiters`) state in `scope` that the theorem naming
their predicate is about the reference operation, and that no per-core theorem for it
exists at this revision.

### 4.5 Reference object

`{ name, module, line }`. An author writes `name` and `module`; the sync stamps `line`.
The file is **derived** from the module (`E.modulePath`: `A.B.C` → `A/B/C.lean`), so a
reference cannot name a line in one file and a module in another; a stored `path` is
rejected as a v3 field.

### 4.6 State projection

```jsonc
{
  "time": 0,                                             // kernel ticks; only the boot core advances it
  "cores": [ { "id", "current", "domain" } ],
  "threads": [ { "id", "name", "priority", "domain", "core", "ipc": { "state", "object"?, "replyTo"? },
                 "timeSlice"?, "sc"?, "cspace", "label", "recvSlot"?, "msg"?, "pendingReply"?, "replyObject"? } ],
  "runQueues": { "<core>": [ { "thread", "prio" } ] },   // insertion order; buckets are derived
  "releaseQueues": { "<core>": [ "<schedContextId>" ] }, // sorted by release time
  "schedContexts": [ { "id", "name", "budget", "period", "deadline", "remaining",
                       "periodStart", "consumed", "refills": [ { "amount", "at" } ] } ],
  "endpoints": [ { "id", "name", "label", "send": [], "recv": [] } ],
  "notifications": [ { "id", "name", "label", "pending", "waiters": [] } ],
  "replies": [ { "id", "name", "caller" } ],
  "cnodes": [ { "id", "name", "depth", "guardWidth", "guardValue", "radixWidth", "label", "irqNode"?,
                "slots": { "<n>": { "kind", "target"?, "rights", "badge"?, "derivation"?, "freeIndex"?, "line"? } } } ],
  "cdt": { "<cnode>/<slot>": [ "<cnode>/<slot>" ] },      // slot → child slots, newest first
  "untyped": [ { "id", "name", "base", "size", "children": [ { "id", "kind", "offset", "size" } ] } ],
  "vspaces": [ { "id", "name", "asid", "mappings": [ { "vaddr", "frame", "perms" } ], "tlb": [] } ],
  "labels": [ { "id", "name", "conf", "integ" } ],
  "declassify": [ { "from", "to" } ],                    // the declassification policy
  "audit": [],                                           // the declassification trail
  "irqs": [ { "line", "name", "active", "masked" } ]
}
```

Changes from v3: a scheduling context carries its refills exactly (`remaining` is the
head refill, `refills[]` the pending ones with their release times; `refillIn` is
gone); the free index lives on the untyped **capability** (`freeIndex` on the slot;
`untyped[].watermark` is gone); release queues, the clock, interrupt lines, the IRQ
node CNode and each thread's receive slot are new.

### 4.7 Step, path and ops

`{ index, kind, core?, actor?, title, traceTag, narrative, syscall?, irq?, path?,
outcome, guarantees, sourceRefs, delta: { ops } }`. `kind` is one of `boot`, `syscall`,
`schedule`, `timer`, `interrupt`, `fault`.

**`syscall`** carries the registers: `{ id, number (x7), capPtr (x0), msgInfo: { length,
extraCaps, label } (x1), args: [{ reg, name, value }] (x2–x5), ipcBuffer?, extraCaps?,
requiredRight }`.

**`path`** stages come from `PATH_STAGES`: `entry`, `decode`, `lookup`, `type`,
`rights`, then the arm's own `args` and `flow` in the arm's order, then `operation`.
Each is `{ stage, label, ref, result: pass|fail|skip, error? }`. A path has at most one
`fail`, its `error` equals `outcome.error`, and every later stage is `skip`. The yield
invokes no capability and has no `lookup`, `type` or `rights` stage.

**Ops** (`OPS` in the engine):

| Group | Ops |
|-------|-----|
| Scheduling | `dispatch`, `deschedule`, `enqueue` |
| Threads and IPC | `threadPatch`, `message`, `epEnqueue`, `epPopHead`, `ntfnEnqueue`, `ntfnPopHead`, `ntfnPatch`, `replyPatch` |
| Time and budgets | `clockTick`, `scCharge`, `scRelease` |
| Interrupts | `irqPatch` |
| Capabilities | `capInsert`, `capDelete`, `capRevoke` |
| Memory | `untypedCarve`, `untypedReset`, `vspaceMap`, `vspaceUnmap` |
| Information flow | `auditAppend` |
| Events (no state change) | `flowCheck`, `vspaceReject`, `note` |

An op whose result is arithmetic over the state names only its subject: `scCharge`
charges one tick through `SchedContext.chargeBudget`'s algebra, `scRelease` releases
the head refill that is due, `untypedCarve` places the child at the aligned free index.
The fold does the arithmetic, so a trace cannot record a wrong number.

`capDelete` splices the slot out of the derivation tree, its children taking its place
(`cdtSplice`); `capRevoke` removes a capability's derivations and keeps the capability.
Endpoint and notification queues are FIFO: the pop ops throw on anything but the head.
Ops retired in earlier versions (`setCurrent`, `rqInsert`, `rqRemove`, `epDequeue`,
`notifPatch`, `cdt*`, `untypedRetype`, `untypedRevoke`, `ifPolicyAdd`, `ifPolicyRemove`,
`servicePatch`, `scPatch`) are rejected by name.

**A refused step changes nothing.** `outcome.status: "error"` admits only event ops.

### 4.8 Validation

`validateTraceDataObject` (structure and recomputation), `groundTrace` (names and
tables against the checkout) and `checkProofCoverage` (theorems against the call graph)
all run in the sync before a trace is written; `validate-traces.mjs` re-runs the first
and third on the bundle and cross-checks every stamped line against `map-data.json`.

**Recomputed for every step, against the state before it:**

| Decision | Engine function | Lean |
|----------|-----------------|------|
| the caller is current on its core | — | `dispatchSyscallChecked` (`illegalState` otherwise) |
| where x0 resolves | `resolveCap` | `resolveCapAddress` |
| the type gate | `targetAccepted` | `syscallTargetAccepted` |
| the right, and the error without it | `capHasRight`, `missingRightError` | `syscallRequiredRight`, `syscallMissingRightError` |
| a short message | `truncationMinimum` | `requireMessageLength` |
| words past x5 | `readsOverflow` | `syscallReadsOverflow` |
| whether the arm gates the flow, and what a denial answers | `flowGated`, `flowDeniedError` | the arms of `dispatchSyscallChecked` |
| a flow check's answer | `flowsTo` | `securityFlowsTo` |
| every dispatch | `selectOnCore` | `chooseBestInBucketEffective` |
| a reschedule, whole | `rescheduleOps` | `handleRescheduleOnCoreState` |
| a timer tick, whole | `timerTickOps` | `timerTickOnCore` and the refill algebra in `SchedContext/Budget.lean` |
| a yield, whole | `yieldOps` | `yieldOnCore`, `sliceExpireOnCore` |
| an interrupt, whole | `interruptOps` | `handleInterruptOnCore` |
| where a retype carves, and what x2 asked for | `carvePlacement`, `retypeRequest` | `retypeFreeIndex`, `alignedCarveIndex`, `decodeUntypedRetypeArgs` |
| capabilities an IPC rendezvous transfers | `transferPlan` | `resolveExtraCaps`, `ipcUnwrapCaps` |
| the interrupt syscalls' writes | `irqLine`, `irqNodeSlot` | `irqControlLineRefusal`, `irqNotificationCapAdmitted` |
| the slot a kernel-issued capability lands in | `issuingDestination` | `resolveIssuingSlots` |
| a mint or copy attenuates | — | `capAttenuates` |

Four decisions were added or corrected when the engine was re-derived against the
kernel at `e93b82b` (0.35.0):

- **The flow table.** `FLOW_GATED` is thirteen syscalls, not eleven:
  `dispatchCapabilityOnlyChecked` also gates `serviceQuery` and `serviceRevoke`
  (`lookupServiceChecked`, `revokeServiceChecked`). No scenario runs either, which is
  how the omission survived; the table is now grounded (below) so the next one cannot.
- **Untyped derivation.** A mint, copy or transfer of an untyped capability onto the
  same region is refused with `revocationRequired` while the source has derivation
  children (`untypedDeriveRefused`), and afterwards the source is full: its free index
  is the region's size and the child carries the watermark the source had
  (`untypedSourceSetFull`). `capInsert` does both.
- **A carve cannot reuse an object id.** `untypedCarve` throws `childIdCollision`
  (`retypeFromUntyped`'s check) when the id already names an object.
- **Where a kernel-issued capability lands.** `untypedRetype` and `irqControlGet` name a
  CNode and an index in their arguments, and the validator holds the `capInsert` a step
  records to the slot `issuingDestination` resolves them to; an `irqHandlerAck` on a
  line the board does not declare must be refused with `invalidIrq`, and
  `irqHandlerClear` deletes the node slot's capability and nothing else.

A flow gate is held to the arm that runs it: a committed step on a gated arm must show
its `flow` stage, an ungated arm may record no check, a gated arm records exactly one,
and a declassification must record the *denied* flow it depends on
(`declassificationDecision`).

After the initial state and after every step `E.checkState` must report nothing, and
every check it can report must have a catalogue entry.

**Grounding** (`trace-anchors.mjs`, in the digest-verified checkout): every `{ name,
module }` resolves to a line; each syscall is a `SyscallId` constructor, its x7 is
`SyscallId.toNat`, its `requiredRight` is the `syscallRequiredRight` arm, each error is
a `KernelError`; and the engine's gate tables are compared with the kernel's, entry for
entry (`checkEngineTables`).

The flow table is grounded twice, against two things the kernel writes independently:

- **The dispatch arms.** In `dispatchWithCapChecked` and `dispatchCapabilityOnlyChecked`
  the arms that take the labelling context `ctx` are exactly the arms that gate
  something on a label. They must be `FLOW_GATED` plus `CONTEXT_ARMS_UNGATED`, the four
  arms that read the context for another reason (`declassify`, `declassifySignal`,
  `auditRead`, `auditDrain`), syscall for syscall.
- **The enforcement boundary.** `enforcementBoundary` (`InformationFlow/Enforcement/
  Wrappers.lean`) classifies every operation, and its `.policyGated` entries must be
  the operations `POLICY_GATED_OPERATIONS` names for the thirteen gated syscalls and
  the two declassifications, no more and no fewer.

What this does **not** establish: that each arm calls its wrapper with the right pair
of labels, or that a wrapper refuses when it should. The first is read off the arm's
text (it names `ctx`); the second is the kernel's theorem, not this check's. A syscall
whose arm stopped consulting the policy while still naming `ctx` would pass.

**Proof coverage** (`checkProofCoverage`, against `data/map-callgraph.json` at the same
commit). For each `preservedBy` entry:

- the theorem refers to its `subject` (it is a statement about it);
- it reaches the predicate: directly, or through the `within` chain, each link a direct
  reference, so the predicate is a conjunct of what the theorem proves;
- for each transition in `covers`, every operation a step of that kind names (the
  `operation` stage of a successful syscall step; a tick's, reschedule's or interrupt's
  `sourceRefs`) is the subject, reaches it, or is reached from it;
- an entry with `covers: []` is about a function **no** step's operation reaches.

This is a reachability check over references, not a proof check: it cannot say a
theorem's hypotheses are discharged. What it rules out is what shipped before: a
theorem about a function the executed path does not contain.

### 4.9 Mirror fidelity

The mirrors in `checkState` are structural approximations, used to reject a malformed
trace and to drive the sandbox. Known differences from the Lean predicates:

- `runQueueUnique` and `queueCurrentConsistent` check across all cores, which is
  stronger than the per-core predicates they are named for (the kernel gets the
  cross-core half from the TCB's own run-queue links).
- `dualQueue` also checks that a queued thread's IPC state names the queue it is in.
- `currentThreadValid` checks that the running thread exists; that a blocked thread is
  not running is `blockedNotRunnable`'s.
- `auditLogBounded` has no mirror.

Two things the state projection assumes rather than models, because the kernel reads
them from memory the projection does not carry:

- **The receiver's IPC buffer.** The kernel unwraps capabilities only for a receiver
  with a writable IPC buffer (`receiverHasBuffer`; without one the receiver gets
  nothing, badges included) and reads the receive slot out of that buffer's words
  (`receiveSlot?`). The projection states the outcome as a thread's `recvSlot` field: a
  thread that has one is a thread with a buffer naming that slot.
- **`retypeFromUntyped`'s early refusals.** Capacity, the device-untyped restriction,
  `addressOutOfBounds` and `allocSizeTooSmall` are not recomputed; a scenario that
  needed one would have to state it as the step's refusal, and none does. The order the
  engine does model is the kernel's: `revocationRequired` before
  `untypedRegionExhausted`, then the id collision.

Capability transfer is checked on `send` and `call`. A transfer on `reply` or
`replyRecv` is refused by the validator rather than checked: conservative, and no
scenario has one.

### 4.10 What is left out, deliberately

The engine models what it can transcribe exactly. It does not model, and the scenarios
are written so that they do not arise:

- **scheduling-context donation and priority inheritance** on call and receive
  (`applyReceiveRendezvousHandoff`): no thread in an IPC scenario is bound to a
  scheduling context, and no caller outranks its server;
- **bound-notification delivery** (a signal handing its badge to a bound thread blocked
  on an endpoint, `boundDeliveryTarget?`), and with it the signal's second flow gate;
- **a yield by a thread bound to a scheduling context** (it forfeits its head refill):
  the validator refuses such a step rather than guess;
- **faults, timeouts, domain switches, the service registry, reply-receive, page
  tables below the mapping, zombie finalisation beyond the slot splice, cross-core
  SGIs** as events of their own;
- **IPC timeouts on budget exhaustion** (`budgetExhaustOnCore`'s timeout pass).

---

## 5. Scenarios

Twelve scenarios, 87 steps: `ipc-call-reply` (8), `capability-gate` (6),
`notification-signal` (8), `scheduler-buckets` (5), `budget-edf` (11),
`capability-derivation` (8), `untyped-retype` (7), `vspace-wx` (5), `information-flow`
(6), `smp-affinity` (4), `irq-delivery` (12), `cap-transfer` (7).

---

## 6. Upstream integration

The honest end state is for the **kernel** to emit `docs/execution-traces.json`
(`source: "kernel"`). That is roadmap. `scripts/sync-upstream.mjs` already adopts the
upstream file when it exists and keeps the fixture when it does not, and either way
validates, grounds and coverage-checks it; a kernel export gets no exemption. The
schema is the contract. The implementation plan is in
[UPSTREAM_TRACE_EXPORT.md](UPSTREAM_TRACE_EXPORT.md).

---

## 7. Website data pipeline

```
upstream docs/execution-traces.json   (when the kernel ships one; else the bundled fixture)
        │  scripts/sync-upstream.mjs  writeTraces():
        │    validateTraceDataObject → groundTrace → checkProofCoverage → fold dry-run
        ▼
data/execution-traces.json            (grounded at sourceRef, same commit as map-data.json)
        │  scripts/validate-traces.mjs  (check.sh, CI)
        ▼
run.html → trace-engine.js → run-scenes.js → run.js
           fetch("data/execution-traces.json") → adoption gate → render
```

Re-ground after any trace edit:
`SELE4N_REF=<sourceRef> node scripts/sync-upstream.mjs && node scripts/apply-static-values.mjs`.

| File | Role |
|------|------|
| `run.html` | Page skeleton. Loads `trace-engine.js`, `run-scenes.js`, `run.js`, in that order. |
| `assets/js/trace-engine.js` | The fold, the op vocabulary, the recomputed decisions, the mirrors. ES5, no DOM. |
| `assets/js/run-scenes.js` | The seven SVG scenes, their legends and text alternatives. Draws; decides nothing. |
| `assets/js/run.js` | Controller: load, transport, URL state, step head, inspector, guarantees, invariants, sandbox. |
| `assets/css/run.css` | Page and scene styles; all scene styling is by class and data attribute (CSP). |
| `data/execution-traces.json` | The bundled fixture, schema v4. |
| `scripts/lib/trace-analysis.mjs` | Validator, `checkProofCoverage`, `transitionRoots`. |
| `scripts/lib/trace-anchors.mjs` | Grounding: names → lines, kernel facts, engine tables. |
| `scripts/validate-traces.mjs` | Bundle validation, line cross-check against `map-data.json`, proof coverage. |
| `scripts/lib/trace-analysis.test.mjs`, `scripts/lib/run-runtime.test.mjs` | Unit and headless runtime tests. |
| `scripts/run-smoke.mjs` | Headless-Chromium probe. |

---

## 8. Cross-cutting concerns

- **Localisation.** Every string the page or a scene paints goes through `t()` (six
  locales, key parity enforced); counts use plural families and locale number grouping.
  The trace's own prose (titles, narratives, stage labels, catalogue text) is data and
  ships in English.
- **Themes.** Scene colours are CSS custom properties resolved per theme; the probe
  paints both.
- **Performance.** A step renders one scene; states are folded once per scenario and
  cached; nothing measures layout in a loop except `fitText`, which measures a label
  once when it is drawn. Measured at 0.35.0: a step costs 27 ms of script and layout on
  a desktop and about 100 ms at 4x CPU throttling; 522 steps across the twelve
  scenarios leave the heap at 4.1 MB and the listener count where it started.
- **Nothing moves after first paint.** The page is drawn from the trace, which arrives
  after the markup. The badge row and the four boxes the trace fills (summary,
  properties, step strip, step heading) reserve the height the opening scenario gives
  them, and only while they are `:empty`. Cumulative layout shift while loading is 0 in
  English; a translated page keeps the shift of the locale replacing the English text.
- **Focus.** Every panel is rebuilt on each render. `render()` and `selectObject()`
  describe the focused control before the rebuild (`focusToken`) and focus its
  successor after it (`restoreFocus`): the current step's chip, the same object in the
  scene, the control in the same position of the same panel, or the stage. Clearing a
  selection returns focus to the object.
- **Contrast and forced colours.** Text on an accent fill is `--on-accent`, dark in the
  dark theme and white in the light one; a de-emphasised property or an unreached stage
  is muted and desaturated, never faded with `opacity` (which took its text below
  4.5:1). In forced-colours mode the selected step, scene, view and the properties at
  work take the system's selection colours.
- **The derivation tree's labels.** A node reads `minted · parent <slot>`: the
  operation the capability was derived by, and its *current* parent. Deleting a node
  splices its children onto its own parent (`CapDerivationTree.spliceNode`), keeping
  each child's operation, so "minted from <parent>" would name a capability the child
  was never minted from.

## 9. URL state

`?scenario=<id>&step=<n>&scene=<id>&view=before&lang=<locale>`. An unknown scenario
falls back to the first, a step out of range clamps, and a scene the scenario does not
offer falls back to its `focus`.

## 10. Security posture

- **Bundle-only.** `run.js` fetches `data/execution-traces.json` and nothing else;
  `connect-src 'self'`; no trace cache.
- **Strict adoption.** The page refuses a document of another schema version, with an
  unknown op, a refused step that changes state, or an op the fold throws on (a
  dangling reference, a pop that is not the queue's head). The mirrors run in the
  validator before the bundle ships, not again at load.
- **Policy.** `default-src 'none'` with each resource type the page uses named,
  `base-uri 'none'`, and `require-trusted-types-for 'script'`: no string reaches an HTML
  sink. `run.js` and `run-scenes.js` build the DOM with `createElement`,
  `createElementNS`, `textContent` and `setAttribute` only; the one Trusted Types
  policy the page allows belongs to the locale sanitizer in `i18n.js`.
- **Null-prototype tables.** The engine's lookup tables keyed by trace data (object
  ids, slot addresses) are created with `Object.create(null)`, so an id such as
  `__proto__` or `constructor` is a key like any other.
- **Links from stamped fields only.** `sourceHref()` takes the 40-hex `sourceRef`, a
  path derived from a validated module name, and an integer line. An unstamped
  reference is shown as text.
- **No inline style or script.** The scenes set classes and data attributes only.

## 11. Testing

| Tier | What | Command |
|------|------|---------|
| 0 | JS syntax | `node --check` over `assets/js/*.js` (`scripts/check.sh` globs them) |
| 1 | Engine, validator, grounding, proof coverage; headless runtime | `node scripts/lib/trace-analysis.test.mjs` · `node scripts/lib/run-runtime.test.mjs` |
| 2 | Bundle | `node scripts/validate-traces.mjs` |
| 4 | Browser | `node scripts/run-smoke.mjs` |

`run-runtime.test.mjs` boots the real engine, scenes and controller in a DOM shim; the
shim must implement every DOM call the runtime makes. `run-smoke.mjs` asserts what only
layout can show: every scene of every step at 1:1 with no text past its edge or box, no
sideways page overflow at desktop and phone widths, the stage scrolling inside its own
shell, the transport staying in reach, both themes, the tablist, the before/after
toggle and the step keys answering the keyboard, a text alternative per scene, the
sandbox breaking the invariant it names, a translated locale, a clean console and no
request that leaves the origin; and, since 0.35.0, that nothing moves after first
paint (layout shift below 0.02 in English at three widths, below 0.1 translated), that
the policy refuses nothing, that a trace which is missing, not JSON, empty, of another
schema version or carrying a refused step that changes state ends in the status line
saying so with nothing drawn, that keyboard focus survives a re-render (a step chip, an
object in the scene, clearing a selection, stepping from a link in a rebuilt panel),
and that the selected states still stand out in forced-colours mode.

## 12. Roadmap

- Kernel-side trace export (`source: "kernel"`), §6.
- The behaviours in §4.10, each when the engine can transcribe it exactly.
- Translating the trace's prose.

## 13. Documentation sync

Changes here are mirrored in `CLAUDE.md` (Simulator section), `docs/TESTING.md`,
`docs/DEVELOPER_GUIDE.md`, `docs/ARCHITECTURE.md` and `docs/UPSTREAM_TRACE_EXPORT.md`.
