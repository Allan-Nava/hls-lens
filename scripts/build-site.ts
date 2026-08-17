// Builds site/ from docs/: one HTML page per markdown document.
//
// The site is not committed. It is rebuilt from the same documents the repository
// already keeps — two of which (RULES.md, ROADMAP.md) are themselves generated and
// gated in CI — so a page cannot describe a state the code is not in, and there is no
// generated HTML to review in a diff.
//
//   npm run site
import * as fs from 'fs';
import * as path from 'path';

import { frontMatter, pageTitle, renderMarkdown, renderPage } from '../src/core/markdown';

const SOURCE = 'docs';
const OUT = 'site';

const pages = fs
  .readdirSync(SOURCE)
  .filter((name) => name.endsWith('.md'))
  .sort();

if (pages.length === 0) {
  console.error(`✖ no markdown found in ${SOURCE}/`);
  process.exit(1);
}

fs.mkdirSync(OUT, { recursive: true });
for (const name of pages) {
  const source = fs.readFileSync(path.join(SOURCE, name), 'utf8');
  const page = frontMatter(source);
  const title = pageTitle(page);
  const html = renderPage({ ...(title ? { title } : {}), body: renderMarkdown(page.body) }, name);
  fs.writeFileSync(path.join(OUT, name.replace(/\.md$/, '.html')), html);
}

// Pages serves this directory as-is; the file tells GitHub not to run Jekyll over it,
// which would otherwise try to interpret the braces in the manifest examples.
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

console.log(`wrote ${OUT}/ (${pages.map((n) => n.replace(/\.md$/, '.html')).join(', ')})`);
