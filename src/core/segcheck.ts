// The bridge to segcheck (github.com/Allan-Nava/segcheck).
//
// The manifest rules in analyze.ts read claims; segcheck downloads the segments and
// reads what the media actually contains. This module owns the two halves that can
// be wrong without anyone noticing — the argv and the JSON contract — so both are
// tested without ever spawning the binary. Spawning is glue, and lives in
// extension.ts.
import { Finding, Severity } from './analyze';

/** Options for one deep check, mirroring the flags segcheck documents. */
export interface SegcheckOptions {
  segments?: number;
  /** Video renditions to inspect; 0 means all, which is the binary's default. */
  renditions?: number;
  from?: 'auto' | 'edge' | 'start';
  insecure?: boolean;
  headers?: Record<string, string>;
}

/** One finding as segcheck reports it. */
export interface SegcheckFinding {
  check: string;
  target: string;
  status: 'OK' | 'WARN' | 'BAD' | 'ERROR';
  message: string;
  hint?: string;
  value?: number;
  unit?: string;
}

/** The JSON document segcheck writes with --output json. */
export interface SegcheckResult {
  source: string;
  worst: string;
  summary: Record<string, number>;
  segments: number;
  bytes: number;
  durationSeconds: number;
  findings: SegcheckFinding[];
}

/**
 * buildSegcheckArgs builds the invocation.
 *
 * Only what the caller asked for is passed: the defaults belong to the binary, and
 * repeating them here would freeze this extension to the version of segcheck that
 * happened to be current.
 */
export function buildSegcheckArgs(manifestUrl: string, options: SegcheckOptions = {}): string[] {
  const args = ['check', manifestUrl, '--output', 'json'];
  if (options.segments !== undefined && options.segments > 0) args.push('--segments', String(options.segments));
  if (options.renditions !== undefined && options.renditions > 0) args.push('--renditions', String(options.renditions));
  if (options.from !== undefined && options.from !== 'auto') args.push('--from', options.from);
  if (options.insecure) args.push('--insecure');
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    args.push('--header', `${name}: ${value}`);
  }
  return args;
}

/** parseSegcheckResult reads the JSON document, or explains what came back instead. */
export function parseSegcheckResult(stdout: string): SegcheckResult {
  const start = stdout.indexOf('{');
  if (start === -1) {
    throw new Error(`segcheck produced no JSON output: ${firstLine(stdout)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.slice(start));
  } catch (err) {
    throw new Error(`segcheck output is not valid JSON (${(err as Error).message}): ${firstLine(stdout)}`);
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.findings)) {
    throw new Error('segcheck output has no findings array: the binary may be too old for this extension');
  }
  return {
    source: typeof obj.source === 'string' ? obj.source : '',
    worst: typeof obj.worst === 'string' ? obj.worst : 'OK',
    summary: (obj.summary as Record<string, number>) ?? {},
    segments: typeof obj.segments === 'number' ? obj.segments : 0,
    bytes: typeof obj.bytes === 'number' ? obj.bytes : 0,
    durationSeconds: typeof obj.duration_seconds === 'number' ? obj.duration_seconds : 0,
    findings: (obj.findings as SegcheckFinding[]).map((f) => ({
      check: String(f.check ?? ''),
      target: String(f.target ?? ''),
      status: (String(f.status ?? 'OK').toUpperCase() as SegcheckFinding['status']) ?? 'OK',
      message: String(f.message ?? ''),
      ...(f.hint ? { hint: String(f.hint) } : {}),
      ...(typeof f.value === 'number' ? { value: f.value } : {}),
      ...(f.unit ? { unit: String(f.unit) } : {}),
    })),
  };
}

/** segcheckSummary is the one-line result, for a notification or the status bar. */
export function segcheckSummary(result: SegcheckResult): string {
  const counts = ['BAD', 'ERROR', 'WARN', 'OK']
    .filter((s) => (result.summary[s] ?? 0) > 0)
    .map((s) => `${result.summary[s]} ${s}`);
  const size = result.bytes > 0 ? `, ${(result.bytes / 1024 / 1024).toFixed(1)} MiB` : '';
  const took = result.durationSeconds > 0 ? ` in ${result.durationSeconds.toFixed(1)}s` : '';
  return `${counts.join(' · ') || 'no findings'} — ${result.segments} segments${size}${took}`;
}

const STATUS_SEVERITY: Record<SegcheckFinding['status'], Severity | null> = {
  OK: null,
  WARN: 'warning',
  BAD: 'error',
  // segcheck's ERROR means it could not measure (a fetch failed, a parse failed).
  // That is not a healthy stream either: it is reported, and the message says why.
  ERROR: 'error',
};

/**
 * segcheckToFindings maps a deep check onto manifest findings.
 *
 * Segment findings have no line to anchor to — the offending bytes are in a
 * segment, not in the playlist — so they anchor at the top of the manifest and
 * carry the target in the message.
 */
export function segcheckToFindings(result: SegcheckResult): Finding[] {
  const out: Finding[] = [];
  for (const f of result.findings) {
    const severity = STATUS_SEVERITY[f.status];
    if (severity === null || severity === undefined) continue;
    const measured = f.value !== undefined ? ` (${f.value}${f.unit ? ' ' + f.unit : ''})` : '';
    out.push({
      rule: `segcheck/${f.check}`,
      severity,
      line: 0,
      message: `${f.target}: ${f.message}${measured}`,
      ...(f.hint ? { hint: f.hint } : {}),
    });
  }
  return out;
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}
