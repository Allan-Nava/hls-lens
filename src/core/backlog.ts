// BACKLOG.md as data: parsing, the roadmap projection, and the issue mapping.
//
// BACKLOG.md is the single source of truth for the work on this extension. Two
// consumers read it, and both are generated rather than maintained by hand:
// docs/ROADMAP.md (`npm run roadmap`) and the GitHub milestones/issues mirror (the
// backlog-sync workflow). Keeping the parsing here — pure, tested, no `vscode` and
// no network — means a malformed backlog fails the test suite rather than the job.
//
// The format the parser accepts:
//
//   ## v0.3 — Rules that pay for themselves     -> a milestone
//   Prose right under the heading               -> the milestone's blurb
//   ### Rules                                   -> an area inside the milestone
//   - [ ] **HL-1 — Title**: description         -> an open item (one issue)
//   - [x] **HL-2 — Title**: description         -> a closed item

/** An item: one line of the backlog, one GitHub issue. */
export interface BacklogItem {
  /** Stable id, e.g. `HL-7`. What a commit, a branch or an issue marker references. */
  id: string;
  title: string;
  /** Everything after the title's colon. May be empty. */
  desc: string;
  /** Nearest `###` heading above the item, when the milestone groups its work. */
  area?: string;
  done: boolean;
  /** Title of the `##` section the item lives in. */
  milestone: string;
}

/** A `##` section: one milestone. */
export interface BacklogSection {
  title: string;
  /** The prose between the heading and the first item, if any. */
  blurb: string;
  items: BacklogItem[];
}

export type SectionState = 'shipped' | 'in progress' | 'planned';

/**
 * An item line. The id prefix is deliberately generic (`HL-`, `NOM-`, …) so the
 * sibling repositories can share this parser, and the separator accepts both an em
 * dash and a hyphen because an editor that helpfully "fixes" one should not silently
 * drop half the backlog.
 */
const ITEM_RE = /^-\s+\[([ xX])\]\s+\*\*([A-Z][A-Z0-9]*-\d+)\s*(?:—|–|-)\s*(.+?)\*\*\s*:?\s*(.*)$/;
const H2_RE = /^##\s+(.+?)\s*$/;
const H3_RE = /^###\s+(.+?)\s*$/;
const MARKER_RE = /<!--\s*backlog:([A-Z][A-Z0-9]*-\d+)\s*-->/;

/**
 * parseBacklog reads the file into milestones. A `##` section with no items is not a
 * milestone — the intro and a notes section must be able to coexist with the backlog
 * in one file without conjuring empty milestones on GitHub.
 */
export function parseBacklog(md: string): BacklogSection[] {
  const sections: BacklogSection[] = [];
  let current: BacklogSection | undefined;
  let area: string | undefined;
  /** Prose lines seen since the `##` heading, kept only until the first item. */
  let pendingBlurb: string[] = [];

  for (const raw of md.split('\n')) {
    const line = raw.replace(/\s+$/, '');

    const h2 = line.match(H2_RE);
    if (h2) {
      current = { title: h2[1].trim(), blurb: '', items: [] };
      sections.push(current);
      area = undefined;
      pendingBlurb = [];
      continue;
    }

    const h3 = line.match(H3_RE);
    if (h3) {
      area = h3[1].trim();
      continue;
    }

    const item = line.match(ITEM_RE);
    if (item && current) {
      if (current.items.length === 0) current.blurb = pendingBlurb.join(' ').trim();
      current.items.push({
        done: item[1].toLowerCase() === 'x',
        id: item[2],
        title: item[3].trim(),
        desc: item[4].trim(),
        area,
        milestone: current.title,
      });
      continue;
    }

    // Prose before the first item of a section is the milestone's blurb; a heading of
    // any depth ends it, and anything after the first item is not collected.
    if (current && current.items.length === 0 && line.trim() && !line.startsWith('#') && !line.startsWith('-')) {
      pendingBlurb.push(line.trim());
    }
  }

  return sections.filter((s) => s.items.length > 0);
}

/** duplicateIds reports every id used more than once, in order of first repeat. */
export function duplicateIds(sections: BacklogSection[]): string[] {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const item of sections.flatMap((s) => s.items)) {
    if (seen.has(item.id)) {
      if (!dupes.includes(item.id)) dupes.push(item.id);
    } else {
      seen.add(item.id);
    }
  }
  return dupes;
}

/** sectionState is what closes (or does not close) the milestone on GitHub. */
export function sectionState(section: BacklogSection): SectionState {
  const done = section.items.filter((i) => i.done).length;
  if (section.items.length > 0 && done === section.items.length) return 'shipped';
  return done === 0 ? 'planned' : 'in progress';
}

export function backlogStats(sections: BacklogSection[]): {
  total: number;
  done: number;
  open: number;
  percent: number;
} {
  const items = sections.flatMap((s) => s.items);
  const done = items.filter((i) => i.done).length;
  return {
    total: items.length,
    done,
    open: items.length - done,
    percent: items.length === 0 ? 0 : Math.round((done / items.length) * 100),
  };
}

/**
 * progressBar draws the ratio with block characters. It floors rather than rounds:
 * a bar that shows one filled cell for 1 item out of 100 overstates the progress,
 * and the numbers next to it are there for the exact figure.
 */
export function progressBar(done: number, total: number, width = 10): string {
  const filled = total <= 0 ? 0 : Math.min(width, Math.floor((done / total) * width));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/**
 * renderRoadmap projects the backlog into docs/ROADMAP.md. Deterministic on purpose:
 * CI regenerates the file and diffs it against the commit, so a date stamp or any
 * other ambient input would fail the gate on a run that changed nothing.
 */
export function renderRoadmap(sections: BacklogSection[]): string {
  const stats = backlogStats(sections);
  const lines: string[] = [
    '<!-- Generated by `npm run roadmap` from BACKLOG.md. Do not edit by hand. -->',
    '',
    '# Roadmap',
    '',
    'Where HLS Lens is going. This page is a projection of [BACKLOG.md](../BACKLOG.md), which is the',
    'single source of truth: every item has a stable id (`HL-n`) and is mirrored as a GitHub issue by',
    'the `backlog-sync` workflow, so the file, this page and the issue tracker cannot drift apart.',
    '',
    `**${stats.done} of ${stats.total} items done** · \`${progressBar(stats.done, stats.total)}\` ${stats.percent}%`,
    '',
    '| Milestone | State | Done |',
    '|---|---|---|',
  ];

  for (const section of sections) {
    const done = section.items.filter((i) => i.done).length;
    lines.push(
      `| [${section.title}](#${anchor(section.title)}) | ${stateLabel(sectionState(section))} | ${done}/${section.items.length} |`,
    );
  }
  lines.push('');

  for (const section of sections) {
    const done = section.items.filter((i) => i.done).length;
    lines.push(`## ${section.title}`, '');
    if (section.blurb) lines.push(section.blurb, '');
    lines.push(
      `${stateLabel(sectionState(section))} · ${done} of ${section.items.length} · \`${progressBar(done, section.items.length)}\``,
      '',
    );

    let area: string | undefined;
    let areaStarted = false;
    for (const item of section.items) {
      if (item.area !== area) {
        area = item.area;
        if (area) {
          if (areaStarted) lines.push('');
          lines.push(`### ${area}`, '');
          areaStarted = true;
        }
      }
      const box = item.done ? 'x' : ' ';
      lines.push(`- [${box}] **${item.id} — ${item.title}**${item.desc ? `: ${item.desc}` : ''}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * orphanMilestones names the milestones on GitHub that the backlog no longer knows
 * about and that hold no issues.
 *
 * Milestones are matched by title, so renaming a `##` heading creates a new milestone
 * and leaves the old one behind, empty. The sync reports these instead of deleting
 * them: it cannot tell a leftover from a milestone somebody opened by hand, and one
 * that still holds issues is somebody's working state either way.
 */
export function orphanMilestones(
  sections: BacklogSection[],
  milestones: Array<{ title: string; issues: number }>,
): string[] {
  const known = new Set(sections.map((s) => s.title));
  return milestones.filter((m) => !known.has(m.title) && m.issues === 0).map((m) => m.title);
}

/** markerOf is the anchor that ties an issue to its backlog id, title changes and all. */
export function markerOf(id: string): string {
  return `<!-- backlog:${id} -->`;
}

export function idFromBody(body: string): string | undefined {
  return body.match(MARKER_RE)?.[1];
}

export function issueTitle(item: BacklogItem): string {
  return `${item.id} — ${item.title}`;
}

/**
 * issueBody must be a pure function of the item: the sync compares the rendered body
 * with the one on GitHub and patches on a difference, so anything ambient in here
 * would rewrite every issue on every run.
 */
export function issueBody(item: BacklogItem): string {
  const lines: string[] = [];
  if (item.desc) lines.push(item.desc, '');
  lines.push(`**Milestone:** ${item.milestone}`);
  if (item.area) lines.push(`**Area:** ${item.area}`);
  lines.push('', markerOf(item.id), '', '_Tracked in `BACKLOG.md` — edit the file, not this issue: the sync overwrites it._');
  return lines.join('\n');
}

function stateLabel(state: SectionState): string {
  return state === 'shipped' ? '✅ shipped' : state === 'in progress' ? '🚧 in progress' : '⏳ planned';
}

/** anchor renders the GitHub heading anchor of a milestone title. */
function anchor(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N} -]/gu, '')
    .trim()
    .replace(/ /g, '-');
}
