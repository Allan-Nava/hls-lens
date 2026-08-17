// HLS attribute lists, parsed the way RFC 8216 §4.2 defines them.
//
// The one detail every naive implementation gets wrong: an attribute value may be
// a quoted string containing commas, and CODECS is exactly that
// (CODECS="avc1.4d401f,mp4a.40.2"). Splitting the line on "," loses half the
// codec list and silently reports a manifest as codec-less, so the list is walked
// character by character instead.

/** An attribute list: name → raw value, with quotes removed. */
export type Attrs = Map<string, string>;

/** parseAttributeList parses the part of a tag after the colon. */
export function parseAttributeList(input: string): Attrs {
  const out: Attrs = new Map();
  let i = 0;
  while (i < input.length) {
    while (i < input.length && (input[i] === ',' || input[i] === ' ' || input[i] === '\t')) i++;
    if (i >= input.length) break;

    const nameStart = i;
    while (i < input.length && input[i] !== '=' && input[i] !== ',') i++;
    const name = input.slice(nameStart, i).trim();
    if (input[i] !== '=') {
      // A bare token with no value: keep it, so a rule can report it rather than
      // pretend the attribute was absent.
      if (name) out.set(name, '');
      continue;
    }
    i++; // the '='

    let value: string;
    if (input[i] === '"') {
      i++;
      const start = i;
      while (i < input.length && input[i] !== '"') i++;
      value = input.slice(start, i);
      if (i < input.length) i++; // the closing quote
    } else {
      const start = i;
      while (i < input.length && input[i] !== ',') i++;
      value = input.slice(start, i).trim();
    }
    if (name) out.set(name, value);
  }
  return out;
}

/** attrInt reads a decimal integer attribute; null when absent or not decimal. */
export function attrInt(attrs: Attrs, name: string): number | null {
  const raw = attrs.get(name);
  if (raw === undefined || !/^-?\d+$/.test(raw.trim())) return null;
  return Number.parseInt(raw.trim(), 10);
}

/** attrFloat reads a decimal-floating-point attribute; null when absent or not a number. */
export function attrFloat(attrs: Attrs, name: string): number | null {
  const raw = attrs.get(name);
  if (raw === undefined || !/^-?\d+(\.\d+)?$/.test(raw.trim())) return null;
  return Number.parseFloat(raw.trim());
}

/** A decoded RESOLUTION attribute. */
export interface Resolution {
  width: number;
  height: number;
}

/** attrResolution reads a WxH attribute. */
export function attrResolution(attrs: Attrs, name: string): Resolution | null {
  const raw = attrs.get(name);
  const m = raw?.trim().match(/^(\d+)[xX](\d+)$/);
  if (!m) return null;
  return { width: Number.parseInt(m[1], 10), height: Number.parseInt(m[2], 10) };
}

/** attrList splits a comma-separated quoted-string attribute (CODECS, CHARACTERISTICS). */
export function attrList(attrs: Attrs, name: string): string[] {
  const raw = attrs.get(name);
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** attrBool reads an enumerated YES/NO attribute; anything but YES is false. */
export function attrBool(attrs: Attrs, name: string): boolean {
  return (attrs.get(name) ?? '').trim().toUpperCase() === 'YES';
}
