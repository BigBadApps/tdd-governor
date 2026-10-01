# Overview: Items 1–3 (October 2026)

Source: the assessment of `docs/concepts/comprehensive_tdd_governor_assessment_and_improvement_roadmap.md`. That document was written without repo access and isn't adopted. These three items are what's actually worth doing.

| Item | What | Plan | Handoff | Branch | Size |
|---|---|---|---|---|---|
| 3 | Governor injects its own vitest reporter. `install` warns when plain runs won't record. | `plans/2026-10-01-item-3-reporter-injection.md` | `handoffs/2026-10-01-item-3-reporter-injection.md` | `feat/reporter-injection` | ~2 h |
| 2 | pytest adapter (base plan from 2026-09-18 plus amendments) | `plans/2026-09-18-stage-4-pytest-adapter.md` + `plans/2026-10-01-item-2-pytest-amendments.md` | `handoffs/2026-10-01-item-2-pytest.md` | `feat/pytest-adapter` | 1–2 days |
| 1 | `red-at-base`: CI re-derives red evidence against the base source (closes G3 in CI) | `plans/2026-10-01-item-1-ci-red-at-base.md` | `handoffs/2026-10-01-item-1-ci-red-at-base.md` | `feat/ci-red-at-base` | ~1 day |

(All paths are under `docs/superpowers/`.)

## Order: 3, then 2, then 1, strictly sequential

- **2 depends on 3:** `runPytest` mirrors 3's injection, and both touch `src/adapters/*/run.ts`.
- **1 depends on 3 and 2:** the base run must always record (3), and it must handle `config.pytest` (2).
- All three edit `src/cli.ts`. Running them in parallel means merge conflicts in the gate wiring.
- This repo's own commit hook and CI gate every change, and the pre-push mutation gate takes minutes. Sequential runs keep that tractable.

## Protocol

1. The user pastes one handoff into a fresh agent session.
2. The agent implements it, opens a PR against `main`, and **does not merge**. It reports in the format below.
3. The user brings the report to the orchestrator session. The orchestrator reviews the PR diff against the plan, runs the gate locally, checks CI, and then merges or returns findings.
4. Only after the merge does the next handoff start.

## Report format (every handoff ends with this)

```
ITEM: <1|2|3>
BRANCH: <name>   PR: <url>   HEAD: <sha>
COMMITS: <sha  subject> (one per task)
GATE: npx tsc --noEmit && npm test && npm run build -> <pass/fail, test count>
CI: <run url, status>
ACCEPTANCE: <each acceptance item from the plan: evidence tag + one line>
DEVIATIONS: <each place real behaviour forced a change from the plan's literal code, and why>
STOPPED-ON: <any stop-and-ask condition hit, with the output>
CLIENT REPOS: <branch + sha, or none>
OPEN QUESTIONS: <or none>
```
