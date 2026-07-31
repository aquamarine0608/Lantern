# The wide sweep (endgame or breadth pass)

The round loop drills deep along whatever vein the lenses are on. The sweep is the
opposite move: many cheap finders, each owning ONE narrow domain, all blind to each
other — followed by the same expensive adversarial verification as a normal round.
Fresh diverse eyes find what focused depth walked past: in the field, a 24-finder
sweep after 32 deep rounds surfaced two new HIGH defects (an app-wide focus hazard
on the most-travelled code path; an unguarded database delete) plus a long tail the
rounds never looked at (WCAG contrast, RTL, zip-bomb caps, doc honesty).

Use it as the **endgame** ("fix what the sweep confirms, then done") or as a
mid-campaign breadth pass when round findings have gone narrow.

## Shape

1. **Finders:** ~20–24 agents, cheap-but-capable model, default effort. One domain
   each. Domains that earned their place: file-format parsing, text
   segmentation, playback/scheduling, navigation, persistence, each engine/backend,
   the settings state machine, error surfaces/messaging, focus & keyboard, modals,
   service worker/offline, platform quirks, OS media integration, the database
   layer, CSS/layout at several widths, security (every innerHTML/URL sink vs
   user-controlled data), memory/perf (leaks, unbounded growth, spinning loops),
   docs-vs-code honesty, **the test suite itself** (assertions that cannot fail,
   mocks diverging from reality — this domain alone justified harness upgrades),
   unicode/i18n, and cross-feature interactions.
2. **Same contract as round reviewers:** the accepted-trade-offs ledger, "empty
   findings list is welcome", concrete traced defects only, no shared-suite runs.
3. **Dedupe + severity sort + CAP** (raise to ~16 for a sweep), then strong-model
   max-effort verifiers, default-refute, fixes included.
4. **The over-cap tail is not garbage.** A good sweep over-produces (35 raw / 12
   verified / 19 over-cap in the field — and a follow-up verify pass confirmed 15
   of those 19). Run a second verification workflow over the tail: one verifier per
   finding, each told the array index to verify. Extract the full finding objects
   from the sweep workflow's journal if the return value only carried titles.
5. **Snapshot rule.** If an implementer is fixing batch 1 while the tail verifies,
   the verifiers must judge a **frozen copy** of the tree at the commit the findings
   were made against — copy the source files to a snapshot dir and point verifier
   prompts there, with an explicit "do not read the live repo, it is being modified
   concurrently".
6. **Fix batches** flow through the normal implementer brief + gate. Batch 2's brief
   must tell the implementer that line numbers reference the pre-batch-1 snapshot
   and to re-locate by anchor text, and to skip anything batch 1 already resolved.

## Verify-the-tail template sketch

```js
// one verifier per index into the saved unverified-findings JSON
const verdicts = await parallel(INDICES.map(i => () =>
  agent(`${CONTEXT}\n\nRead ${JSONPATH} and take the finding at ARRAY INDEX ${i}. ` +
        `Adversarially verify that ONE claim against the SNAPSHOT at ${SNAP}/ — ` +
        `do NOT read the live repo (it is being modified concurrently); the snapshot ` +
        `is the exact state the finding was made against. Default to isReal=false. ` +
        `If real, give a minimal fix against repo-relative paths. Return index=${i}.`,
    { label: `verify19:${i}`, phase: 'Verify', schema: VERDICT_SCHEMA, model: 'opus', effort: 'xhigh' })
))
```

## After the sweep

Fix confirmed batch(es), gate, land — then stop, per the endgame agreement. Close
with the docs pass and the campaign summary. Resist queuing "one more round" off
sweep energy: the sweep is the agreed finish line, and honoring the stop criterion
is part of what makes the loop schedulable at all.
