// The findings as something you can send someone.
//
// The Problems panel is where a defect is fixed; it is not where a defect is argued
// about with the team that produced it. A packager vendor gets a file, not a
// screenshot of an editor — so the same findings come out as markdown to paste into
// a ticket, or as JSON for whatever reads it next.
//
// Two decisions the tests hold in place:
//
//   * Lines are 1-based here. 0-based is an editor's convention (and this core's,
//     everywhere else); a report is read by people and by CI, and both count from 1.
//   * The JSON carries a `schema` number. Anything that parses this is code somebody
//     else wrote, and it needs something to pin.
import { Finding } from './analyze';
import { summariseWorkspace, WorkspaceEntry } from './workspace';

/** What to call the report, and anything the caller wants under the title. */
export interface ReportOptions {
  title?: string;
  /** A line under the title: where the findings came from, when they were taken. */
  subtitle?: string;
}

/** The shape of the JSON export. Bump `schema` if this stops being true. */
const SCHEMA = 1;

/** renderFindingsMarkdown writes the report as markdown, for a ticket or a PR. */
export function renderFindingsMarkdown(entries: WorkspaceEntry[], options: ReportOptions = {}): string {
  const summary = summariseWorkspace(entries);
  const lines = [`# ${options.title ?? 'HLS Lens'}`, ''];
  if (options.subtitle) lines.push(options.subtitle, '');

  const totals = [
    `${summary.files} manifest${summary.files === 1 ? '' : 's'} checked`,
    `${summary.clean} clean`,
    `${summary.counts.errors} error${summary.counts.errors === 1 ? '' : 's'}`,
    `${summary.counts.warnings} warning${summary.counts.warnings === 1 ? '' : 's'}`,
    `${summary.counts.hints} hint${summary.counts.hints === 1 ? '' : 's'}`,
  ].join(' · ');
  lines.push(totals, '');

  if (summary.ranked.length === 0) {
    lines.push('Nothing to report.');
    return `${lines.join('\n')}\n`;
  }

  for (const entry of summary.ranked) {
    lines.push(`## ${entry.path}`, '');
    lines.push('| Line | Severity | Rule | What |', '|---:|---|---|---|');
    for (const finding of entry.findings) {
      lines.push(`| ${finding.line + 1} | ${finding.severity} | \`${finding.rule}\` | ${cell(finding)} |`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

/** renderFindingsJson writes the same report for whatever reads it next. */
export function renderFindingsJson(entries: WorkspaceEntry[], options: ReportOptions = {}): string {
  const summary = summariseWorkspace(entries);
  const report = {
    tool: 'hls-lens',
    schema: SCHEMA,
    ...(options.title ? { title: options.title } : {}),
    ...(options.subtitle ? { subtitle: options.subtitle } : {}),
    summary: {
      files: summary.files,
      clean: summary.clean,
      errors: summary.counts.errors,
      warnings: summary.counts.warnings,
      hints: summary.counts.hints,
    },
    // Only the manifests with something to say: a list of every clean file is noise
    // in a report that exists to be read by someone who did not run it.
    files: summary.ranked.map((entry) => ({
      path: entry.path,
      findings: entry.findings.map((finding) => ({
        rule: finding.rule,
        severity: finding.severity,
        line: finding.line + 1,
        message: finding.message,
        ...(finding.hint ? { hint: finding.hint } : {}),
      })),
    })),
  };
  return `${JSON.stringify(report, null, 2)}\n`;
}

/**
 * One table cell. A pipe in a message — a URI with one in it, a codec list — would
 * otherwise end the column early and shift every cell after it.
 */
function cell(finding: Finding): string {
  const text = finding.hint ? `${finding.message} — ${finding.hint}` : finding.message;
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
