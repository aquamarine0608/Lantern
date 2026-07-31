---
name: hardening-loop
description: >
  Run an orchestrated multi-agent adversarial review→fix loop ("the Opus loop") that
  repeatedly hunts for real defects in a codebase, adversarially verifies every claim,
  fixes what survives, regression-tests each fix, and commits round after round until
  the code converges on zero confirmed defects (or a stop criterion the user picks).
  Use this whenever the user wants code hardened, polished, audited, or driven to
  "perfect" by agents — phrases like "review and fix in a loop", "have opus/sonnet
  agents review it", "find and fix everything", "keep going until there are no bugs",
  "adversarial review", "final sweep", "make it bulletproof before shipping", or any
  request for a large multi-agent QA campaign — even if they never say the word "loop".
  Also use it for one-shot variants: a single adversarial review round, or a wide
  many-agent sweep with verification.
---

# The hardening loop

An orchestrated campaign that turns "review my code" into a convergent process:
strong reviewer agents hunt with focused lenses, adversarial verifiers kill the
false positives, one strong implementer applies the surviving fixes with regression
tests, and you — the orchestrator — gate everything through an independent test run
before it lands. Repeat until a round confirms nothing.

Field results that shaped this skill: a 32-round campaign plus a 24-agent sweep on a
~3k-line app confirmed and fixed ~194 real defects, with the false-positive rate held
near zero by the verification stage. Every rule below exists because its absence cost
a round.

## Before you start

Three things must be true, and three questions must be answered — ask the user only
for what you genuinely can't decide yourself:

1. **A machine-checkable gate exists.** A test suite the implementer can run to green
   and you can re-run independently. No gate → build one first (that's a different
   task; do it before looping). Record the exact command and its quirks (ports,
   cwd, parallelism limits) — you will paste them into every brief.
2. **Git is available and you own it.** Every round ends in a commit + push. Work on
   a feature branch unless told otherwise.
3. **Multi-agent execution is authorized** (ultracode on, or the user asked for the
   loop in their own words — this skill being invoked by the user counts).

Questions worth one exchange with the user, with defaults if they've clearly
delegated: **stop criterion** (default: a round confirms ZERO defects with zero agent
errors; cheaper alternatives: zero high/medium only, or N rounds then a final sweep),
**casting** (default: strongest model at max effort for review/verify/implement;
a wide sweep uses many cheap finders + strong verifiers), and **cadence** (rounds run
unattended by default, reporting only round summaries).

## One round, seven steps

**1 — Review.** Launch a Workflow: 3 reviewer lenses in parallel (strongest model,
max effort), each returning structured findings. Lens design is the steering wheel
of the whole loop — see `references/review-workflow.md` for the template and lens
rotation rules. The non-negotiable lens: a **skeptic on the previous round's fixes**.
Fresh fixes are where new defects live; this lens caught follow-on bugs in the
majority of rounds.

**2 — Verify.** Dedupe the raw findings (key: file + sorted first-6 title words),
sort severity-first, cap the verification fan-out (8–16), then one adversarial
verifier per finding — instructed to REFUTE, defaulting to not-real when uncertain,
judging the code exactly as on disk. Only confirmed findings proceed. Verifiers also
produce the fix, tested on a patched copy — so fixes arrive pre-verified.

**3 — Orchestrate.** You read every confirmed finding *before* delegating. Your
irreplaceable jobs: merge findings that share a root cause; **resolve conflicts
between verified fixes** (two verifiers can propose incompatible fixes for one
defect — pick one, with a written rationale, or the implementer inherits a
contradiction); decide sequencing when fixes touch the same code; and reject a fix
whose remedy is worse than the defect (it happens — say so and carry the rationale
into the next round's review context).

**4 — Brief.** Write the implementation brief to a FILE and point the implementer
at it. Never pass the brief through workflow args — args have arrived as the literal
string "undefined" in the field, and a file survives anything. Template and rules in
`references/implementer.md`. RULE ZERO (no git writes) goes at the very top; it gets
violated when buried.

**5 — Implement.** One agent, strongest model, max effort. It applies the fixes,
writes regression tests, proves each test RED on pre-fix code, runs the full suite
to green, and leaves the tree dirty. One implementer, not several — the fixes
usually interact, and a single mind holds the whole batch.

**6 — Gate.** You verify independently: read the actual `git diff` (not just the
report), check for stray files, re-run the entire suite yourself. The implementer's
"all green" is a claim; your run is the fact. Then commit with a message that
records what round found what, and push.

**7 — Advance.** Update the loop ledger (below), regenerate the next round's review
script, launch it, and arm the resilience machinery. Report the round to the user in
one short paragraph unless they asked for silence.

## Casting

- **Reviewers / verifiers / implementer:** strongest available model at maximum
  reasoning effort. Verification quality is the loop's immune system — never
  economize there. A weak verifier lets plausible-but-wrong findings through, and
  you will implement fiction.
- **Wide sweeps:** many cheap finders (one narrow domain each — parsing, a11y,
  security sinks, docs honesty, the test suite itself...), strong verifiers behind
  them. Diverse cheap eyes find; expensive skeptics confirm. See
  `references/final-sweep.md`.
- **You (orchestrator):** never write the fixes yourself when the loop is cast this
  way — your leverage is judgment (conflict resolution, gating, steering), and your
  context must stay clean to audit the implementer honestly.

## The ledger (context between rounds)

Each round's review script carries forward, verbatim and updated every round:

- **What the last round fixed** — one dense paragraph. The skeptic lens reviews
  exactly this.
- **Accepted trade-offs** — every deliberate design decision reviewers must not
  re-report. This list only grows. Without it, rounds re-litigate settled choices
  and verification wastes its cap on non-defects.
- **Current test count and HEAD state** — keeps reviewers honest about what's
  already guarded.
- **Steering notes** — when a defect *class* is mined out (e.g. three straight
  rounds of focus-management fixes), say so explicitly: "assume this class is
  well-guarded; hunt elsewhere unless a concrete new gap is traceable." Reviewers
  otherwise keep drilling the same vein. When you rejected a fix on purpose,
  record why, or the next round re-reports it.

## Convergence and stopping

Expect a plateau, not a smooth descent: counts drop, then hover at 3–5 per round as
reviewers exhaust one defect class and open another. The signals that matter:
severity collapsing (highs disappear first), lenses returning empty, and findings
clustering in code the loop itself recently touched (the loop polishing its own
patches — normal, and it converges).

- A round of **zero confirmed only counts if zero agents errored**. API overload
  (529s) produces empty results that look like victory. Check the failure count
  before declaring done; on overload, back off tens of minutes and retry the same
  round via resume.
- If the plateau drags, offer the user the levers: relax to "no high/medium", or
  schedule the **endgame sweep** — a wide many-finder pass + verification + one
  final fix batch, then done regardless (`references/final-sweep.md`).
- After the stop: a final docs pass (verify every README claim against the code as
  it now exists), commit, push, and a campaign summary (rounds, defects by theme,
  final test count, how to use the thing).

## Staying alive (long campaigns)

Rounds run for hours in the background; the environment will not always cooperate.

- **Self check-ins.** Before ending any turn with work in flight, schedule a wakeup
  (~45–55 min) whose message contains *everything needed to resume from amnesia*:
  run IDs, script paths, the resume command, the current HEAD/test-count, the next
  steps, and the zero-only-counts-if-no-errors rule. Assume the process reading it
  has lost all other context. Delete or update superseded check-ins so a stale one
  can't mislead.
- **Stalls.** A workflow with no transcript writes for 20+ minutes and an empty
  output died (container reclaim). Resume with the same script + run ID — completed
  agents replay from cache. For a stalled *implementer*, inspect `git status`/`diff`
  for partial edits before resuming: the resumed agent re-runs from scratch against
  whatever tree it finds.
- **Never commit a partial tree.** If a commit-nagging hook fires mid-implementer,
  wait for the implementer, then gate-verify-commit-push in the same turn.
- **Implementers self-commit.** Even with RULE ZERO on top, expect it sometimes.
  If the commit already exists: verify its contents, message and footer instead of
  double-committing; keep pushing rights yourself when you can.

## Field-tested pitfalls

1. Workflow script template-literals must contain **no backticks**; single-quoted
   lens prompts must contain **no bare apostrophes**. A module-parse smoke test that
   fails with "Illegal return statement" is a PASS (top-level return is legal only
   inside the runner).
2. Never let review/verify agents run the shared test suite — port and fixture
   collisions poison both sides. They probe on copies; only the implementer and you
   run the real suite, serially.
3. Regression tests must be proven RED on pre-fix code, or they're decoration.
   Watch for assertions that can't fail (e.g. text matchers that pass against
   hidden elements — pair them with visibility checks).
4. When verifying over-cap findings *while* an implementer edits, verify against a
   frozen **snapshot** of the tree the findings were made from, never the live repo.
5. Findings counts lie across lenses: three lenses reporting one root cause is one
   defect. Merge before briefing, or the implementer double-patches.
6. Keep per-round artifacts (findings JSON, briefs, scripts) in a scratchpad, named
   by round — they are the audit trail and the resume state. Never let agent scratch
   files land in the repo; check `git status` for strays before every commit.

## References

| File | Read when |
|---|---|
| `references/review-workflow.md` | Writing or rotating a round's review script |
| `references/implementer.md` | Briefing the implementer; landing its output |
| `references/final-sweep.md` | Running the wide endgame sweep or any breadth pass |
