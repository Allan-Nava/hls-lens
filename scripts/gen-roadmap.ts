// Writes docs/ROADMAP.md from BACKLOG.md.
//
// The backlog is the plan; a roadmap maintained next to it by hand is a second plan
// that disagrees with the first one by the second release. CI regenerates this file
// and fails if the result differs from what is committed.
//
//   npm run roadmap
import * as fs from 'fs';
import * as path from 'path';

import { parseBacklog, duplicateIds, renderRoadmap, backlogStats } from '../src/core/backlog';

const SRC = process.env.BACKLOG_FILE || 'BACKLOG.md';
const OUT = path.join('docs', 'ROADMAP.md');

const sections = parseBacklog(fs.readFileSync(SRC, 'utf8'));
if (sections.length === 0) {
  console.error(`✖ ${SRC}: no milestone found — a '## Heading' with at least one '- [ ] **HL-n — …**' item`);
  process.exit(1);
}

// The same guard the sync job applies: two items with one id means one of them silently
// loses its issue, so the generator refuses rather than produce a plausible roadmap.
const dupes = duplicateIds(sections);
if (dupes.length > 0) {
  console.error(`✖ ${SRC}: duplicate ids: ${dupes.join(', ')}`);
  process.exit(1);
}

fs.mkdirSync('docs', { recursive: true });
fs.writeFileSync(OUT, renderRoadmap(sections));

const stats = backlogStats(sections);
console.log(`wrote ${OUT} (${sections.length} milestones, ${stats.done}/${stats.total} done)`);
