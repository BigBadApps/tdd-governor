# Contributing

Thanks for helping. This project enforces TDD on itself: its own git hooks run the governor, so a
contribution needs a test that was seen failing before it passed.

## Setup

```bash
npm ci
npm run build
node dist/cli.js install   # wires the hooks into your clone
npm test
```

Requires Node 22+.

## Workflow

1. Write the test.
2. Stub the code so the test fails on an assertion (a missing export or a thrown error is not a red).
3. Run the tests and confirm the red.
4. Write the real code and confirm green.
5. Open a pull request against `main`.

`.governor/PRIMER.md` explains what counts as a valid red and what to do when a gate blocks you.
Please do not use `git commit --no-verify` or `GOVERNOR_OVERRIDE`; if a block looks wrong, open an
issue with the governor's output.

## Pull requests

- One change per PR, with the reason in the description.
- CI runs `tsc`, the build, the tests, and `governor gate ci`. All must pass.
- By contributing you agree your work is released under the [MIT license](LICENSE).
