export interface Mutant {
  file: string; // repo-relative
  startLine: number;
  endLine: number;
  status: 'survived' | 'no_coverage' | 'killed' | 'other';
  mutator: string;
  replacement: string;
}