// BACKLOG.md -> GitHub milestones + issues.
//
// The file is the single source of truth (see CLAUDE.md): this script makes GitHub a
// mirror of it, never the other way round. Nothing here reads issue state back into
// the repository, so an issue edited on GitHub is overwritten on the next run — which
// is the point: one place to look for what is planned.
//
// The mapping:
//   "## v0.3 — Rules that pay for themselves"  -> milestone (closed when every item is)
//   "- [ ] **HL-1 — Title**: body"             -> open issue, label `backlog`
//   "- [x] **HL-1 — Title**: body"             -> closed issue (state_reason: completed)
//
// Every issue is anchored to its stable id by a marker in the body
// (`<!-- backlog:HL-1 -->`), so renaming an item retitles its issue instead of opening
// a second one. Idempotent: it creates, patches or closes only what diverges, which is
// what makes it safe to run on every push.
//
// Env:
//   GITHUB_TOKEN       (required)  token with issues: write
//   GITHUB_REPOSITORY  (required)  "owner/repo" — provided by Actions
//   BACKLOG_FILE       (optional)  defaults to BACKLOG.md
//   DRY_RUN            (optional)  when set, log the writes instead of performing them
import * as fs from 'fs';

import {
  BacklogItem,
  BacklogSection,
  parseBacklog,
  duplicateIds,
  sectionState,
  backlogStats,
  orphanMilestones,
  idFromBody,
  issueBody,
  issueTitle,
} from '../src/core/backlog';

const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY;
const FILE = process.env.BACKLOG_FILE || 'BACKLOG.md';
const DRY_RUN = Boolean(process.env.DRY_RUN);
const LABEL = 'backlog';
const API = 'https://api.github.com';

interface Milestone {
  number: number;
  title: string;
  state: string;
  description?: string | null;
  open_issues?: number;
  closed_issues?: number;
}

interface Issue {
  number: number;
  title: string;
  body?: string | null;
  state: string;
  milestone?: { number: number } | null;
  pull_request?: unknown;
}

function fail(message: string): never {
  console.error(`✖ ${message}`);
  process.exit(1);
}

if (!TOKEN) fail('GITHUB_TOKEN missing');
if (!REPO || !REPO.includes('/')) fail('GITHUB_REPOSITORY missing or malformed');
const [OWNER, NAME] = REPO.split('/');

async function gh<T>(method: 'GET' | 'POST' | 'PATCH', route: string, body?: unknown): Promise<T | null> {
  if (DRY_RUN && method !== 'GET') {
    console.log(`  [dry-run] ${method} ${route}${body ? ' ' + JSON.stringify(body) : ''}`);
    return null;
  }
  const res = await fetch(`${API}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'hls-lens-backlog-sync',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  // A 404 on a GET is "not there yet", which every caller here treats as a value.
  if (res.status === 404) return null;
  if (!res.ok) fail(`${method} ${route} -> ${res.status}: ${await res.text()}`);
  return res.status === 204 ? ({} as T) : ((await res.json()) as T);
}

async function ghPaged<T>(route: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; ; page++) {
    const sep = route.includes('?') ? '&' : '?';
    const batch = await gh<T[]>('GET', `${route}${sep}per_page=100&page=${page}`);
    if (!batch || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

async function ensureLabel(): Promise<void> {
  const existing = await gh<unknown>('GET', `/repos/${OWNER}/${NAME}/labels/${LABEL}`);
  if (existing) return;
  console.log(`+ label "${LABEL}"`);
  await gh('POST', `/repos/${OWNER}/${NAME}/labels`, {
    name: LABEL,
    color: '0e8a16',
    description: 'Tracked in BACKLOG.md (automatic sync)',
  });
}

/**
 * Milestones are matched by title, so renaming a `##` heading opens a new milestone and
 * leaves the old one behind — deliberately, because the alternative is guessing which
 * rename is a rename and which is a new phase of the project.
 */
async function syncMilestones(sections: BacklogSection[]): Promise<Map<string, number>> {
  const existing = await ghPaged<Milestone>(`/repos/${OWNER}/${NAME}/milestones?state=all`);
  const byTitle = new Map(existing.map((m) => [m.title, m]));
  const numbers = new Map<string, number>();

  for (const section of sections) {
    const state = sectionState(section) === 'shipped' ? 'closed' : 'open';
    const description = section.blurb;
    let milestone = byTitle.get(section.title);

    if (!milestone) {
      console.log(`+ milestone "${section.title}" (${state})`);
      milestone = await gh<Milestone>('POST', `/repos/${OWNER}/${NAME}/milestones`, {
        title: section.title,
        state,
        description,
      }) ?? undefined;
    } else {
      const patch: Record<string, string> = {};
      if (milestone.state !== state) patch.state = state;
      if ((milestone.description ?? '') !== description) patch.description = description;
      if (Object.keys(patch).length > 0) {
        console.log(`~ milestone "${section.title}" ${Object.keys(patch).join(',')}`);
        await gh('PATCH', `/repos/${OWNER}/${NAME}/milestones/${milestone.number}`, patch);
      }
    }

    if (milestone?.number) numbers.set(section.title, milestone.number);
  }

  // A renamed heading leaves its old milestone behind: report the empty leftovers so
  // they do not pile up unnoticed, but never delete them — see orphanMilestones.
  //
  // The counts come from the issues endpoint rather than from open_issues/closed_issues
  // on the milestone: GitHub does not recompute those counters when an issue is moved
  // to another milestone, so the list endpoint keeps reporting a milestone as full long
  // after this very sync emptied it — which would hide every leftover it creates.
  const unknown = existing.filter((m) => !numbers.has(m.title));
  const counted: Array<{ title: string; issues: number }> = [];
  for (const milestone of unknown) {
    const issues = await ghPaged<Issue>(`/repos/${OWNER}/${NAME}/issues?milestone=${milestone.number}&state=all`);
    counted.push({ title: milestone.title, issues: issues.length });
  }
  for (const title of orphanMilestones(sections, counted)) {
    console.log(
      `! milestone "${title}" (#${byTitle.get(title)?.number}) is empty and no longer in ${FILE} — delete it by hand if a rename left it behind`,
    );
  }

  return numbers;
}

async function syncIssues(items: BacklogItem[], milestones: Map<string, number>): Promise<void> {
  // The issues endpoint returns pull requests too; a PR is not a backlog item.
  const existing = (await ghPaged<Issue>(`/repos/${OWNER}/${NAME}/issues?state=all&labels=${LABEL}`)).filter(
    (i) => !i.pull_request,
  );
  const byId = new Map<string, Issue>();
  for (const issue of existing) {
    const id = idFromBody(issue.body ?? '');
    if (id) byId.set(id, issue);
  }

  for (const item of items) {
    const wantTitle = issueTitle(item);
    const wantBody = issueBody(item);
    const wantState = item.done ? 'closed' : 'open';
    const milestone = milestones.get(item.milestone);
    const found = byId.get(item.id);

    if (!found) {
      console.log(`+ issue ${item.id} "${item.title}" (${wantState})`);
      const created = await gh<Issue>('POST', `/repos/${OWNER}/${NAME}/issues`, {
        title: wantTitle,
        body: wantBody,
        labels: [LABEL],
        milestone,
      });
      // Issues are always created open: an item that is already checked closes right away.
      if (item.done && created?.number) {
        await gh('PATCH', `/repos/${OWNER}/${NAME}/issues/${created.number}`, {
          state: 'closed',
          state_reason: 'completed',
        });
      }
      continue;
    }

    const patch: Record<string, unknown> = {};
    if (found.title !== wantTitle) patch.title = wantTitle;
    if ((found.body ?? '') !== wantBody) patch.body = wantBody;
    if (found.state !== wantState) {
      patch.state = wantState;
      if (wantState === 'closed') patch.state_reason = 'completed';
    }
    if (milestone && (found.milestone?.number ?? null) !== milestone) patch.milestone = milestone;

    if (Object.keys(patch).length === 0) continue;
    console.log(`~ issue ${item.id} #${found.number} ${Object.keys(patch).join(',')}`);
    await gh('PATCH', `/repos/${OWNER}/${NAME}/issues/${found.number}`, patch);
  }

  // An id that disappeared from the file keeps its issue: closing it implicitly would
  // hide work that was deleted by accident, and a warning in the log costs nothing.
  const known = new Set(items.map((i) => i.id));
  for (const [id, issue] of byId) {
    if (!known.has(id) && issue.state === 'open') {
      console.log(`! issue ${id} #${issue.number} is open but no longer in ${FILE} — close it by hand or restore the item`);
    }
  }
}

/**
 * A 404 is a value everywhere else in this script ("no label yet", "no milestone yet"),
 * which makes a wrong repository, a token without access and a repository that does not
 * exist at all look exactly like an empty backlog: every listing comes back empty and the
 * run reports success having done nothing. One request up front turns that into an error.
 */
async function assertRepoReachable(): Promise<void> {
  const repo = await gh<{ full_name: string }>('GET', `/repos/${OWNER}/${NAME}`);
  if (!repo) {
    fail(
      `${OWNER}/${NAME} is not reachable — the repository does not exist, or the token cannot see it. ` +
        'Nothing was written.',
    );
  }
}

async function main(): Promise<void> {
  const sections = parseBacklog(fs.readFileSync(FILE, 'utf8'));
  if (sections.length === 0) fail(`${FILE}: no milestone found`);

  const dupes = duplicateIds(sections);
  if (dupes.length > 0) fail(`${FILE}: duplicate ids: ${dupes.join(', ')}`);

  const items = sections.flatMap((s) => s.items);
  const stats = backlogStats(sections);
  console.log(
    `${FILE}: ${sections.length} milestones, ${stats.total} items (${stats.done} done)${DRY_RUN ? ' — dry run' : ''}`,
  );

  await assertRepoReachable();
  await ensureLabel();
  const milestones = await syncMilestones(sections);
  await syncIssues(items, milestones);
  console.log('✓ sync complete');
}

main().catch((err) => fail(err instanceof Error ? (err.stack ?? err.message) : String(err)));
