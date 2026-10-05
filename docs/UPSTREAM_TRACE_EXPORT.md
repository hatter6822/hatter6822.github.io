# Upstream Trace Export — turning fixtures into kernel replay

> **Status: reference / design.** This document specifies the upstream (kernel-repo)
> work that flips the Simulator's data `source` from `"fixture"` to `"kernel"`,
> so the website replays *real* kernel runs instead of hand-authored illustrations.
> None of it exists upstream yet. The contract is trace schema **v2**
> (`docs/SIMULATOR_SPEC.md` §4). The Lean below is an **uncompiled reference sketch** written against
> the kernel's known API (`SeLe4n.Model.State`, `SeLe4n.Testing.*`); it is a starting
> point for the kernel maintainer to compile and adjust against the live signatures —
> not drop-in code.

Audience: maintainers of `hatter6822/seLe4n` (the kernel) and of this website.

---

## 1. Goal and the one invariant that matters

The website already has the complete consumer side (schema v2, fold engine, validator,
grounding, `scripts/sync-upstream.mjs`, six scenes). The only thing standing between
"honest illustration" and "replay of a kernel run" is an upstream artifact:

```
hatter6822/seLe4n : docs/execution-traces.json   (source: "kernel")
```

Once that file exists in the checkout the sync clones, `node scripts/sync-upstream.mjs`
adopts it in place of the bundled fixture and writes `data/execution-traces.json`; the
page's source badge reads **"kernel export · vX"** with zero website code changes.

**The sync trusts nothing it is handed, the kernel's own export included.** It
validates the document (`validateTraceDataObject`), then grounds it at the same commit
the code map is generated from (`groundTrace` in `scripts/lib/trace-anchors.mjs`): every
declaration reference must resolve in its module's file, every syscall must be a
`SyscallId` constructor, every required right must match `syscallRequiredRight`, every
error must be a `KernelError` constructor. Any issue and the sync refuses to write the
snapshot. So an exporter that drifts from the kernel it ships with fails the website's
sync loudly instead of publishing a wrong claim.

**The schema is the contract.** The website never re-implements kernel semantics — it
*folds* the effects a trace records and *stamps* the declarations it names. So the
exporter's job is to emit, per step: (a) the structured effect ops, (b) the outcome and
the checked-entry path it took, and (c) the declarations involved, as `{ name, module }`
references. As long as the JSON matches `docs/SIMULATOR_SPEC.md` §4, the website renders
it.

---

## 2. Where it lives

| Artifact | Location (kernel repo) | Role |
|----------|------------------------|------|
| `TraceExport.lean` | `SeLe4n/Testing/TraceExport.lean` | Projects `SystemState`, records ops, outcome and path, serializes JSON. |
| export entry point | `Main.lean` (a `lake exe sele4n-trace-export` target) or a flag on the existing `lake exe sele4n` harness | Runs the scenarios and writes the file. |
| CI step | the workflow that already emits `docs/codebase_map.json` | `lake exe … > docs/execution-traces.json`, committed alongside the map **at the same commit** (grounding resolves every name in that checkout). |

The website's sync reads `docs/execution-traces.json` from the one checkout it already
clones for the code map (`TRACES_PATH` in `sync-upstream.mjs`) — no extra fetch. The
page itself never contacts GitHub for traces: it serves the bundled snapshot only, so no
new endpoints or CSP origins are needed.

---

## 3. The contract, concretely

### 3.1 State projection (kernel `SystemState` → website JSON)

The website wants a *display projection*, not the internal representation. Map only
what the scenes render (all additive — omit a block and its scene tab simply hides):

| Website field | Source in `SeLe4n.Model.State.SystemState` |
|---------------|--------------------------------------------|
| `current.thread`, `current.core` | `scheduler.currentThread`, current core |
| `threads[]` | each `TCB` in `objects` (project `tid`, `priority`, `domain`, `ipcState`, `threadState`, `timeSlice`, `deadline`, `schedContext…`, `pipBoost`, `replyObject`, …) |
| `endpoints[]` | each `Endpoint` (`sendQ`/`receiveQ` thread ids from the intrusive dual queue) |
| `notifications[]` | each `Notification` (`state`, `waitingThreads`, `pendingBadge`) |
| `runQueue` | `scheduler.runQueue` (per-core, per-priority bucket → ordered thread ids) |
| `cdt` | `cdt : CapDerivationTree` (nodes from `childMap`/`parentMap`; `slot`/`target`/`rights`/`badge` from the slot's `Capability`) |
| `untyped[]` | each `UntypedObject` (`regionBase`, `regionSize`, `watermark`, `isDevice`, `children`) |
| `infoflow` | the `DomainFlowPolicy` (`domains` with confidentiality/integrity; `policy` = allowed-flow edges) plus `audit` = the declassification audit log as `{from, to, actor}` records |
| `vspace[]` | each address space (`asid`; `mappings` = `vaddr`→`paddr`/`perms` from the page tables; `tlb` = the virtual addresses with cached translations) |

`ipcState` is stringified with its target after a colon
(`blockedOnReceive:<endpointId>`), mirroring the `ThreadIpcState` constructors.

### 3.2 Effect ops (the delta)

Two emission strategies — pick whichever is least invasive upstream:

**(A) Instrumented (preferred).** Wrap each harness mutation so it appends the op it
just performed. The op set is small and maps 1:1 to operations:

| Kernel operation | Op(s) emitted |
|------------------|---------------|
| `chooseThread` / context switch | `setCurrent`, `rqRemove`, `threadPatch{threadState}` |
| endpoint send/recv rendezvous | `message`, `epDequeue`/`epEnqueue`, `threadPatch{ipcState}`, `rqInsert` |
| `notificationSignal` / `Wait` | `notifPatch`, `threadPatch`, `rqInsert` |
| `cspaceMint`/`Copy` | `cdtInsert{node, parent}` |
| `cspaceRevoke` (the fixture cites `cspaceRevokeCdtFinalising`) | `cdtRevoke{node}` — removes the node's descendants and **keeps the node** |
| delete of a subtree | `cdtRemove{node}` — removes the node and its descendants |
| `retypeFromUntyped` | `untypedRetype{untyped, child}` |
| untyped reset | `untypedReset{untyped}` — drops the carved objects, watermark back to zero |
| flow check (`securityFlowsTo`) | `flowCheck{from, to, allowed}` (event-only) |
| declassification authorize | `auditAppend{entry:{from, to, actor}}` — appends to `infoflow.audit`; the policy is **never** edited |
| `mapPage` / `unmapPage` | `vspaceMap{vspace, mapping}` (caches the page in `tlb`) / `vspaceUnmap{vspace, vaddr}` (shoots down the `tlb` entry) |
| a refused map (W^X) | `vspaceReject{vspace, mapping}` (event-only) |

The full vocabulary is `ALLOWED_OPS` in `scripts/lib/trace-analysis.mjs`, an
allow-list. Schema v1's `untypedRevoke`, `ifPolicyAdd`, `ifPolicyRemove` and
`servicePatch` are retired and rejected; an exporter must not emit them.

**A refused step carries no state change.** A kernel transition is
`KernelM σ ε α := σ → Except ε (α × σ)`, and the error branch carries no successor state.
So for a step whose result is `.error e`, emit only event ops (`EVENT_OPS`: `flowCheck`,
`vspaceReject`, `message`, `note`) — never a mutation — and record the error in
`outcome` (§3.3). The validator rejects a refused step whose delta would change state,
and so does the browser. An instrumented exporter gets this for free if it records ops
only on the `.ok` branch; a snapshot-diff exporter gets it because the before and after
projections are equal.

**(B) Snapshot-diff (zero instrumentation).** Emit only the projected state *before*
and *after* each step; let the website's sync script derive the ops by diffing
consecutive projections. This needs no harness changes — only the projector from
§3.1. If you choose (B), add a `projectionDiff(prev, next) → ops` helper to
`scripts/lib/trace-analysis.mjs` (and a unit test); the fold engine already round-trips
the result. Strategy (A) yields richer per-step provenance (the path, the refusing stage,
source refs); (B) is faster to land, but it cannot see the path: an exporter using it
still has to record `outcome` and `path` from the call itself. They can coexist: ship (B)
first, refine to (A) per subsystem.

### 3.3 Outcome and the checked syscall path

Every step carries an `outcome`: `{ "status": "ok" }`, or `{ "status": "error",
"error": "<KernelError constructor>" }` — the constructor name as written in
`SeLe4n/Model/KernelError.lean` (`illegalAuthority`, `flowDenied`, …).

A syscall step also carries `syscall` and, ideally, `path`:

- `syscall.id` — the `SyscallId` constructor (`SeLe4n/Model/Object/Types.lean`);
- `syscall.requiredRight` — the right `syscallRequiredRight` assigns it
  (`SeLe4n/Kernel/API.lean`): one of `read`, `write`, `grant`, `grantReply`, `retype`;
- `syscall.capPath`, `syscall.args` — free-form display detail;
- `path[]` — the stages of the checked entry the call went through, in kernel order:
  `entry`, `decode`, `lookup`, `rights`, `flow`, `operation` (omit a stage the call does
  not pass through). Each is `{ stage, label, ref?, result }` with `result` one of
  `pass`, `fail`, `skip`. On a refusal, **exactly one** stage is `fail` and carries
  `error` equal to `outcome.error`; every stage after it is `skip`. On success no stage
  is `fail` or `skip`.

The sync checks `syscall.id`, `requiredRight` and every error against the kernel source
at the exported commit, so these must be the kernel's own spellings.

### 3.4 Properties, invariants and references

Every declaration the document names is a **reference** `{ "name", "module" }` — the
declaration's name (qualified or not) and the Lean module whose file declares it. Emit
nothing more: the website's sync resolves each reference in that file of the same
checkout, trying the qualified name and then its last segment, and stamps `path` and
`line` itself, with the commit as `sourceRef`. A reference it cannot place fails the
sync, naming it. References appear in:

- `propertyCatalog[]` — each security property: `id`, `label`, a one-sentence
  `statement`, an optional `caveat` stating its scope honestly, `theorems` (≥ 1
  reference), and the `invariants` ids it rests on.
- `invariantCatalog[]` — each invariant: `id`, `label`, `subsystem`, `meaning`, its
  `predicate` (the Lean definition), `preservedBy` (≥ 1 preservation theorem) and an
  optional `runtimeCheck` (an executable check in `SeLe4n.Testing.InvariantChecks`,
  which the page labels "test harness, not a proof").
- each step's `sourceRefs` and each `path[].ref`.

Per step, `guarantees` lists the property ids the step relies on, and `invariants`
records `preserved` (the catalogue ids a preservation theorem covers for this
transition) and, optionally, `failed`. Schema v1's `invariants.allHold`,
`invariants.checked` and `invariantCatalog[].check`/`mapModule` are gone: a list of
boolean checks that passed is a test result, and the page now cites the theorems.

The executable checks are still useful to the exporter as a **self-test**: run
`stateInvariantChecks` on each state after a step, and if any check fails, put the
corresponding catalogue ids in `invariants.failed` — the page shows those as violated,
never green. For a real run of the verified kernel the list should always be empty;
an export that says otherwise has found a bug in the harness or the projection.
Each scenario also names the property ids it demonstrates in `properties` (≥ 1).

---

## 4. Reference sketch (`SeLe4n/Testing/TraceExport.lean`)

```lean
-- UNCOMPILED REFERENCE. Compile and adapt against the live signatures.
import SeLe4n.Model.State
import SeLe4n.Testing.StateBuilder
import SeLe4n.Testing.InvariantChecks
import Lean.Data.Json

namespace SeLe4n.Testing.TraceExport
open Lean (Json)

/-- A recorded op (the delta vocabulary). Construct with the helpers below. -/
abbrev Op := Json

def setCurrent (thread : Option String) (core : Nat) : Op :=
  Json.mkObj [("op", "setCurrent"), ("thread", thread.elim Json.null Json.str), ("core", core)]

def threadPatch (id : String) (set : List (String × Json)) : Op :=
  Json.mkObj [("op", "threadPatch"), ("id", id), ("set", Json.mkObj set)]

def message (from to : String) (regs : Nat) : Op :=
  Json.mkObj [("op","message"), ("from",from), ("to",to), ("registers", regs)]
-- … epEnqueue/epDequeue/rqInsert/rqRemove/notifPatch/cdtInsert/cdtRemove/cdtRevoke/
--    cdtPatch/untypedRetype/untypedReset/flowCheck/auditAppend/vspaceMap/vspaceUnmap/
--    vspaceReject/note likewise (ALLOWED_OPS in scripts/lib/trace-analysis.mjs).

/-- A declaration reference. The website stamps `path` and `line`; emit only these. -/
def ref (name module : String) : Json :=
  Json.mkObj [("name", name), ("module", module)]

/-- Project the live `SystemState` into the website's display shape (§3.1). -/
def projectState (s : SystemState) : Json := Id.run do
  -- Walk `s.objects`, `s.scheduler`, `s.cdt`, … and emit only the fields the scenes
  -- render. `reprStr`/`ToString` for enums (ThreadIpcState → "blockedOnReceive:<id>", etc.).
  Json.mkObj [
    ("current",  Json.mkObj [("thread", /-…-/ Json.null), ("core", 0)]),
    ("threads",  Json.arr #[ /- per TCB -/ ]),
    ("endpoints", Json.arr #[ /- per Endpoint -/ ]),
    ("notifications", Json.arr #[]),
    ("runQueue", Json.mkObj []),
    -- include cdt / untyped / infoflow / vspace only when present
  ]

/-- One stage of the checked syscall path (§3.3). -/
structure PathStage where
  stage  : String                    -- entry|decode|lookup|rights|flow|operation
  label  : String
  ref    : Option Json := none       -- `ref name module`
  result : String                    -- pass|fail|skip
  error  : Option String := none     -- only on the one `fail` stage

/-- One step: metadata, what the kernel returned, the path, the ops on success. -/
structure StepRecord where
  index      : Nat
  kind       : String                -- boot|syscall|schedule|timer|ipc|fault|interrupt
  title      : String
  traceTag   : String                -- reuse the existing "[TAG]" codes
  actor      : Option String := none
  syscall    : Option Json := none   -- { id, requiredRight, capPath?, args? }
  path       : Array PathStage := #[]
  error      : Option String := none -- the KernelError constructor when refused
  ops        : Array Op := #[]       -- event ops only when `error` is some
  sourceRefs : Array Json := #[]
  guarantees : Array String := #[]   -- propertyCatalog ids
  preserved  : Array String := #[]   -- invariantCatalog ids
  failed     : Array String := #[]   -- catalogue ids whose runtime check failed (self-test)

def stepJson (r : StepRecord) : Json :=
  Json.mkObj [
    ("index", r.index), ("kind", r.kind), ("title", r.title), ("traceTag", r.traceTag),
    ("actor", r.actor.elim Json.null Json.str),
    ("outcome", match r.error with
      | none   => Json.mkObj [("status", "ok")]
      | some e => Json.mkObj [("status", "error"), ("error", e)]),
    -- … ("syscall", …) and ("path", …) when present
    ("sourceRefs", Json.arr r.sourceRefs),
    ("guarantees", Json.arr (r.guarantees.map Json.str)),
    ("delta", Json.mkObj [("ops", Json.arr r.ops)]),
    ("invariants", Json.mkObj [
      ("preserved", Json.arr (r.preserved.map Json.str)),
      ("failed",    Json.arr (r.failed.map Json.str))])]

/-- A scenario: id/title/summary, the properties it demonstrates, the initial
    projection and the recorded steps. -/
def scenarioJson (id title summary : String) (properties : Array String)
    (primaryScene : String) (initial : SystemState) (steps : Array StepRecord) : Json :=
  Json.mkObj [
    ("id", id), ("title", title), ("summary", summary),
    ("properties", Json.arr (properties.map Json.str)), ("primaryScene", primaryScene),
    ("initialState", projectState initial),
    ("steps", Json.arr (steps.map stepJson))]

/-- Top level. `sourceRef`, `kernelCommit` and every reference's `path`/`line` are
    stamped by the website's sync; the exporter does not write them. -/
def export (properties invariants scenarios : Array Json) : Json :=
  Json.mkObj [
    ("schemaVersion", (2 : Nat)), ("source", "kernel"),
    ("generator", "SeLe4n.Testing.TraceExport"),
    ("disclaimer", "Exported from a kernel run."),
    ("kernelVersion", /- lakefile -/ "0.0.0"),
    ("leanToolchain", "4.28.0"), ("generatedAt", /- ISO now -/ ""),
    ("propertyCatalog", Json.arr properties),
    ("invariantCatalog", Json.arr invariants),
    ("scenarios", Json.arr scenarios)]

end SeLe4n.Testing.TraceExport
```

The existing `runCapabilityIpcTrace`, `runSchedulerTimingDomainTrace`,
`runUntypedMemoryTrace`, … in `MainTraceHarness` already perform transitions like the
ones the bundled scenarios illustrate; the work is to thread a `StepRecord`
accumulator through them (strategy A) or snapshot `projectState` at each
`checkInvariants` call site (strategy B), record each call's result as `outcome` and
`path`, then `IO.FS.writeFile "docs/execution-traces.json" (export …).pretty`.

The property and invariant catalogues can start as a copy of the ones in the bundled
fixture (`data/execution-traces.json`, with the stamped `path`/`line` dropped): every
reference in them already resolves at the commit recorded as its `sourceRef`.

---

## 5. Verification loop (once upstream lands)

```bash
# in the kernel repo CI (or locally):
lake exe sele4n-trace-export > docs/execution-traces.json

# in this website repo:
node scripts/sync-upstream.mjs       # validates + grounds + writes data/execution-traces.json,
                                     #   or refuses and names every issue
node scripts/validate-traces.mjs      # schema, grounding vs map-data, fold; prints source=kernel
node scripts/lib/trace-analysis.test.mjs
node scripts/lib/run-runtime.test.mjs
```

When `validate-traces.mjs` prints `source=kernel` and drops the fixture warning, the
Simulator is replaying kernel runs and the source badge updates automatically. The
bundled fixture is then no longer read by the sync (it adopts the upstream file whenever
one exists); it can be deleted or kept as a reference.

Typical refusals, and what they mean:

| Sync message | Cause |
|--------------|-------|
| `… failed validation; refusing to write the snapshot` | Schema v2 violated — e.g. a refused step with a mutating op, a path with two `fail` stages, an unknown op such as a v1 `servicePatch`. |
| `<where>: <name> in <module>` under "names kernel facts this checkout does not have" | A reference's declaration is not in that module's file at the exported commit (renamed, moved, or the module named instead of the declaration). |
| `syscall "<id>" is not a SyscallId constructor` | The exporter spelled the syscall differently from the kernel. |
| `<id> requires "<right>" per syscallRequiredRight, the trace says "<other>"` | `requiredRight` disagrees with the kernel's table. |
| `"<error>" is not a KernelError constructor` | An outcome or path error is not the kernel's spelling. |

## 6. Honest caveats

- The Lean above is a **reference**, not compiled code; field names and `Json` helpers
  must be reconciled with the live API.
- Strategy (B) (snapshot-diff) is the lowest-risk first landing; the website-side
  `projectionDiff` helper it needs is straightforward to add and unit-test here. It does
  not yet exist.
- A kernel export is replay, not proof: the page's claims of safety still come from the
  theorems the catalogues cite, which grounding only proves *exist* at that commit — not
  that they say what a `statement` paraphrases. Keep each statement and caveat as precise
  as the theorem it cites.
