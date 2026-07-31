# Briefing the implementer, and landing its work

One implementer per round: a single agent at the strongest model and maximum effort.
The fixes in a round usually interact — one mind holds the batch. Your job splits
into the brief (before) and the gate (after).

## Delivery: always a file, never args

Write the brief to `<scratchpad>/PROJECT-rN-brief.md` and launch a tiny runner
workflow whose agent prompt says only: "Your complete instructions are in FILE —
read it FIRST and execute it fully. Obey RULE ZERO at the top. Your final text must
be the report the brief specifies." Keep the findings JSON beside it and reference
it from the brief; the implementer reads the verified fixes from there.

Why: workflow args have arrived as the literal string `"undefined"` in production.
A file is quoting-proof, survives resume, and lets the implementer re-read. (The
one time delivery failed, the implementer reconstructed the task from the
scratchpad files — file-based artifacts are what made that possible.)

Runner template:

```js
export const meta = {
  name: 'PROJECT-fix-implementer-rN',
  description: 'Implementer applies the round-N fixes from the orchestrator brief file',
  phases: [{ title: 'Implement', detail: 'fixes + regression tests + suite green', model: 'opus' }],
}
phase('Implement')
const report = await agent(
  'You are the round-N implementer for PROJECT. Your complete instructions are in the file BRIEF_PATH — Read that file FIRST and execute it fully. It references the findings JSON at FINDINGS_PATH for the exact verified patches. Obey RULE ZERO at the top of the brief. Your final text must be the report the brief specifies.',
  { label: 'implement:round-N', phase: 'Implement', model: 'opus', effort: 'xhigh' })
return { report }
```

## The brief template

```markdown
# Round N implementation brief — PROJECT

RULE ZERO — READ FIRST: do NOT run `git commit`, `git push`, or any git write
command. Leave the working tree DIRTY. Git belongs to the orchestrator, who reviews
your diff before anything lands. No new files inside REPO except edits to
THE-ALLOWED-FILES; use /tmp for scratch.

You are the implementer for round N of PROJECT at REPO (BRIEF ARCHITECTURE NOTE;
test suite: EXACT COMMAND, currently COUNT passing). The review confirmed K defects
[; two share one root cause, so there are K-1 code fixes]. Full findings JSON with
verified fixes: FINDINGS_PATH — read it first. Line numbers reference commit SHA;
re-locate by anchor text as you apply earlier fixes.

## Orchestrator decisions
[Every merge, conflict resolution, sequencing constraint, and rejected-fix note,
each with its rationale. This section is why the orchestrator exists — never leave
a known conflict for the implementer to discover.]

## FIX 1 (severity, finding i): ONE-LINE STATEMENT OF THE DEFECT
[Two or three sentences of mechanism, then: "Apply confirmed[i].fix exactly" or the
adjusted fix with what changed and why. Include the reviewer's comment text when the
codebase's comment style carries rationale.]

## FIX 2 ...

## REGRESSION TESTS
[One entry per fix: the seed/setup, the action, the exact assertions, and which
existing specs might legitimately need updating (name them — an implementer that
silently "fixes" tests to pass is the failure mode this section prevents). State
the expectation that every new test be proven RED on pre-fix code.]

## ACCEPTANCE
1. Parse/syntax checks pass (state the exact commands).
2. Full suite green: EXACT COMMAND with port-cleanup preamble and a generous
   timeout. COUNT existing + your new tests, ALL passing; diagnose failures from
   the harness's error artifacts until green. [Name any known-flaky spec and the
   rerun-to-classify rule.]
3. `git status` shows ONLY the allowed files modified; NOTHING committed, NOTHING
   pushed.

Final report: each fix with final line numbers, each test added/updated by name,
suite count/status, and any deviation from these instructions with justification.
```

## What good implementers do with slack

Grant deviation room explicitly (the report's "deviations with justification"
line). Field examples of deviations you WANT: catching that two supplied patches
collide (a deferral defeating a focus-probe) and resolving it; noticing a specified
test seed can't reproduce through an existing guard and redesigning the seed;
declining an optional companion fix with a written argument the orchestrator then
accepts and records. The brief sets the letter; the report explains departures;
you judge them at the gate.

## The gate (orchestrator, after the implementer returns)

1. **Read the diff itself** — `git diff` (or `git show` if it self-committed), not
   just the report. Check scope: only the allowed files, no scratch strays.
2. **Independent full-suite run.** The implementer's green is a claim; yours is the
   fact. Run it yourself, serially, after killing any leftover test-server ports.
3. **Land it.** Commit with a message that names the round and summarizes each fix
   in terms of user-visible wrongness (plus the standard footer), then push.
4. **Self-commit handling.** Implementers sometimes commit despite RULE ZERO. If
   the commit exists and is correct in content, message and footer: keep it and
   verify after the fact — rewriting pushed history costs more than the violation.
   Note it, tighten the next brief, retain push rights where possible.
5. **Partial trees.** If the implementer stalled mid-edit: inspect the partial diff
   before resuming (resume re-runs the agent from scratch against the current
   tree); revert broken partials first if they'd confuse it. Never commit a partial
   tree to silence a hook — wait, then gate-commit-push in one turn.
6. Feed the round's fixes into the next review script's CONTEXT and skeptic lens,
   and record any accepted deviation in the trade-offs ledger.
