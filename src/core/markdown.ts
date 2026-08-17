// Markdown → HTML, for the documentation site.
//
// It renders the constructs these documents actually use — headings, paragraphs,
// lists, GitHub pipe tables, fenced code, inline code, emphasis and links — and
// nothing else. That is not laziness: a general markdown implementation is a
// dependency, and this extension has none by design. The scope is checked by a test
// that renders every file in docs/ and asserts no heading is lost.
//
// Everything is escaped by default. The documents are ours, but a rule rationale is
// full of angle brackets (`<MPD>`, `#EXT-X-MAP:URI="…"`) and the safe reading of a
// `<script>` in a manifest example is the literal text.
//
// The output is deterministic: no dates, no counters, no environment. The site is
// rebuilt on every deploy and a diff between two builds should be empty.

export interface Page {
  title?: string;
  body: string;
}

/** frontMatter splits a leading `--- title: … ---` block off the document. */
export function frontMatter(source: string): Page {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) return { body: source };
  const title = /^title:\s*(.+)$/m.exec(match[1])?.[1].trim();
  return { ...(title ? { title } : {}), body: source.slice(match[0].length) };
}

/**
 * pageTitle is what to call a document: its front matter title, or the first heading
 * it carries. The generated documents (RULES.md, ROADMAP.md) have no front matter,
 * and a site whose every browser tab reads "HLS Lens" is no navigation at all.
 */
export function pageTitle(page: Page): string | undefined {
  if (page.title) return page.title;
  return /^#\s+(.+)$/m.exec(page.body)?.[1].trim();
}

/** renderMarkdown turns one document into the HTML of its body. */
export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    out.push(`<p>${inline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const flushList = (): void => {
    if (list.length === 0) return;
    out.push(`<ul>\n${list.map((item) => `  <li>${inline(item)}</li>`).join('\n')}\n</ul>`);
    list = [];
  };
  const flush = (): void => {
    flushParagraph();
    flushList();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code: taken literally to the closing fence, which is the only way the
    // manifest examples in these documents survive.
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      const language = fence[1] ? ` class="language-${fence[1]}"` : '';
      out.push(`<pre><code${language}>${escapeHtml(body.join('\n'))}\n</code></pre>`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length;
      const text = heading[2].trim();
      out.push(`<h${level} id="${anchor(text)}">${inline(text)}</h${level}>`);
      continue;
    }

    if (/^(---|\*\*\*|___)\s*$/.test(line)) {
      flush();
      out.push('<hr>');
      continue;
    }

    // A pipe table: the header row, the delimiter, then rows until a blank line.
    if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      flush();
      const header = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) {
        rows.push(cells(lines[i]));
        i++;
      }
      i--;
      out.push(
        [
          '<table>',
          '<thead>',
          `<tr>${header.map((c) => `<th>${inline(c)}</th>`).join('')}</tr>`,
          '</thead>',
          '<tbody>',
          ...rows.map((row) => `<tr>${row.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`),
          '</tbody>',
          '</table>',
        ].join('\n'),
      );
      continue;
    }

    const item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (item) {
      flushParagraph();
      list.push(item[1]);
      continue;
    }

    if (line.trim() === '') {
      flush();
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  flush();
  return out.join('\n');
}

/** renderPage wraps rendered markdown in the shell every page of the site shares. */
export function renderPage(page: Page, sourceName: string): string {
  const title = page.title ?? 'HLS Lens';
  // The landing page is already called HLS Lens; "HLS Lens · HLS Lens" is a tab title
  // nobody would write by hand.
  const documentTitle = title === 'HLS Lens' ? title : `${title} · HLS Lens`;
  const nav = [
    { href: 'index.html', label: 'Overview', file: 'index.md' },
    { href: 'USAGE.html', label: 'Usage', file: 'USAGE.md' },
    { href: 'RULES.html', label: 'Rules', file: 'RULES.md' },
    { href: 'ROADMAP.html', label: 'Roadmap', file: 'ROADMAP.md' },
  ];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(documentTitle)}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <a class="mark" href="index.html">HLS&nbsp;Lens</a>
  <nav>${nav
    .map((entry) => `<a href="${entry.href}"${entry.file === sourceName ? ' class="here"' : ''}>${entry.label}</a>`)
    .join('')}</nav>
  <a class="source" href="https://github.com/Allan-Nava/hls-lens">GitHub</a>
</header>
<main>
${page.body}
</main>
<footer>Read HLS manifests in VS Code · <a href="https://github.com/Allan-Nava/hls-lens">Allan-Nava/hls-lens</a> · MIT</footer>
</body>
</html>
`;
}

/** The whole stylesheet: one file, no fonts to fetch, no framework. */
const STYLE = `
:root{--ink:#0b1220;--panel:#111a2e;--line:#22304d;--text:#e2e8f0;--dim:#94a3b8;--rung:#10b981;--rung-dim:#2dd4bf;--defect:#ef4444}
*{box-sizing:border-box}
body{margin:0;background:var(--ink);color:var(--text);font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
header{display:flex;gap:1.25rem;align-items:center;padding:1rem 1.5rem;border-bottom:1px solid var(--line);position:sticky;top:0;background:rgba(11,18,32,.92);backdrop-filter:blur(8px)}
header .mark{font-weight:700;color:var(--rung);text-decoration:none;letter-spacing:.01em}
header nav{display:flex;gap:1rem;flex:1}
header a{color:var(--dim);text-decoration:none}
header a:hover,header a.here{color:var(--text)}
header a.here{border-bottom:2px solid var(--rung)}
main{max-width:52rem;margin:0 auto;padding:2.5rem 1.5rem 4rem}
h1{font-size:2rem;line-height:1.2;margin:0 0 1rem}
h2{font-size:1.35rem;margin:2.5rem 0 .75rem;padding-top:.5rem;border-top:1px solid var(--line)}
h3{font-size:1.05rem;margin:2rem 0 .5rem;color:var(--rung-dim)}
p{margin:0 0 1rem}
a{color:var(--rung-dim)}
ul{margin:0 0 1rem;padding-left:1.25rem}
li{margin:.35rem 0}
code{font:0.86em/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--panel);border:1px solid var(--line);border-radius:4px;padding:.1em .35em}
pre{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:1rem;overflow-x:auto}
pre code{background:none;border:0;padding:0;font-size:.85rem;line-height:1.6}
table{width:100%;border-collapse:collapse;margin:0 0 1.5rem;font-size:.94rem;display:block;overflow-x:auto}
th,td{text-align:left;padding:.5rem .6rem;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--dim);font-weight:600;white-space:nowrap}
hr{border:0;border-top:1px solid var(--line);margin:2rem 0}
footer{border-top:1px solid var(--line);color:var(--dim);padding:1.5rem;text-align:center;font-size:.88rem}
@media (max-width:640px){header{flex-wrap:wrap;gap:.75rem}main{padding-top:1.5rem}}
`.trim();

/** cells splits one row of a pipe table. */
function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());
}

/**
 * inline renders the span-level constructs. Code spans are pulled out first and put
 * back at the end, so a rule id full of asterisks or underscores is never read as
 * emphasis — which is most of what these documents are made of.
 */
function inline(text: string): string {
  // The sentinel is NUL: it cannot occur in these documents, so a number in the prose
  // ("4 rungs", "version 7") is never mistaken for a placeholder on the way back.
  const SENTINEL = '\u0000';
  const codes: string[] = [];
  let working = text.replace(/`([^`]+)`/g, (_whole, code: string) => {
    codes.push(`<code>${escapeHtml(code)}</code>`);
    return `${SENTINEL}${codes.length - 1}${SENTINEL}`;
  });

  working = escapeHtml(working);
  working = working.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_w, alt: string, src: string) => `<img src="${link(src)}" alt="${alt}">`);
  working = working.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_w, label: string, href: string) => `<a href="${link(href)}">${label}</a>`);
  working = working.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  working = working.replace(/(^|[\s(])\*([^*]+)\*/g, '$1<em>$2</em>');
  return working.replace(/\u0000(\d+)\u0000/g, (_w, index: string) => codes[Number(index)]);
}

/** link rewrites a link to a sibling document into a link to its built page. */
function link(href: string): string {
  if (/^[a-z]+:/i.test(href) || href.startsWith('#') || href.startsWith('//')) return href;
  return href.replace(/([A-Za-z0-9_-]+)\.md(#.*)?$/, (_w, name: string, hash = '') => `${name}.html${hash}`);
}

function anchor(text: string): string {
  return text
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\p{L}\p{N} -]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
