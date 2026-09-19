# General Design and Engineering Principles

Portable principles distilled from `AGENTS.md` and
`docs/development/guidelines.md`, suitable for adoption by a new project.

## Fundamental Principles

- Prefer **succinct, clear, elegant, thoughtful, idiomatic** work; think holistically
  rather than in fragments.
- Maximum soundness, minimum complexity.
- Surface material ambiguity and tradeoffs rather than hiding them.
- Avoid repetition, jargon, and over-engineering.

## Work Contract

- For each issue, whenever necessary, create a worktree under `.agents/worktrees` and a PR. If you are orchestrating works across multiple issues, launch a subagent for each worktree and parallelize the work respecting issue dependencies. 
- After each PR work finishes with major changes, automatically launch a subagent to independently and critically review it (do not inherit the parent session context). Ask the subagent to post change requests and comments under this PR, and do not merge until all comments are addressed.
- Find and report root causes before fixing; implement only after approval.
- Pause and ask when material uncertainty, ambiguity, or conflict remains; do not
  silently choose among interpretations.
- Never hide confusion, invent fallback values, or paper over a failure. Honesty,
  integrity, and credibility are the highest principles; working code with flawed
  semantics is still a defect.
- Make the smallest complete change. Preserve unrelated work and remove only
  artifacts introduced by the change.
- Avoid both over-restriction and unsafe optimism: cut needless constraints, favor
  fault tolerance. Question whether a change is necessary and sensible before
  checking its implementation.
- Remove dead code and obsolete interfaces cleanly; add no shims or compatibility
  artifacts unless the current contract requires them.
- Work in small verified slices, report behavior changes plainly, and keep the
  final handoff concise. When a preview is requested, change nothing before approval.

## Design Principles

- **Message/state immutability**: once a record (request, response, event, command)
  is created, its fields must not be mutated. This protects determinism, temporal
  integrity, concurrency safety, and replay.
- **Clear ownership boundaries**: components treat incoming messages as immutable
  input; if they need a different representation, derive new local state explicitly.
- **Zero ambiguity in state**: an event is a factual record of what happened at that
  time; do not rewrite history to reflect current state.
- Prefer **deep modules**: simple interfaces with substantial hidden work; hide
  decisions likely to change.
- Keep unrelated concerns orthogonal; coupling is a liability, cohesion an asset.
- Design the interface before polishing the implementation.
- Make invalid states hard or impossible to represent: parse at the boundary, keep
  validated types inside, use construction-time guarantees over scattered runtime checks.

## Coding Standards

- Annotate types; enforce strictly and incrementally rather than hiding diagnostics.
- Validate configuration and external payloads once at their boundaries; keep
  validation and database work off hot paths.
- Use full, descriptive names for user-facing APIs, variables, metrics, and logs;
  abbreviations leak into dashboards. Abbreviate only internal hot-path fields.
- Never display internal IDs in a user interface; use descriptive alternatives.
- Leave a blank line above comment blocks; comments explain why, not what.
- Resolve `TODO`/`FIXME`/`HACK` markers in the current change or convert them into
  tracked issues.

## Error Handling & Concurrency

- No bare catch-all handlers; handle specific error types.
- External calls need explicit timeouts. Retry only operations proven idempotent or
  safely reconcilable, with a limit and observability; never blindly retry an
  ambiguous side effect.
- Ensure clean cancellation of async work: guaranteed cleanup on every exit path, and
  shielding for work that must complete. Never block the shared event loop with
  synchronous I/O.
- Keep callback bodies short since they run on the event loop.
- Fail loudly on impossible states; do not let errors pass silently.

## Testing

- Write tests that actually bite: test observable behavior and contracts, not
  implementation trivia or values true only today. A regression test must exercise a
  meaningful behavior boundary, fail when broken, and remain valid as configuration
  changes.
- Use descriptive test names stating the scenario and expected outcome; small
  standalone cases, shared setup through fixtures, table-driven input coverage.
- Mock external dependencies with hand-written stubs or the standard mocking
  facility.
- Avoid arbitrary fixed delays; poll with an eventual-condition helper.
- Use property-based tests for core domain/mathematical logic and fuzzing at
  network/parser boundaries.
- Treat warnings as design feedback, not console noise.

## Reliability, Money, and Operations

- Treat balances, positions, orders, and fills as audited facts; reconcile ambiguous
  effects; design for idempotent restart and replay.
- Prefer reconciliation over assumption; never infer financial state from UI state.
- External/venue state is the source of truth: read and persist the actual schedule
  rather than pinning a documentation snapshot; do not reimplement venue logic.
- Every retry needs a timeout, a limit, and observability.
- Never turn survivable degradation into unrecoverable loss, and never stop a
  recorder merely because the primary path fails; minimize downtime on unrecoverable
  data paths.
- High-value defect classes: weakened invariants; blocking calls or event-loop stalls
  in async services; hot-path impurity; silent alert loss; recovery that assumes a
  clean shutdown.
- Before interpreting observed behavior, verify the exact deployed revision and
  effective config.
- Keep secrets out of logs; put temporary artifacts in a scratch area and remove them.

## Commits and Pull Requests

- Commit subjects use `type(scope): imperative summary` (72 chars max); one coherent
  change per commit.
- PR titles summarize the complete diff, not its last commit; put issue closure in the
  body.
- PR bodies are concise but complete: summary, root cause, behavior/impact, validation,
  then closure reference; state limitations and skipped checks explicitly.
- Require a review before merge; address all comments and change requests.

## Workflow & State Management

- **Single source of truth.** One store is authoritative; every other artifact is a
  projection or disposable cache derived from it, never a second store. Derivable
  state can only drift, so derive, don't declare.
- **Reconcile, don't rely on events.** Automated behavior must survive a missed
  event: run a reconciler that converges derived state from the source of truth on
  every run. Do not depend on event-driven automations outside your control.
- **Fail loud on policy, fail soft on generated state.** Reject invalid operations;
  swallow failures only on disposable, regenerated artifacts that must not block the
  primary action.
- **Generated content never merges by hand.** Resolve conflicts inside generated
  blocks by re-running the generator, not by hand-editing.
- **Atomic local mutex over remote signal.** When multiple actors share one identity,
  arbitrate claims with an atomic local operation (e.g. branch creation); the remote
  signal mirrors the claim, it is never the lock.
- **One item = one branch = one change.** Keep the mapping simple and one-to-one.
- **Prove landing by content, not SHA.** Under rebase-based merges a merged branch
  appears outstanding to every SHA-based view; verify by patch/content identity.
- **Machine output is structured.** Any tool output consumed by scripts or agents
  uses a structured format (`--json`/`--jq`); human-readable tables truncate and are
  not parse-stable.
- **One interface per external system.** Use a single CLI/interface rather than
  overlapping tools and scattered stored credentials.
- **Atomic replacement for caches.** Replace disposable caches atomically so an
  interrupted write preserves the prior state.
- **Completeness over fixed request counts.** Paginate routinely; bounded nested
  reads fail loud at their explicit caps.
- **Hygiene after merge.** Delete merged branches and stale artifacts; retain
  anything ambiguous with a reason rather than guessing.

## Simplification Method

Follow in order:

1. **Question** every requirement from first principles.
2. **Remove** unnecessary parts aggressively; every retained element must have a clear owner.
3. **Simplify** and optimize the remaining core processes (KISS) holistically.
4. **Accelerate** decision, execution, testing, and feedback cycles; enable continuous
   iteration and parallel work.
5. **Automate** only after simplification and standardization.

Never optimize or automate what should not exist or what is premature.

## Reference Aphorisms

### Control complexity first
- Treat complexity as the enemy, not evidence of sophistication.
- Prefer designs simple enough to reason about locally.
- Make the common path obvious and the uncommon path explicit.

### Make code readable to humans
- Readability is a correctness feature; prefer boring, idiomatic code.
- Make control flow visible; use comments to explain why, not what.

### Naming and language style
- Make names reveal intent; if two names differ, their meanings must differ.
- Avoid noise words and names that force mental translation.
- Follow local naming convention unless changing it improves consistency.

### Preserve behavior while changing design
- Refactoring improves structure without changing observable behavior.
- Move in small, reversible steps; leave code healthier than you found it.
- Use duplication as a warning light, not an automatic abstraction trigger; follow the
  Rule of Three before extracting a shared abstraction.

### Design modules around change
- Hide decisions likely to change; a module boundary is a promise.
- Prefer deep modules: simple interface, substantial hidden work.

### Simplicity and incremental design
- Build the simplest thing that satisfies the known requirement (YAGNI).
- Start with a working simple system; evolve complexity only from demonstrated need.
- Prototype to learn; do not confuse a learning artifact with production design.

### Compose small things well
- Do one thing well; design components to work together; prefer simple, inspectable
  interchange formats at boundaries.

### Make invalid states hard or impossible
- Prefer construction-time guarantees over scattered runtime hope.
- Parse at the boundary; keep validated types inside; do not let errors pass silently.

### Test, verify, and inspect
- Tests show the presence of bugs, not their absence.
- Every bug fix should teach the test suite something.
- Static analysis is not optional when the language makes whole classes of bugs easy.
- Review the diff as a change to system health, not just a patch that works.

### Manage dependencies deliberately
- Depend on stable abstractions, not volatile details.
- Prefer small, role-specific interfaces to fat interfaces.
- Use SOLID as diagnostic vocabulary, not dogma.

### Build operationally boring systems
- Prefer boring recovery paths over heroic debugging.
- Idempotency is a feature, not an implementation detail.
- Make failure modes explicit before optimizing success paths.
- Design shutdown, restart, and replay as normal paths.

### Protect money, state, and external side effects
- Treat balances, positions, and orders as audited facts.
- Never infer financial state from UI state; prefer reconciliation over assumption.
- Duplicate prevention matters more than elegant dispatch.

### Be conservative at boundaries, strict about security
- Emit strict, well-specified outputs; normalize external input once at the edge.
- Fail loudly on impossible states; document boundary contracts carefully.

### Keep duplication and knowledge drift under control
- DRY means one authoritative representation of knowledge; do not confuse repeated
  text with repeated knowledge.
- When two things change for different reasons, keep them separate.

### Work like a careful coding agent
- Before editing, understand the existing design pressure.
- Prefer patches that are easy to review; do not guess when ambiguity has high cost.
- Run the checks the project already trusts; respect local style over imported taste.
- When changing behavior, say so. When preserving behavior, prove it.
