import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { git } from './git.js';
import { PRIMER } from './primer.js';

const MARKER = '# tdd-governor';

// Ours only when the marker is the line the generator writes, right under the shebang. A substring
// test once matched a hand-written hook whose comment merely described the governor, and install
// rewrote the file — taking a main-branch guard and a git-lfs delegate with it.
const isOurs = (content: string) => content.split('\n')[1]?.trim() === MARKER;
export const PRIMER_FILE = '.governor/PRIMER.md';
// One pointer per repository, in the shared git directory: every worktree reads it, and git never tracks it.
export const CLI_PATH_FILE = 'tdd-governor-cli-path';

// The hook file may be tracked (core.hooksPath), so it must hold no machine-specific path: it reads one
// written by install. A clone without the governor gets a notice, not a block — CI still runs `gate ci`.
// The one place the cli is resolved: $GOVERNOR_CLI, else the pointer install writes in the common git dir.
const RESOLVE_CLI = `governor_cli="\${GOVERNOR_CLI:-$(cat "$(git rev-parse --path-format=absolute --git-common-dir)/${CLI_PATH_FILE}" 2>/dev/null)}"`;

const hookScript = (command: string) => `#!/bin/sh
${MARKER}
${RESOLVE_CLI}
if [ ! -f "$governor_cli" ]; then
  echo "governor: not installed on this machine, skipping ${command} (run: governor install)" >&2
  exit 0
fi
exec node "$governor_cli" ${command}
`;

// Advice for a hook we may not touch: the same resolution, as lines to paste into a hand-written hook.
// `if` rather than `&&` so that pasting it last still exits 0 where the governor is not installed.
const hookSnippet = (command: string) =>
  `${RESOLVE_CLI}\nif [ -f "$governor_cli" ]; then node "$governor_cli" ${command} || exit 1; fi`;

export function installHooks(
  root: string,
  cliPath: string,
  hooks: Array<{ name: string; command: string }>,
  packageRel = '.',
): { ok: boolean; messages: string[] } {
  const messages: string[] = [];
  let ok = true;
  const hooksDir = path.resolve(root, git(root, ['rev-parse', '--git-path', 'hooks']).trim());
  mkdirSync(hooksDir, { recursive: true });

  for (const { name, command } of hooks) {
    const file = path.join(hooksDir, name);
    if (existsSync(file) && !isOurs(readFileSync(file, 'utf8'))) {
      ok = false;
      messages.push(`refusing to overwrite existing ${name} hook at ${file}; add these lines to it yourself:\n${hookSnippet(command)}`);
      continue;
    }
    writeFileSync(file, hookScript(command));
    chmodSync(file, 0o755);
    messages.push(`installed ${name} → governor ${command}`);
  }

  const pointer = path.resolve(root, git(root, ['rev-parse', '--git-common-dir']).trim(), CLI_PATH_FILE);
  writeFileSync(pointer, `${cliPath}\n`);
  messages.push(`wrote ${CLI_PATH_FILE} in the git directory: this machine's governor, shared by every worktree and kept out of the tracked hook`);

  const primer = path.join(root, PRIMER_FILE);
  mkdirSync(path.dirname(primer), { recursive: true });
  writeFileSync(primer, PRIMER);
  messages.push(`wrote ${PRIMER_FILE}: point your agents at it (for example from AGENTS.md or CLAUDE.md)`);

  const gitignore = path.join(root, '.gitignore');
  const entries = ['.governor/ledger.jsonl', ...(packageRel === '.' ? [] : [`${packageRel}/.governor/ledger.jsonl`])];
  for (const entry of entries) {
    const current = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
    if (current.split('\n').includes(entry)) continue;
    writeFileSync(gitignore, `${current}${current === '' || current.endsWith('\n') ? '' : '\n'}${entry}\n`);
    messages.push(`added ${entry} to .gitignore`);
  }
  return { ok, messages };
}
