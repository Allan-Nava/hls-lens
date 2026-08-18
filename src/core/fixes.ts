// Quick fixes: the findings an edit can settle without a judgement call.
//
// Only the mechanical ones. Raising EXT-X-VERSION to what the playlist already uses,
// appending the EXT-X-ENDLIST a finished asset is missing and raising a target
// duration to the longest segment are all rewrites of a number or a line the manifest
// itself determines. Everything else — a missing CODECS string, a ladder that is
// badly spaced, a key served over HTTP — needs a decision this file has no business
// making, and gets no fix rather than a plausible one.
import { Finding } from './analyze';
import { KNOWN_TAG_NAMES, Playlist } from './playlist';

/** An edit expressed in the terms of a text document, 0-based lines. */
export type Edit =
  | { kind: 'replace'; line: number; text: string }
  | { kind: 'insertAfter'; line: number; text: string };

/** One offered fix: what to call it in the lightbulb, and what it does. */
export interface QuickFix {
  title: string;
  edit: Edit;
}

export function quickFixesFor(pl: Playlist, finding: Finding): QuickFix[] {
  switch (finding.rule) {
    case 'syntax/version-too-low':
      return versionFix(pl, finding);
    case 'media/missing-endlist':
      return endListFix(pl);
    case 'media/extinf-exceeds-target':
      return targetDurationFix(pl);
    case 'media/target-duration-overstated':
      return targetDurationFix(pl);
    case 'syntax/unknown-tag':
      return spellingFix(pl, finding);
    case 'master/rendition-default-not-autoselect':
      return lineRewrite(pl, finding, /AUTOSELECT=NO/i, 'AUTOSELECT=YES', 'Set AUTOSELECT=YES');
    case 'master/rendition-forced':
      return attributeRemoval(pl, finding, 'FORCED');
    default:
      return [];
  }
}

/** How far a misspelling may be from a real tag before it stops being a misspelling. */
const MAX_TAG_DISTANCE = 2;

/**
 * A tag players will silently ignore is worth guessing at — but only when the guess
 * is close. Two edits from a real tag is a typo; further than that it is either a
 * vendor extension or a tag from a spec this parser predates, and rewriting it would
 * destroy a line the author meant.
 */
function spellingFix(pl: Playlist, finding: Finding): QuickFix[] {
  const line = pl.lines[finding.line] ?? '';
  const written = /^#([A-Za-z0-9-]+)/.exec(line.trim())?.[1];
  if (!written) return [];

  let best: { name: string; distance: number } | undefined;
  for (const name of [...KNOWN_TAG_NAMES].sort()) {
    const distance = editDistance(written.toUpperCase(), name);
    if (distance > MAX_TAG_DISTANCE || distance === 0) continue;
    if (!best || distance < best.distance) best = { name, distance };
  }
  if (!best) return [];

  const rest = line.trim().slice(written.length + 1);
  return [
    {
      title: `Change #${written} to #${best.name}`,
      edit: { kind: 'replace', line: finding.line, text: `#${best.name}${rest}` },
    },
  ];
}

/** A fix that rewrites part of the line the finding points at. */
function lineRewrite(pl: Playlist, finding: Finding, pattern: RegExp, replacement: string, title: string): QuickFix[] {
  const line = pl.lines[finding.line];
  if (line === undefined || !pattern.test(line)) return [];
  return [{ title, edit: { kind: 'replace', line: finding.line, text: line.replace(pattern, replacement) } }];
}

/** Removing one attribute from an attribute list, without leaving its comma behind. */
function attributeRemoval(pl: Playlist, finding: Finding, attribute: string): QuickFix[] {
  const line = pl.lines[finding.line];
  if (line === undefined) return [];
  const trailing = new RegExp(`,\\s*${attribute}=[^,]*`, 'i');
  const leading = new RegExp(`${attribute}=[^,]*,\\s*`, 'i');
  const text = trailing.test(line) ? line.replace(trailing, '') : leading.test(line) ? line.replace(leading, '') : undefined;
  if (text === undefined) return [];
  return [{ title: `Remove ${attribute}`, edit: { kind: 'replace', line: finding.line, text } }];
}

/**
 * Levenshtein distance, small strings only — tag names. It is here rather than as a
 * dependency for the same reason as everything else in this core.
 */
function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_unused, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const candidate = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = previous[j];
      previous[j] = candidate;
    }
  }
  return previous[b.length];
}

/**
 * The required version is in the finding's own message, which the rule builds from
 * the version table. Reading it back is deliberate: the fix cannot disagree with the
 * diagnostic the user is looking at, which is what a second computation would risk.
 */
function versionFix(pl: Playlist, finding: Finding): QuickFix[] {
  const needed = /need[s]? (\d+)/.exec(finding.message)?.[1];
  if (!needed) return [];
  const line = `#EXT-X-VERSION:${needed}`;
  if (pl.versionLine !== null) {
    return [{ title: `Set ${line}`, edit: { kind: 'replace', line: pl.versionLine, text: line } }];
  }
  // No EXT-X-VERSION at all: it belongs immediately after #EXTM3U.
  return [{ title: `Add ${line}`, edit: { kind: 'insertAfter', line: 0, text: line } }];
}

function endListFix(pl: Playlist): QuickFix[] {
  // After the last line with anything on it, so the tag does not land past a run of
  // trailing blank lines where it reads as unrelated to the playlist.
  let last = pl.lines.length - 1;
  while (last > 0 && pl.lines[last].trim() === '') last--;
  return [{ title: 'Append #EXT-X-ENDLIST', edit: { kind: 'insertAfter', line: last, text: '#EXT-X-ENDLIST' } }];
}

function targetDurationFix(pl: Playlist): QuickFix[] {
  const longest = pl.segments.reduce((max, s) => Math.max(max, s.duration ?? 0), 0);
  if (longest <= 0) return [];
  // The spec compares the rounded duration, so the ceiling of the longest segment is
  // the smallest value that makes every segment legal.
  const target = Math.ceil(longest);
  const text = `#EXT-X-TARGETDURATION:${target}`;
  if (pl.targetDurationLine !== null) {
    return [{ title: `Set ${text}`, edit: { kind: 'replace', line: pl.targetDurationLine, text } }];
  }
  return [{ title: `Add ${text}`, edit: { kind: 'insertAfter', line: 0, text } }];
}
