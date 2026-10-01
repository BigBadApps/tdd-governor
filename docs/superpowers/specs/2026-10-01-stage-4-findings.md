# Stage 4 Findings — Pytest and Mutmut Adapters

| Criterion | Result | Verified by |
|---|---|---|
| Plugin output satisfies the TS ledger schema | Pass | test: `test/pytest-plugin.integration.test.ts` asserts `corrupt === 0` and validates against `LedgerRecord` schema (`1136032`) |
| Classification (assertion, runtime_error, timeout, skip, collection) | Pass | test: `test/pytest-plugin.integration.test.ts` verifies structured classification from exception types without parsing prose (`1136032`) |
| Plugin paths are rootdir-relative and map to repo paths via packageRoot | Pass | test + live-observed: `test/pytest-plugin.integration.test.ts` expects rootdir-relative paths; BigBadPhotos commit `06ec26e` records paths matching git diff |
| Guarded conftest import is a no-op without plugin | Pass | live-observed: running plain pytest in a venv without `tdd-governor-pytest` succeeds without warnings or errors |
| mutmut output format as observed, plus parser adjustments | Pass | live-observed: `mutmut show` produces unified diff with `# <name>: <status>` and `@@ -N,L @@`; added synthetic git header in `parseMutmut`; raised `maxBuffer` to 50MB for large repos; glob pattern strips `src.` prefix |
| Function offset resolution for mutmut 3.x | Pass | test + live-observed: `mutmut show` produces function-relative diff lines; `getFunctionOffsets` parses Python AST function start lines and shifts diff lines to exact file lines (`backend/scoring.py:229-230`) |
| macOS fork safety for mutmut runners | Pass | live-observed: forked mutmut processes crash with SIGSEGV/SIGABRT when OpenCV/CoreFoundation are imported; setting `OBJC_DISABLE_INITIALIZE_FORK_SAFETY=YES` and `OPENCV_OPENCL_DEVICE=disabled` resolves crashes |
| Survivor on changed line blocks in client repo | Pass | live-observed: BigBadPhotos probe on `backend/scoring.py`, `[BLOCK] mutation` naming line 229 (`if mean == 1000.0:`) and line 230 (`exposure_score = None`, `exposure_score = 1.5`) |
| Commit and push wall times in BigBadPhotos | Pass | live-observed: baseline test run (288 tests) took 1.2s; mutmut run on `backend.scoring*` took ~45s; full `gate ci` completed with mutation block |
| Injected plugin + conftest import give one record per run | Pass | test: `test/run-pytest.test.ts` ("writes exactly one record when the project also registers the plugin in conftest") (`319fd26`) |
| This repo's CI ran pytest and mutmut integration tests | Pass | live-observed: GitHub Actions run `36896435173` on PR #14 executed `pytest-plugin`, `run-pytest`, and `mutmut` integration tests successfully |
| Hooks deliberately not installed in BigBadPhotos | Deferred | deferred: user decision; hooks in shared git dir would gate unrelated branches (`bbaf/bigbadphotos-ingest-killswitch`) |
| CI template Node-only (`templates/governor-ci.yml`) | Deferred | deferred: template provisions Node only; python clients need manual CI workflow provisioning |
| Primer wording vitest-flavoured (`.governor/PRIMER.md`) | Deferred | deferred: primer mentions vitest specifics; needs pytest examples |

Environment for live-observed rows: Python 3.14.7, pytest 9.1.1, mutmut 3.8.0, darwin-arm64, Node v22.22.3.

## Surprises / deviations from plan

1. **mutmut `show` function-relative line numbers (Task 4 Decision Point):**
   - In `clamp.py`, the function was at line 1, so function-relative matched file-relative lines.
   - In real codebases (e.g. `backend/scoring.py` where `score_exposure` is at line 210), `mutmut show` diffs start at `@@ -1, ... @@` relative to the function AST node (`cst.Module([function])` in `mutmut.mutation.diff_apply`).
   - Implemented `getFunctionOffsets()` using Python's `ast` module to map function names to 1-indexed file start lines and shifted diff lines in `parseMutmut`.
2. **Node `spawnSync` default 1MB maxBuffer exceeded by `mutmut results`:**
   - In a repo with ~19,000 mutants (BigBadPhotos), `mutmut results --all true` produces ~1.56 MB of output. Node's `spawnSync` default `maxBuffer` of 1MB failed with `ENOBUFS`.
   - Increased `maxBuffer` to 50MB in `runMutmut`.
3. **Leftover `mutants/` directory breaking pytest collection:**
   - `mutmut run` copies test directories into `mutants/tests/`. Subsequent pytest runs discovered `mutants/` and failed with `ImportPathMismatchError`.
   - Added `finally { rmSync(path.join(root, 'mutants'), { recursive: true, force: true }); }` to `runMutmut` and added `--ignore=mutants` to `runPytest`.
4. **macOS fork crashes with OpenCV / CoreFoundation:**
   - Calling `os.fork()` when native libraries (OpenCV, Objective-C CoreFoundation) are loaded causes macOS aborts (`performForkChildInitialize` / Metal OpenCL crashes).
   - Resolved by setting `OBJC_DISABLE_INITIALIZE_FORK_SAFETY=YES` and `OPENCV_OPENCL_DEVICE=disabled` in the child runner environment.
5. **CLI flags for collection error continuation:**
   - Removed `continue_on_collection_errors` hook from the pytest plugin per user request; passed `--continue-on-collection-errors` via CLI flags in `runPytest` and integration tests.

## Deferred

- Hooks installation in BigBadPhotos: `governor install` was not run in BigBadPhotos to protect in-progress branches (`bbaf/bigbadphotos-ingest-killswitch`).
- Python support in `templates/governor-ci.yml`.
- Pytest-specific examples in `.governor/PRIMER.md`.

## Carried forward

- Known gaps G1–G8 unchanged (spec §9).
