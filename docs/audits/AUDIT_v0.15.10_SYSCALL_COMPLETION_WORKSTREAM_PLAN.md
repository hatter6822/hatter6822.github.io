# Syscall Completion Workstream Plan

> Audit baseline: seLe4n upstream **v0.15.10** · Website **0.3.1**

## Portfolio overview

This document tracks the active workstream portfolio for the seLe4n website, organized by subsystem focus. Each workstream is scoped to specific codebase changes with measurable completion criteria.

---

## WS-K-E — Service Policy and IPC Message Population

### Objective

Upgrade the website's representation of the seLe4n kernel's **Service Policy** subsystem and **IPC Message Population** mechanics so that the site accurately reflects the upstream kernel's service orchestration capabilities, IPC message transfer semantics, and their verified proof coverage. This includes data pipeline enhancements, landing page content accuracy, map runtime improvements, and comprehensive test coverage.

### Current state assessment

| Area | Status | Gap |
|------|--------|-----|
| Service subsystem on landing page | Basic service graph description | Missing service policy enforcement details, restart semantics, health state transitions |
| IPC subsystem on landing page | Dual-queue description present | Missing message population semantics (pendingMessage, message transfer verification details) |
| API syscall table | `serviceStart`/`serviceStop`/`serviceRestart` listed | Missing service policy entry points (`servicePolicyCheck`, `serviceHealthQuery`) if they exist upstream |
| Map data normalization | Generic module handling | No service-policy-aware or IPC-message-aware metadata enrichment |
| Data validation | Generic schema checks | No service/IPC-specific field validation |
| CI workflow | IPC files enumerated for theorem counting | Service policy files not explicitly tracked |
| Test coverage | Generic map/toolbar/parser tests | No service-policy or IPC-message-specific test cases |

### Architecture context

The upstream seLe4n kernel organizes Service and IPC as follows:

```
SeLe4n/Kernel/
├── Service/
│   ├── Operations.lean   — serviceStart, serviceStop, serviceRestart
│   └── Invariant.lean    — service dependency graph invariants
├── IPC/
│   ├── DualQueue.lean    — sendQ/receiveQ intrusive dual-queue
│   ├── Operations.lean   — endpointSendDual, endpointReceiveDual, endpointReply, endpointCall, endpointReplyRecv
│   └── Invariant.lean    — IPC queue and message transfer invariants
└── InformationFlow/
    ├── Enforcement.lean  — endpointSendDualChecked, serviceRestartChecked
    └── Policy.lean       — domain assignment and flow policy
```

The website currently tracks these modules through the generic codebase map pipeline, but doesn't extract or display service-policy-specific metadata (dependency graph properties, cycle detection invariants, health state tracking) or IPC-message-specific metadata (message population rules, pendingMessage rendezvous semantics, queue invariant coverage).

---

### Task breakdown

#### Phase 1: Landing page content accuracy (index.html)

##### Task 1.1 — Refine Service Orchestration card content
**File:** `index.html` (lines ~508–515)
**Scope:** Update the "Service Orchestration" card to include:
- Service policy enforcement details (acyclic dependency policy, DFS cycle detection)
- Service health state transitions (start → running → stop/restart lifecycle)
- Dependency-aware startup/shutdown ordering semantics
- Theorem count for service invariants (cross-reference with live data)

**Acceptance:** Card content accurately reflects upstream `Service/Operations.lean` and `Service/Invariant.lean` capabilities. No broken links. All external links use `rel="noopener noreferrer"`.

##### Task 1.2 — Refine IPC & Dual-Queue card content
**File:** `index.html` (lines ~319–325)
**Scope:** Update the "IPC & Dual-Queue" card to include:
- Message population semantics: how `TCB.pendingMessage` is set during send and consumed during receive
- Message transfer verification: theorems proving message integrity across rendezvous
- Dual-queue invariant summary (sendQ/receiveQ disjointness, no ghost entries)
- Sentinel ID rejection at IPC boundaries (already mentioned in security section, cross-reference here)

**Acceptance:** Card content accurately describes message population flow. No factual claims without upstream code backing.

##### Task 1.3 — Update comparison table IPC row
**File:** `index.html` (lines ~375–378)
**Scope:** Enhance the "IPC queuing" comparison row to mention message population verification as a differentiator from traditional kernels.

**Acceptance:** Comparison accurately contrasts seLe4n's verified message transfer with traditional unverified IPC.

##### Task 1.4 — Update syscall API table completeness
**File:** `index.html` (lines ~770–790)
**Scope:** Audit the syscall API table against the upstream repo structure:
- Verify all service entry points are listed
- Verify all IPC entry points are listed (both dual-queue and legacy)
- Ensure status badges accurately reflect current upstream state
- Add any missing info-flow checked variants

**Acceptance:** API table matches upstream `API.lean` entry points. All links resolve.

##### Task 1.5 — Refine security section IPC references
**File:** `index.html` (lines ~585–595)
**Scope:** Ensure the security section's IPC references accurately describe:
- Sentinel ID rejection semantics
- Information-flow checked IPC variants
- Message integrity guarantees

**Acceptance:** Security claims are backed by upstream proofs.

#### Phase 2: Data pipeline and validation enhancements

##### Task 2.1 — Add service/IPC module awareness to CI workflow
**File:** `.github/workflows/sync-sele4n-data.yml`
**Scope:** Ensure the PROOF_FILES array includes all Service and IPC files:
- Verify `SeLe4n/Kernel/Service/Operations.lean` is listed
- Verify `SeLe4n/Kernel/Service/Invariant.lean` is listed
- Verify all three IPC files are listed (DualQueue, Operations, Invariant)
- Add any missing InformationFlow enforcement files

**Acceptance:** CI theorem counting covers all service and IPC proof files.

##### Task 2.2 — Validate site-data.json version consistency
**File:** `data/site-data.json`
**Scope:** Ensure `version` field matches the current upstream seLe4n version. Currently shows `0.14.4` — verify against upstream and update if stale.

**Acceptance:** Version field is accurate or has a documented rationale for divergence.

#### Phase 3: Map runtime service/IPC enrichment

##### Task 3.1 — Verify service module proof-pair detection
**Files:** `assets/js/map.js` (buildPairs, assuranceForModule)
**Scope:** Verify that `SeLe4n.Kernel.Service.Operations` and `SeLe4n.Kernel.Service.Invariant` are correctly detected as a proof pair by the existing `moduleKind` and `moduleBase` functions. Test that their assurance level is computed correctly.

**Acceptance:** Service modules produce a valid proof pair with correct assurance level in test fixtures.

##### Task 3.2 — Verify IPC module proof-pair detection
**Files:** `assets/js/map.js` (buildPairs, assuranceForModule)
**Scope:** Verify that `SeLe4n.Kernel.IPC.Operations` and `SeLe4n.Kernel.IPC.Invariant` are correctly detected as a proof pair. Verify that `SeLe4n.Kernel.IPC.DualQueue` is treated as a standalone module with local theorem assurance (not a pair half).

**Acceptance:** IPC Operations/Invariant form a linked pair; DualQueue has independent assurance.

##### Task 3.3 — Verify declaration context navigation for Service/IPC modules
**Files:** `assets/js/map.js` (declarationGraph, declarationIndex)
**Scope:** Verify that service operations (`serviceStart`, `serviceStop`, `serviceRestart`) and IPC operations (`endpointSendDual`, `endpointReceiveDual`, `endpointReply`, `endpointCall`, `endpointReplyRecv`) can be navigated in declaration context when declaration data is present in the canonical payload.

**Acceptance:** Declaration context renders correctly for service and IPC entry points.

#### Phase 4: Test coverage expansion

##### Task 4.1 — Add service proof-pair test fixture to map-runtime.test.mjs
**File:** `scripts/lib/map-runtime.test.mjs`
**Scope:** Add a test case that constructs a minimal map payload with:
- `SeLe4n.Kernel.Service.Operations` and `SeLe4n.Kernel.Service.Invariant` modules
- Invariant importing Operations
- Verify `buildPairs` produces a linked pair with base `SeLe4n.Kernel.Service`
- Verify `assuranceForModule` returns `level: "linked"` for both modules

**Acceptance:** Test passes with zero warnings.

##### Task 4.2 — Add IPC multi-module proof-pair test to map-runtime.test.mjs
**File:** `scripts/lib/map-runtime.test.mjs`
**Scope:** Add a test case with:
- `SeLe4n.Kernel.IPC.Operations`, `SeLe4n.Kernel.IPC.Invariant`, and `SeLe4n.Kernel.IPC.DualQueue`
- Invariant importing Operations
- DualQueue importing Operations
- Verify pair detection produces exactly one pair (Operations/Invariant)
- Verify DualQueue gets independent assurance (local or none, not paired)

**Acceptance:** Test passes with zero warnings.

##### Task 4.3 — Add service declaration context test to map-runtime.test.mjs
**File:** `scripts/lib/map-runtime.test.mjs`
**Scope:** Add a test that constructs a declaration-centric payload for service modules with `declarations` arrays containing `serviceStart`, `serviceStop`, `serviceRestart` with `called` relationships, and verify:
- `declarationGraph` contains the service operations
- `declarationReverseGraph` contains correct reverse edges
- `declarationIndex` maps each operation to the correct module, kind, and line

**Acceptance:** Test passes with zero warnings.

##### Task 4.4 — Add IPC message transfer declaration test to map-runtime.test.mjs
**File:** `scripts/lib/map-runtime.test.mjs`
**Scope:** Add a test with IPC declaration data including `endpointSendDual`, `endpointReceiveDual` with `called` relationships to message transfer helpers, and verify:
- Declaration graph edges are correct
- Reverse graph captures callers
- Module resolution works for IPC declarations

**Acceptance:** Test passes with zero warnings.

##### Task 4.5 — Add CI workflow file coverage assertion to data-validation.test.mjs
**File:** `scripts/lib/data-validation.test.mjs`
**Scope:** Add a structural test that reads the CI workflow YAML and verifies all known proof-carrying Lean files (including Service and IPC) are listed in the PROOF_FILES array.

**Note:** This test may need to be deferred if YAML parsing is not available. Alternative: add as a comment-documented manual check.

**Acceptance:** Test passes or documented as manual check.

#### Phase 5: Documentation sync

##### Task 5.1 — Update docs/ARCHITECTURE.md
Add a section documenting the WS-K-E workstream changes: landing page content refinements, test coverage additions, and any map runtime changes.

##### Task 5.2 — Update docs/TESTING.md
Add service proof-pair and IPC multi-module tests to the testing matrix description.

##### Task 5.3 — Update docs/CODEBASE_MAP.md
Document any changes to how service and IPC modules are handled in the map pipeline.

##### Task 5.4 — Update docs/DEVELOPER_GUIDE.md
Ensure the file ownership table reflects any new test coverage patterns.

##### Task 5.5 — Update README.md
Bump version reference if needed.

##### Task 5.6 — Update CONTRIBUTING.md
Bump version reference if needed.

##### Task 5.7 — Update CLAUDE.md
Bump version reference and update any relevant line counts or file references.

---

### Completion criteria

| Criterion | Verification |
|-----------|-------------|
| All landing page Service/IPC content is accurate | Manual review against upstream code |
| Syscall API table is complete | Cross-reference with upstream API.lean |
| All tests pass with zero warnings | `node scripts/lib/*.test.mjs` |
| Data validation passes | `node scripts/validate-data.mjs` |
| JS syntax checks pass | `node --check assets/js/*.js` |
| Documentation is in sync | All docs reflect workstream changes |
| Version bumped | 0.3.0 → 0.3.1 across all references |
| No tracked sorry warnings | All sorry placeholders resolved |

### Risk mitigations

1. **Upstream API drift:** Service/IPC entry points are verified against the CI workflow's file list and index.html's existing link targets. If upstream renames occur, link breakage will surface during manual verification.
2. **Test fixture accuracy:** Proof-pair test fixtures use module naming conventions matching the upstream `SeLe4n.Kernel.{Service,IPC}.{Operations,Invariant}` pattern established in existing test cases.
3. **Data validation scope creep:** Phase 2 changes are limited to ensuring existing validation covers service/IPC modules. No new schema fields are introduced unless upstream data contracts change.
