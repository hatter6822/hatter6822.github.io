# Upstream Trace Export — turning fixtures into verified replay

> **Status: reference / design.** This document specifies the upstream (kernel-repo)
> work that flips the Simulator's data `source` from `"fixture"` to `"kernel"`,
> so the website replays *real* machine-checked executions instead of hand-authored
> illustrations. The Lean below is an **uncompiled reference sketch** written against
> the kernel's known API (`SeLe4n.Model.State`, `SeLe4n.Testing.*`); it is a starting
> point for the kernel maintainer to compile and adjust against the live signatures —
> not drop-in code.

Audience: maintainers of `hatter6822/seLe4n` (the kernel) and of this website.

---

## 1. Goal and the one invariant that matters

The website already has the complete consumer side (schema, fold engine, validator,
`scripts/sync-upstream.mjs`, six scenes). The only thing standing between "honest
illustration" and "replay of a verified run" is an upstream artifact:

```
hatter6822/seLe4n : docs/execution-traces.json   (source: "kernel")
```

Once that file exists, `node scripts/sync-upstream.mjs` reads + validates it and
writes `data/execution-traces.json`; the website's source badge flips to **"verified
kernel export"** with zero website code changes.

**The op vocabulary is the contract.** The website never re-implements kernel
semantics — it *folds* the effects a trace records. So the exporter's only job is to
emit, per step, (a) the structured effect ops and (b) the invariant-check results. As
long as the JSON matches `docs/SIMULATOR_SPEC.md` §4, the website renders it.

---

## 2. Where it lives

| Artifact | Location (kernel repo) | Role |
|----------|------------------------|------|
| `TraceExport.lean` | `SeLe4n/Testing/TraceExport.lean` | Projects `SystemState`, records ops + invariant results, serializes JSON. |
| export entry point | `Main.lean` (a `lake exe sele4n-trace-export` target) or a flag on the existing `lake exe sele4n` harness | Runs the scenarios and writes the file. |
| CI step | the workflow that already emits `docs/codebase_map.json` | `lake exe … > docs/execution-traces.json`, committed alongside the map. |

The website's sync already points at `docs/execution-traces.json` (raw, then the
contents API). No new endpoints or CSP origins are needed.

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
| `infoflow` | the `DomainFlowPolicy` (`domains` with confidentiality/integrity; `policy` = allowed-flow edges) |
| `services[]` | `serviceRegistry` (`status` from `ServiceStatus`; `deps` from the dependency graph) |
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
| `cspaceRevokeCdtStrict` / delete | `cdtRemove{node}` |
| `retypeFromUntyped` | `untypedRetype{untyped, child}` |
| untyped revoke | `untypedRevoke{untyped}` |
| flow check (`securityFlowsTo`) | `flowCheck{from, to, allowed}` (event-only) |
| declassification authorize | `ifPolicyAdd{from, to}` |
| `serviceStart`/`Stop`/`Restart` | `servicePatch{id, set:{status}}` |
| `mapPage` / `unmapPage` | `vspaceMap{vspace, mapping}` (caches the page in `tlb`) / `vspaceUnmap{vspace, vaddr}` (shoots down the `tlb` entry) |

**(B) Snapshot-diff (zero instrumentation).** Emit only the projected state *before*
and *after* each step; let the website's sync script derive the ops by diffing
consecutive projections. This needs no harness changes — only the projector from
§3.1. If you choose (B), add a `projectionDiff(prev, next) → ops` helper to
`scripts/lib/trace-analysis.mjs` (and a unit test); the fold engine already round-trips
the result. Strategy (A) yields richer per-op provenance (syscall/right/source refs);
(B) is faster to land. They can coexist: ship (B) first, refine to (A) per subsystem.

### 3.3 Invariants

For each step, evaluate the boolean checks the kernel already exposes and fill
`invariants`:

```lean
-- SeLe4n.Testing.InvariantChecks
def stateInvariantChecks (s : SystemState) : List (String × Bool)
private def failedChecks (checks : List (String × Bool)) : List String  -- failedChecks (stateInvariantChecks s) empty ⇒ allHold
```

- `invariants.allHold := (failedChecks (stateInvariantChecks stateAfter)).isEmpty`
- `invariants.checked := <the catalog ids re-validated at this transition>`
- `invariants.failed := failedChecks (stateInvariantChecks stateAfter)` (must be `[]` whenever `allHold`; since `failedChecks` is file-private, an external exporter re-derives it from `stateInvariantChecks` output)

The website's `invariantCatalog[].check` names are exactly these check functions, so
the rail links each one back to its proof module on `map.html`. Because every check is
proven to hold for all reachable states, `allHold` is always `true` for a real run —
that is the whole point, and the export makes it observable rather than asserted.

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
-- … epEnqueue/epDequeue/rqInsert/rqRemove/notifPatch/cdtInsert/cdtRemove/
--    untypedRetype/untypedRevoke/flowCheck/ifPolicyAdd/servicePatch likewise.

/-- Project the live `SystemState` into the website's display shape (§3.1). -/
def projectState (s : SystemState) : Json := Id.run do
  -- Walk `s.objects`, `s.scheduler`, `s.cdt`, `s.serviceRegistry`, … and emit only
  -- the fields the scenes render. `reprStr`/`ToString` for enums (ServiceStatus,
  -- ThreadIpcState → "blockedOnReceive:<id>", etc.).
  Json.mkObj [
    ("current",  Json.mkObj [("thread", /-…-/ Json.null), ("core", 0)]),
    ("threads",  Json.arr #[ /- per TCB -/ ]),
    ("endpoints", Json.arr #[ /- per Endpoint -/ ]),
    ("notifications", Json.arr #[]),
    ("runQueue", Json.mkObj []),
    -- include cdt / untyped / infoflow / services only when present
  ]

/-- One step: metadata + the ops performed + the invariant outcome. -/
structure StepRecord where
  index     : Nat
  kind      : String                 -- boot|syscall|schedule|timer|ipc|fault|interrupt
  title     : String
  traceTag  : String                 -- reuse the existing "[TAG]" codes
  actor     : Option String := none
  ops       : Array Op := #[]
  checked   : Array String := #[]    -- catalog ids re-validated here

def stepJson (r : StepRecord) (stateAfter : SystemState) : Json :=
  let failed := failedChecks stateAfter
  Json.mkObj [
    ("index", r.index), ("kind", r.kind), ("title", r.title), ("traceTag", r.traceTag),
    ("actor", r.actor.elim Json.null Json.str),
    ("delta", Json.mkObj [("ops", Json.arr r.ops)]),
    ("invariants", Json.mkObj [
      ("allHold", failed.isEmpty),
      ("checked", Json.arr (r.checked.map Json.str)),
      ("failed",  Json.arr (failed.toArray.map Json.str))])]

/-- A scenario: id/title/summary + the initial projection + the recorded steps. -/
def scenarioJson (id title summary : String) (primaryScene : String)
    (initial : SystemState) (steps : Array (StepRecord × SystemState)) : Json :=
  Json.mkObj [
    ("id", id), ("title", title), ("summary", summary), ("primaryScene", primaryScene),
    ("initialState", projectState initial),
    ("steps", Json.arr (steps.map (fun (r, st) => stepJson r st)))]

/-- Top level. Run the harness scenarios, collecting (StepRecord × stateAfter). -/
def export (scenarios : Array Json) : Json :=
  Json.mkObj [
    ("schemaVersion", (1 : Nat)), ("source", "kernel"),
    ("kernelVersion", /- lakefile -/ "0.0.0"), ("kernelCommit", /- git -/ ""),
    ("leanToolchain", "4.28.0"), ("generatedAt", /- ISO now -/ ""),
    ("invariantCatalog", /- the same list the website bundles -/ Json.arr #[]),
    ("scenarios", Json.arr scenarios)]

end SeLe4n.Testing.TraceExport
```

The existing `runCapabilityIpcTrace`, `runSchedulerTimingDomainTrace`,
`runUntypedMemoryTrace`, … in `MainTraceHarness` already perform exactly the
transitions the six bundled scenarios illustrate; the work is to thread a
`StepRecord` accumulator through them (strategy A) or snapshot `projectState` at each
`checkInvariants` call site (strategy B), then `IO.FS.writeFile "docs/execution-traces.json" (export scenarios).pretty`.

---

## 5. Verification loop (once upstream lands)

```bash
# in the kernel repo CI (or locally):
lake exe sele4n-trace-export > docs/execution-traces.json

# in this website repo:
node scripts/sync-upstream.mjs       # reads + validates + writes data/execution-traces.json
node scripts/validate-traces.mjs      # schema + fold dry-run; now prints source=kernel (no fixture warning)
node scripts/lib/trace-analysis.test.mjs
node scripts/lib/run-runtime.test.mjs
```

When `validate-traces.mjs` prints `source=kernel` and drops the fixture warning, the
Simulator is replaying verified runs and the badge updates automatically. The bundled
fixtures can then be deleted or kept as offline fallbacks.

## 6. Honest caveats

- The Lean above is a **reference**, not compiled code; field names and `Json` helpers
  must be reconciled with the live API.
- Strategy (B) (snapshot-diff) is the lowest-risk first landing; the website-side
  `projectionDiff` helper it needs is straightforward to add and unit-test here.
- Keep the exported `invariantCatalog` in lockstep with the website's bundled catalog
  (same `id`s and `check` names) so the rail's `map.html` links resolve.
