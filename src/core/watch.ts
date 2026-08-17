// Watching a live playlist: what changed between two reloads.
//
// A live manifest is only interesting over time. The defects it hides — a window
// that stopped sliding, a discontinuity that appeared, a stream that ended without
// anyone saying so — are all differences between two snapshots, and none of them are
// visible in either snapshot alone.
//
// The comparison is pure: no clock, no timer, no network. The glue polls and hands
// two playlists in; how long to wait between polls is watchIntervalMs, which reads
// the manifest's own target duration rather than a number someone guessed.
import { Playlist, Segment } from './playlist';

/** What changed between two reloads of the same playlist. */
export interface PlaylistChange {
  /** Segments that were not in the previous window. */
  added: Segment[];
  /** How many segments slid off the front. */
  droppedFromFront: number;
  /** How far EXT-X-MEDIA-SEQUENCE advanced. */
  mediaSequenceAdvance: number;
  /** URIs of new segments that carry an EXT-X-DISCONTINUITY. */
  discontinuities: string[];
  /** The playlist gained an EXT-X-ENDLIST: the stream is over. */
  endedNow: boolean;
  /** Nothing moved: no new segments, no sequence advance, and no ending. */
  stalled: boolean;
}

/** Never poll faster than this, whatever the manifest declares. */
const MIN_INTERVAL_MS = 2000;
/** What to use when the playlist declares no target duration. */
const FALLBACK_INTERVAL_MS = 6000;

/**
 * diffPlaylists compares two reloads of one playlist.
 *
 * Segments are matched by URI rather than by index: the index of a segment changes
 * every time the window slides, and a packager that renumbers is exactly the case
 * where the naive comparison reports everything as new.
 */
export function diffPlaylists(before: Playlist, after: Playlist): PlaylistChange {
  const known = new Set(before.segments.map((s) => s.uri));
  const added = after.segments.filter((s) => !known.has(s.uri));

  const stillPresent = new Set(after.segments.map((s) => s.uri));
  let droppedFromFront = 0;
  for (const s of before.segments) {
    if (stillPresent.has(s.uri)) break; // the window slides off the front, in order
    droppedFromFront++;
  }

  const mediaSequenceAdvance = (after.mediaSequence ?? 0) - (before.mediaSequence ?? 0);
  const endedNow = after.hasEndList && !before.hasEndList;

  return {
    added,
    droppedFromFront,
    mediaSequenceAdvance,
    discontinuities: added.filter((s) => s.discontinuity).map((s) => s.uri),
    endedNow,
    stalled: added.length === 0 && mediaSequenceAdvance === 0 && !endedNow,
  };
}

/** describeChange renders one line for the output channel or a notification. */
export function describeChange(change: PlaylistChange): string {
  if (change.endedNow) return 'the playlist gained EXT-X-ENDLIST: the stream ended';
  if (change.stalled) return 'the window did not move: no new segments and no media sequence advance';

  const parts: string[] = [];
  if (change.added.length > 0) {
    const names = change.added.map((s) => s.uri);
    const shown = names.slice(0, 3).join(', ');
    parts.push(`${change.added.length} new segment${change.added.length === 1 ? '' : 's'} (${shown}${names.length > 3 ? ', …' : ''})`);
  }
  if (change.droppedFromFront > 0) parts.push(`${change.droppedFromFront} dropped from the front`);
  if (change.discontinuities.length > 0) parts.push(`discontinuity at ${change.discontinuities.join(', ')}`);
  if (parts.length === 0) parts.push(`media sequence advanced by ${change.mediaSequenceAdvance}`);
  return parts.join(' · ');
}

/**
 * watchIntervalMs is how long to wait before reloading: the target duration, which is
 * what the manifest itself says a segment lasts, unless the operator set an interval.
 * Floored at two seconds so a low-latency playlist declaring one does not turn the
 * watch into a load test on someone's edge.
 */
export function watchIntervalMs(pl: Playlist, configuredSeconds: number): number {
  if (configuredSeconds > 0) return Math.max(MIN_INTERVAL_MS, configuredSeconds * 1000);
  if (pl.targetDuration === null || pl.targetDuration <= 0) return FALLBACK_INTERVAL_MS;
  return Math.max(MIN_INTERVAL_MS, pl.targetDuration * 1000);
}
