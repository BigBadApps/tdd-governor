import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { LedgerRecord } from './types.js';

const FailureKindSchema = z.enum(['assertion', 'collection_error', 'runtime_error', 'timeout', 'unknown']);

export const LedgerRecordSchema = z.object({
  v: z.literal(1),
  runId: z.string().min(1),
  at: z.string(),
  head: z.string(),
  adapter: z.enum(['vitest', 'pytest']),
  exitCode: z.number().int(),
  collectionErrors: z.array(z.object({ file: z.string(), message: z.string() })),
  tests: z.array(
    z.object({
      id: z.string(),
      file: z.string(),
      line: z.number().int().optional(),
      status: z.enum(['pass', 'fail', 'skip']),
      failureKind: FailureKindSchema.optional(),
      message: z.string().optional(),
    }),
  ),
  override: z.object({ gate: z.string(), reason: z.string().min(1) }).optional(),
});

export function ledgerPath(root: string): string {
  return process.env.GOVERNOR_LEDGER_PATH ?? path.join(root, '.governor', 'ledger.jsonl');
}

export function appendRecord(file: string, record: LedgerRecord): void {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(record) + '\n');
}

// Corrupt lines are skipped, never guessed at: dropping evidence can only cause a BLOCK, never a false PASS.
export function readLedger(file: string): { records: LedgerRecord[]; corrupt: number } {
  if (!existsSync(file)) return { records: [], corrupt: 0 };
  const records: LedgerRecord[] = [];
  let corrupt = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = LedgerRecordSchema.safeParse(JSON.parse(line));
      if (parsed.success) records.push(parsed.data);
      else corrupt++;
    } catch {
      corrupt++;
    }
  }
  return { records, corrupt };
}
