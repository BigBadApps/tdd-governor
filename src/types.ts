export type FailureKind = 'assertion' | 'collection_error' | 'runtime_error' | 'timeout' | 'unknown';

export interface TestResult {
  id: string;
  file: string;
  line?: number;
  status: 'pass' | 'fail' | 'skip';
  failureKind?: FailureKind;
  message?: string;
}

export interface CollectionError {
  file: string;
  message: string;
}

export interface LedgerRecord {
  v: 1;
  runId: string;
  at: string;
  head: string;
  adapter: 'vitest' | 'pytest';
  exitCode: number;
  collectionErrors: CollectionError[];
  tests: TestResult[];
  override?: { gate: string; reason: string };
}

export type GateStatus = 'PASS' | 'BLOCK' | 'UNDECIDED' | 'GATE_UNAVAILABLE';

export type GateName = 'red-before-green' | 'red-at-base' | 'diff-audit' | 'green' | 'mutation';

export interface Finding {
  file: string;
  line?: number;
  message: string;
}

export interface GateResult {
  gate: GateName;
  status: GateStatus;
  findings: Finding[];
}

// Outcome of asking an adapter to run the suite. Gates consume this; adapters produce it.
export type RunOutcome = { kind: 'completed'; record: LedgerRecord } | { kind: 'unavailable'; reason: string };
