// Rules that need more than one file: the master and its renditions, read together.
//
// Everything in analyze.ts judges a playlist on its own, which is all a single open
// file allows. The defects here are invisible that way — every rendition is a valid
// playlist, and they only disagree with each other. They are also the defects that
// produce the worst symptoms: a player switching rungs mid-stream lands wherever the
// timelines diverge, and no single file explains why.
//
// Findings anchor to the master playlist: the line of the EXT-X-STREAM-INF whose
// rendition diverges, because that is the file the user has open and the line that
// names the rendition. The rendition URI is in the message.
import { Finding, RULES, Severity } from './analyze';
import { Playlist } from './playlist';

/** One rendition of the master, loaded. */
export interface LoadedRendition {
  /** URI as the master writes it, for the message. */
  uri: string;
  /** 0-based line of its EXT-X-STREAM-INF in the master. */
  line: number;
  /** BANDWIDTH the master declares for it, when it declares one. */
  bandwidth: number | null;
  playlist: Playlist;
}

export interface CrossOptions {
  /**
   * How far two segment boundaries may sit apart before they count as drift.
   * Encoders round durations; a frame at 25fps is 40ms, so the default leaves room
   * for rounding without letting a real half-second offset through.
   */
  timelineToleranceS?: number;
  /**
   * The master itself, when the caller has it. Only the rules that compare a
   * master-level declaration with the renditions need it, so it stays optional:
   * everything else here is rendition against rendition.
   */
  master?: Playlist;
}

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, hint: 2 };

/**
 * analyzeAcross compares the renditions with each other. The first one listed is the
 * reference — not because it is more correct, but because a difference has to be
 * reported against something, and the master's own order is the one the operator
 * reads.
 */
export function analyzeAcross(renditions: LoadedRendition[], options: CrossOptions = {}): Finding[] {
  const tolerance = options.timelineToleranceS ?? 0.05;
  const findings: Finding[] = [];
  const add = (rule: string, line: number, message: string, hint?: string): void => {
    const doc = RULES.find((r) => r.id === rule);
    findings.push({ rule, severity: doc?.severity ?? 'warning', line, message, ...(hint ? { hint } : {}) });
  };

  // BANDWIDTH against what the rendition says about itself. This one needs no second
  // rendition: it is the master's claim against the playlist's own EXT-X-BITRATE.
  for (const r of renditions) {
    if (r.bandwidth === null) continue;
    const declared = r.playlist.tags
      .filter((t) => t.name === 'EXT-X-BITRATE')
      .map((t) => Number.parseFloat(t.value))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (declared.length === 0) continue;
    const peakBps = Math.max(...declared) * 1000;
    if (peakBps > r.bandwidth) {
      add(
        'cross/bitrate-vs-declared',
        r.line,
        `the master declares BANDWIDTH=${r.bandwidth} for "${r.uri}" but the playlist itself declares EXT-X-BITRATE up to ${Math.round(peakBps)}`,
        'BANDWIDTH is the peak the rendition can reach: understating it makes ABR pick a rung the connection cannot carry',
      );
    }
  }

  // EXT-X-SESSION-KEY is the master promising which key the renditions use, so that a
  // player can fetch it while it is still reading the master. Checking the promise
  // needs both files, and it needs no second rendition.
  const sessionKeys = (options.master?.tags ?? []).filter((t) => t.name === 'EXT-X-SESSION-KEY');
  if (sessionKeys.length > 0) {
    const offered = sessionKeys.map((k) => keyShape(k.attrs.get('METHOD'), k.attrs.get('KEYFORMAT')));
    for (const r of renditions) {
      const used = r.playlist.tags
        .filter((t) => t.name === 'EXT-X-KEY' && (t.attrs.get('METHOD') ?? '').toUpperCase() !== 'NONE')
        .map((t) => keyShape(t.attrs.get('METHOD'), t.attrs.get('KEYFORMAT')));
      const orphan = used.find((shape) => !offered.includes(shape));
      if (orphan !== undefined) {
        add(
          'cross/session-key-mismatch',
          r.line,
          `"${r.uri}" is encrypted with ${orphan} and the master's EXT-X-SESSION-KEY announces ${offered.join(', ')}`,
          'announce the key the renditions actually use, or drop the session key: a player that pre-fetches the wrong one stalls anyway, one request later',
        );
      }
    }
  }

  if (renditions.length < 2) return sortFindings(findings);

  const [reference, ...others] = renditions;
  const ref = reference.playlist;

  for (const r of others) {
    const pl = r.playlist;

    if ((pl.version ?? 1) !== (ref.version ?? 1)) {
      add(
        'cross/version-mismatch',
        r.line,
        `"${r.uri}" declares EXT-X-VERSION ${pl.version ?? 1} but "${reference.uri}" declares ${ref.version ?? 1}`,
        'give every rendition the same version: a player that honours the lower one may refuse tags the other renditions use',
      );
    }

    if (pl.targetDuration !== null && ref.targetDuration !== null && pl.targetDuration !== ref.targetDuration) {
      add(
        'cross/target-duration-mismatch',
        r.line,
        `"${r.uri}" declares EXT-X-TARGETDURATION ${pl.targetDuration} but "${reference.uri}" declares ${ref.targetDuration}`,
        'the renditions should be segmented the same way; players buffer on whichever value they read',
      );
    }

    const refLive = !ref.hasEndList && ref.playlistType !== 'VOD';
    const live = !pl.hasEndList && pl.playlistType !== 'VOD';
    if (refLive !== live) {
      add(
        'cross/playlist-type-mismatch',
        r.line,
        `"${r.uri}" is ${live ? 'still live' : 'finished (EXT-X-ENDLIST)'} while "${reference.uri}" is ${refLive ? 'still live' : 'finished'}`,
        'a rendition that ends before the others strands every player that switches to it',
      );
    } else if (live && (pl.mediaSequence ?? 0) !== (ref.mediaSequence ?? 0)) {
      add(
        'cross/media-sequence-mismatch',
        r.line,
        `"${r.uri}" starts at media sequence ${pl.mediaSequence ?? 0} but "${reference.uri}" starts at ${ref.mediaSequence ?? 0}: the live windows are offset`,
        'publish the same window for every rendition, or a player switching rungs jumps in time',
      );
    }

    if (pl.segments.length !== ref.segments.length) {
      add(
        'cross/segment-count-mismatch',
        r.line,
        `"${r.uri}" has ${pl.segments.length} segments but "${reference.uri}" has ${ref.segments.length}`,
        'renditions of one stream are segmented identically; a different count means a different timeline',
      );
    } else {
      // Same count: compare the boundaries, which is where a switch actually lands.
      let elapsedRef = 0;
      let elapsed = 0;
      for (let i = 0; i < pl.segments.length; i++) {
        elapsedRef += ref.segments[i].duration ?? 0;
        elapsed += pl.segments[i].duration ?? 0;
        const drift = Math.abs(elapsed - elapsedRef);
        if (drift > tolerance) {
          add(
            'cross/timeline-drift',
            r.line,
            `"${r.uri}" and "${reference.uri}" disagree about where segment ${i + 1} ends by ${drift.toFixed(3)}s`,
            'segment the renditions on the same boundaries: a player switching rungs starts the next segment mid-picture',
          );
          break; // one report per rendition: the rest of the drift is the same defect
        }
      }

      const refBreaks = discontinuityIndexes(ref);
      const breaks = discontinuityIndexes(pl);
      if (refBreaks.join(',') !== breaks.join(',')) {
        add(
          'cross/discontinuity-mismatch',
          r.line,
          `"${r.uri}" has discontinuities at segments [${breaks.map((i) => i + 1).join(', ') || 'none'}] but "${reference.uri}" has them at [${refBreaks.map((i) => i + 1).join(', ') || 'none'}]`,
          'ad breaks and encoder restarts have to land on the same segment in every rendition',
        );
      }
    }
  }

  return sortFindings(findings);
}

function discontinuityIndexes(pl: Playlist): number[] {
  const out: number[] = [];
  pl.segments.forEach((s, i) => {
    if (s.discontinuity) out.push(i);
  });
  return out;
}

function sortFindings(findings: Finding[]): Finding[] {
  return findings.sort((a, b) =>
    SEVERITY_RANK[a.severity] !== SEVERITY_RANK[b.severity]
      ? SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
      : a.line - b.line || a.rule.localeCompare(b.rule),
  );
}

/** keyShape names a key by what a player has to understand to use it. */
function keyShape(method: string | undefined, keyFormat: string | undefined): string {
  return `METHOD=${(method ?? '').toUpperCase() || 'none declared'}/KEYFORMAT=${keyFormat ?? 'identity'}`;
}
