// A small XML reader, for the manifests DASH writes.
//
// It is here rather than in a dependency for the reason the rest of this extension
// has none: an editor extension that pulls a parser tree in pays for it in install
// size and in supply chain on every user's machine, and an MPD is a nesting of
// elements with attributes — the part of XML that fits in a page of code.
//
// What it deliberately does not do: entity expansion beyond the five predefined ones,
// namespaces as anything other than part of the element name, DTDs, or validation.
// An MPD that needs any of those is one this reader reports on rather than guesses at.
//
// Line indexes are 0-based, like everywhere else in the core, because a finding that
// cannot point at a line is the thing this whole extension exists to avoid.

/** One element. Text content is not modelled: nothing in an MPD needs it. */
export interface XmlNode {
  name: string;
  attrs: Map<string, string>;
  children: XmlNode[];
  /** 0-based line of the opening tag. */
  line: number;
}

export interface XmlError {
  message: string;
  line: number;
}

export interface XmlDocument {
  root: XmlNode | null;
  errors: XmlError[];
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/**
 * parseXml reads a document into a tree. It never throws: a malformed document
 * returns whatever was readable plus the errors, because the caller is a linter and
 * "this file is broken here" is the most useful thing it can say.
 */
export function parseXml(text: string): XmlDocument {
  const errors: XmlError[] = [];
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;

  // Line of an offset, computed by counting newlines behind it.
  const lineAt = (offset: number): number => {
    let line = 0;
    for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++;
    return line;
  };

  let at = 0;
  while (at < text.length) {
    const open = text.indexOf('<', at);
    if (open < 0) break;

    // Declarations, comments and processing instructions carry nothing this reader wants.
    if (text.startsWith('<!--', open)) {
      const end = text.indexOf('-->', open + 4);
      at = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<?', open) || text.startsWith('<!', open)) {
      const end = text.indexOf('>', open);
      at = end < 0 ? text.length : end + 1;
      continue;
    }

    const close = findTagEnd(text, open);
    if (close < 0) {
      errors.push({ message: 'a tag is never closed', line: lineAt(open) });
      break;
    }
    const raw = text.slice(open + 1, close).trim();
    at = close + 1;

    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim();
      const current = stack[stack.length - 1];
      if (!current) {
        errors.push({ message: `</${name}> closes nothing`, line: lineAt(open) });
      } else if (current.name !== name) {
        errors.push({ message: `</${name}> closes <${current.name}>`, line: lineAt(open) });
        stack.pop();
      } else {
        stack.pop();
      }
      continue;
    }

    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const nameEnd = body.search(/[\s]/);
    const name = (nameEnd < 0 ? body : body.slice(0, nameEnd)).trim();
    if (!name) {
      errors.push({ message: 'an element has no name', line: lineAt(open) });
      continue;
    }
    const node: XmlNode = {
      name,
      attrs: parseAttributes(nameEnd < 0 ? '' : body.slice(nameEnd)),
      children: [],
      line: lineAt(open),
    };

    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else if (!root) root = node;
    else errors.push({ message: `<${name}> is a second root element`, line: node.line });

    if (!selfClosing) stack.push(node);
  }

  for (const unclosed of stack) {
    errors.push({ message: `<${unclosed.name}> is never closed`, line: unclosed.line });
  }
  return { root, errors };
}

/**
 * findTagEnd finds the '>' that ends a tag, skipping the ones inside quoted attribute
 * values — `<S t="a>b"/>` is one tag, not two.
 */
function findTagEnd(text: string, open: number): number {
  let quote: string | null = null;
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return i;
  }
  return -1;
}

function parseAttributes(source: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const re = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    attrs.set(m[1], decodeEntities(m[3] ?? m[4] ?? ''));
  }
  return attrs;
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) return String.fromCodePoint(parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(parseInt(body.slice(1), 10));
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** findAll collects every descendant with this name, in document order. */
export function findAll(node: XmlNode, name: string): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (current: XmlNode): void => {
    for (const child of current.children) {
      if (child.name === name || child.name.endsWith(`:${name}`)) out.push(child);
      walk(child);
    }
  };
  if (node.name === name) out.push(node);
  walk(node);
  return out;
}

/** attr reads one attribute, ignoring any namespace prefix on it. */
export function attr(node: XmlNode, name: string): string | undefined {
  const direct = node.attrs.get(name);
  if (direct !== undefined) return direct;
  for (const [key, value] of node.attrs) {
    if (key.endsWith(`:${name}`)) return value;
  }
  return undefined;
}
