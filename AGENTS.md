# MeshTask 2 — engineering contract

## Purpose
Clean-room rewrite authorized by Fernando Lima on 2026-11-04. No source copying, legacy migration, or backwards-compatibility requirement. This does NOT authorize removing live plugins/data or executing scripts on production devices.

## Ownership
- docs/PLAN.md: scope, architecture, gates and remaining work.
- Server implementation: new MeshCentral plugin, explicit runtime compatibility, isolated state store.
- Agent implementation: modules_meshcore/meshtask2.js owns the ES5 MeshAgent adapter, separate from Node server; no assumption of Node API compatibility. docs/RUNTIME-CONTRACTS.md and docs/UPSTREAM.md own source-backed API evidence.
- lib/pull-transport.js owns authenticated connection/pull state; lib/dispatcher.js owns durable intent before send and result reconciliation. Keep direct-control-v1 restricted to the documented single-server/TLS trust boundary.
- lib/lifecycle.js and meshtask2.js own single-flight timers, ownership fencing and awaited shutdown/reload. Recheck activity after awaits and before claim/send.
- ui/native.js owns exported browser lifecycle/menu integration; exported functions must survive function.toString without server closures.
- tests/: behavioral tests with isolated storage and mocked transports; external E2E separately documented.

## Local Contracts
- Read applicable AGENTS.md before changing deeper paths. No secrets, user handles, private endpoint identifiers, or real script contents in tracked source/tests/docs.
- No old source copied from MeshTask; only documented requirements and upstream integration contracts may guide new code.
- No commits, pushes, release tags, dependency installs or deployment in this work without explicit authorization.
- Do not run services/stacks in Agent Zero. Local syntax checks and isolated unit tests only; all temporary test storage must be removed.
- Do not promise exactly-once arbitrary shell side effects. Persist dispatch intent before send; deduplicate execution identifiers; after ambiguity, reconcile or mark unknown, never automatic blind re-execution.
- An ACK is not completion; timeout is not cancellation. Late results are retained and reconciled with an immutable audit history.
- Validate authenticated node ownership, domain isolation, protocol version, attempt token and payload sizes. Admin-only operations must fail closed.
- No false success on disconnect, unavailable runtime, process spawn failure or unsupported execution context.
- Each job freezes its script revision and explicit target list. No mutable download-by-arbitrary-script-id to agents.
- Sensitive temporary files must be private at creation; chmod after writing does not eliminate the earlier exposure window. Avoid shell interpolation of untrusted paths.
- Runtime compatibility claims require real tests. Static source checks and Node mocks are not MeshAgent E2E.

## Work Guidance
- Prefer small modules with typed-by-validation protocol contracts and injectable clocks/transports.
- Keep startup side effects out of module imports. Allow server shutdown/interval cleanup.
- New service-context runner may explicitly reject logged-in-user execution until implemented and validated.
- Keep release as 2.0.0-alpha.1 until gates pass; no production-ready labels.

## Verification
Run representative unit tests and syntax checks, record commands/exit codes, document unexecuted real-runtime scenarios and deployment prerequisites.

## Child DOX Index
No child boundaries defined yet.
