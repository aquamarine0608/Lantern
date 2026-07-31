# The review workflow script

One Workflow script per round, kept in the scratchpad as `<project>-review-r<N>.js`.
Each round: copy the previous round's script, rename, and update three things —
the FILES line (test count, HEAD claim), the CONTEXT (what the last round fixed),
and the lens set. Everything else is stable machinery.

## Template (genericize the ALL-CAPS parts)

```js
export const meta = {
  name: 'PROJECT-review-rN',
  description: 'Adversarial review round N — loop ends when a round confirms zero defects',
  phases: [
    { title: 'Review', detail: 'three reviewer lenses', model: 'opus' },
    { title: 'Verify', detail: 'adversarial verification', model: 'opus' },
  ],
}

const FILES = 'Files: LIST THE REAL PATHS, tests in TESTDIR (COUNT passing). All fixes from rounds 1..N-1 are committed at HEAD. Read everything relevant before reporting. Judge the code exactly as on disk; do NOT report anything already guarded. Do NOT run the shared test suite; use tiny standalone probes on copies if execution is essential.'

const CONTEXT = `ONE-PARAGRAPH PROJECT DESCRIPTION. REVIEW ROUND N. Round N-1 confirmed and fixed: DENSE SUMMARY OF LAST ROUND'S FIXES, mechanism-level, so the skeptic lens can attack them. Rounds 1..N-1 each confirmed real defects; the loop ends when a round confirms ZERO. Hold the bar exactly as high — only concrete, traced, reproducible defects count. Accepted trade-offs (do NOT re-report): GROWING LIST OF SETTLED DESIGN DECISIONS.`

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          line: { type: 'number' },
          file: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          description: { type: 'string' },
          scenario: { type: 'string' },
        },
        required: ['title', 'file', 'description', 'scenario', 'severity'],
      },
    },
  },
  required: ['findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    isReal: { type: 'boolean' },
    reasoning: { type: 'string' },
    suggestedFix: { type: 'string' },
  },
  required: ['isReal', 'reasoning'],
}

const LENSES = [
  { key: 'roundN-1-fixes', prompt: 'SKEPTIC LENS ON LAST ROUND — see lens design below' },
  { key: 'ship-gate-holistic', prompt: 'Lens: ship-gate holistic read, every file top to bottom. N-1 adversarial rounds have passed; you are the gate before this is declared done. Anything concrete that gives a real user a wrong outcome, anywhere — including docs claims that no longer match the code. If you find nothing that meets the bar, return an empty findings list — do not manufacture findings.' },
  { key: 'ROTATING-THIRD-LENS', prompt: 'see lens design below' },
]

phase('Review')
const results = await parallel(LENSES.map(l => () =>
  agent(`${CONTEXT}\n\n${FILES}\n\n${l.prompt}\n\nReport only concrete, reproducible defects with a traced code path — no style nits, no speculation, nothing already guarded, none of the accepted trade-offs. An empty findings list is a valid and welcome result. Include file and approximate line numbers.`,
    { label: `review:${l.key}`, phase: 'Review', schema: FINDINGS_SCHEMA, model: 'opus', effort: 'xhigh' })
))

const all = results.filter(Boolean).flatMap(r => r.findings)
const seen = new Map()
for (const f of all) {
  const k = f.file + '::' + f.title.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).sort().slice(0, 6).join('-')
  if (!seen.has(k)) seen.set(k, f)
}
let deduped = [...seen.values()]
const order = { high: 0, medium: 1, low: 2 }
deduped.sort((a, b) => order[a.severity] - order[b.severity])
const CAP = 8
if (deduped.length > CAP) log(`capping verification at ${CAP} of ${deduped.length} findings`)
const toVerify = deduped.slice(0, CAP)
log(`${all.length} raw findings, ${deduped.length} deduped, verifying ${toVerify.length}`)

phase('Verify')
const verified = await parallel(toVerify.map(f => () =>
  agent(`${CONTEXT}\n\n${FILES}\n\nAdversarially verify this claimed defect against the ACTUAL code on disk. Trace the exact execution path. Default to isReal=false when uncertain or when the code already guards against it. Do NOT run the shared test suite.\n\nClaim: ${f.title}\nFile: ${f.file} (around line ${f.line || '?'})\nSeverity: ${f.severity}\nDescription: ${f.description}\nScenario: ${f.scenario}\n\nIf real, give a concrete minimal fix in suggestedFix.`,
    { label: `verify:${f.title.slice(0, 40)}`, phase: 'Verify', schema: VERDICT_SCHEMA, model: 'opus', effort: 'xhigh' })
    .then(v => ({ ...f, verdict: v }))
))

const confirmed = verified.filter(Boolean).filter(f => f.verdict && f.verdict.isReal)
const rejected = verified.filter(Boolean).filter(f => f.verdict && !f.verdict.isReal)
return {
  confirmedCount: confirmed.length,
  confirmed: confirmed.map(f => ({ title: f.title, severity: f.severity, file: f.file, line: f.line, description: f.description, fix: f.verdict.suggestedFix })),
  rejected: rejected.map(f => ({ title: f.title, why: (f.verdict.reasoning || '').slice(0, 300) })),
  unverified: deduped.slice(CAP).map(f => ({ severity: f.severity, file: f.file, title: f.title })),
}
```

## Lens design

Three lenses per round is the sweet spot — enough diversity to cross-check, few
enough that each gets a real charter.

**The skeptic lens (mandatory, rotates every round).** Reviews the PREVIOUS round's
fixes with named hostility. Don't write "check last round's fixes" — enumerate the
specific mechanisms and hand the reviewer attack angles: state that can go stale,
orderings that can invert, guards whose conditions changed meaning, message text
that can now disagree with behavior. The best skeptic prompts read like a prosecutor's
outline: "trace X (can A happen after B?; enumerate the truth table of C; what does
the user see when D and E race)". Most of a campaign's mid-life findings come from
this lens, because fresh fixes are the newest, least-reviewed code in the repo.

**The ship-gate lens (mandatory, stable).** Whole-surface read with explicit
permission to return empty. That permission is load-bearing: without it, reviewers
manufacture findings to have something to report, and verification burns its cap
refuting them. Empty ship-gates are also your convergence signal.

**The third lens (rotates by campaign phase).** Early: themed domain passes
(error paths, persistence, concurrency, a11y, security sinks). Mid: a
**cross-fix regression hunt** — name the functions many rounds have repeatedly
touched and ask for interactions *between* fixes from different rounds ("the R12
banner dedupe vs the R19 clear-guard: which wins, and is the user ever told
nothing when something WAS held?"). Late: point it at whatever the last rounds'
findings cluster around.

## Mechanics that matter

- **Dedupe before verify.** Lenses overlap; the title-word key above collapses most
  duplicates cheaply. Findings that survive dedupe but share a root cause get merged
  by YOU at orchestration time — the machinery can't see root causes.
- **Cap the verify fan-out** (8 for routine rounds, up to 16 for sweeps),
  severity-first. Findings over the cap are returned as `unverified` — don't drop
  them silently; either roll them into the next round or run a dedicated verify
  pass (against a snapshot if an implementer is concurrently editing).
- **Verifiers default to refuted.** The prompt says so explicitly. This is what
  keeps the implementer from ever patching fiction; in the field it rejected
  plausible-sounding claims nearly every round.
- **Verifiers write the fix.** They just traced the defect on the real code and
  usually validated a patch on a copy — their `suggestedFix` is the highest-quality
  fix text you'll get. The brief passes it through nearly verbatim.

## Syntax gotchas (each cost a broken launch)

- The CONTEXT template literal must contain **no backticks** — reword code
  references instead of quoting them.
- Single-quoted lens prompts must contain **no bare apostrophes** ("setEngine's" →
  "the setEngine"). Escaped `\'` through a tool-input layer can double-escape into
  a literal backslash and break the parse.
- Smoke-test the script before launching: attempt a module parse; the error
  **"Illegal return statement" means the parse SUCCEEDED** (the top-level `return`
  is only legal inside the workflow runner). Any other error is real.
- `Date.now()` / `Math.random()` are unavailable inside workflow scripts (they'd
  break resume). Stamp times outside; vary labels by index.
