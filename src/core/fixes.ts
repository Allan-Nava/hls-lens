// Quick fixes: the findings an edit can settle without a judgement call.
//
// Only the mechanical ones. Raising EXT-X-VERSION to what the playlist already uses,
// appending the EXT-X-ENDLIST a finished asset is missing and raising a target
// duration to the longest segment are all rewrites of a number or a line the manifest
// itself determines. Everything else — a missing CODECS string, a ladder that is
// badly spaced, a key served over HTTP — needs a decision this file has no business
// making, and gets no fix rather than a plausible one.
import { Finding } from './analyze';
import { Playlist } from './playlist';

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
    default:
      return [];
  }
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
