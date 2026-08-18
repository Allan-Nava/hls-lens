// Checking manifests nobody has opened.
//
// The diagnostics in the editor only exist for a document that is loaded, which is
// the one manifest someone is already looking at. A packager's output directory, or
// a repository of manifest templates, is the case where the defect is in the file
// nobody thought to open — and the extension activates on `workspaceContains` for
// exactly that workspace, then does nothing with it until a file is clicked.
//
// Reading the files is the glue's job. This module decides what counts as a
// manifest, ranks what came back, and renders the report — all pure, so the ordering
// and the arithmetic are tested rather than eyeballed in an output channel.
import { Finding, Severity } from './analyze';

/** One manifest that was read and analysed. */
export interface WorkspaceEntry {
  /** Path as it should be shown: relative to the workspace root. */
  path: string;
  findings: Finding[];
}

/** How many findings of each severity, over everything that was checked. */
export interface WorkspaceCounts {
  errors: number;
  warnings: number;
  hints: number;
}

/** What a scan found. */
export interface WorkspaceSummary {
  /** Manifests checked. */
  files: number;
  /** Manifests with nothing to report. */
  clean: number;
  counts: WorkspaceCounts;
  /** The manifests with findings, worst first. */
  ranked: WorkspaceEntry[];
}

/** Options for one report. */
export interface ReportOptions {
  /** How many manifests to list before saying how many were left out. */
  limit?: number;
}

/** Manifests listed in a report before it stops and says how many are left. */
const DEFAULT_LIMIT = 20;

/** The extensions the extension itself claims in package.json. */
const MANIFEST_EXTENSIONS = ['.m3u8', '.m3u', '.mpd'];

/** isManifestPath reports whether a path is one this extension reads. */
export function isManifestPath(path: string): boolean {
  const lower = path.toLowerCase();
  return MANIFEST_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * summariseWorkspace counts what was found and ranks the files by how bad they are:
 * errors first, then warnings, then hints, then the path — so two files with the
 * same shape always come back in the same order and a report can be diffed against
 * the one from yesterday.
 */
export function summariseWorkspace(entries: WorkspaceEntry[]): WorkspaceSummary {
  const counts: WorkspaceCounts = { errors: 0, warnings: 0, hints: 0 };
  for (const entry of entries) {
    for (const finding of entry.findings) counts[bucket(finding.severity)]++;
  }

  const ranked = entries
    .filter((entry) => entry.findings.length > 0)
    .sort((a, b) => {
      for (const severity of ['error', 'warning', 'hint'] as const) {
        const difference = count(b, severity) - count(a, severity);
        if (difference !== 0) return difference;
      }
      return a.path.localeCompare(b.path);
    });

  return {
    files: entries.length,
    clean: entries.length - ranked.length,
    counts,
    ranked,
  };
}

/**
 * renderWorkspaceReport writes the scan as lines for the output channel. It stops at
 * `limit` files and says how many it stopped short of: a truncated list with no note
 * reads as "this is everything", which is the one way a report can lie.
 */
export function renderWorkspaceReport(summary: WorkspaceSummary, options: ReportOptions = {}): string[] {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const manifests = `${summary.files} ${summary.files === 1 ? 'manifest' : 'manifests'} checked`;
  if (summary.ranked.length === 0) return [`${manifests} · nothing to report`];

  const totals = [
    summary.counts.errors > 0 ? `${summary.counts.errors} error${summary.counts.errors === 1 ? '' : 's'}` : '',
    summary.counts.warnings > 0 ? `${summary.counts.warnings} warning${summary.counts.warnings === 1 ? '' : 's'}` : '',
    summary.counts.hints > 0 ? `${summary.counts.hints} hint${summary.counts.hints === 1 ? '' : 's'}` : '',
  ].filter(Boolean);

  const lines = [`${manifests} · ${summary.clean} clean · ${totals.join(', ')}`];
  for (const entry of summary.ranked.slice(0, limit)) {
    const shape = [
      count(entry, 'error') > 0 ? `${count(entry, 'error')}E` : '',
      count(entry, 'warning') > 0 ? `${count(entry, 'warning')}W` : '',
      count(entry, 'hint') > 0 ? `${count(entry, 'hint')}H` : '',
    ]
      .filter(Boolean)
      .join(' ');
    lines.push(`  ${shape.padEnd(12)}${entry.path}`);
  }
  const dropped = summary.ranked.length - limit;
  if (dropped > 0) lines.push(`  … and ${dropped} more with findings (open the Problems panel for all of them)`);
  return lines;
}

function count(entry: WorkspaceEntry, severity: Severity): number {
  return entry.findings.filter((finding) => finding.severity === severity).length;
}

function bucket(severity: Severity): keyof WorkspaceCounts {
  return severity === 'error' ? 'errors' : severity === 'warning' ? 'warnings' : 'hints';
}
