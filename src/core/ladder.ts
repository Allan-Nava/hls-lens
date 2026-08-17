// The ABR ladder as a list of rows: what the tree view shows, and the one-line
// summary that goes in the status bar.
//
// Pure model, no vscode types, so the shape of the tree is testable.
import { Playlist } from './playlist';
import { Resolution } from './attrs';

/** One row of the tree: a variant stream or an alternate rendition. */
export interface LadderRow {
  kind: 'variant' | 'rendition';
  /** Short label: "1080p", "128 kbps", "English (en)". */
  label: string;
  /** One line of detail shown next to the label. */
  description: string;
  /** Markdown tooltip with everything the manifest declares. */
  tooltip: string;
  /** URI as written in the manifest (still relative), or '' when there is none. */
  uri: string;
  /** 0-based line index to reveal when the row is clicked. */
  line: number;
  bandwidthBps: number | null;
  resolution: Resolution | null;
  codecs: string[];
  frameRate: number | null;
  audioGroup: string | null;
  iframeOnly: boolean;
}

/** formatBandwidth renders bits per second the way a ladder is discussed. */
export function formatBandwidth(bps: number | null): string {
  if (bps === null) return 'no BANDWIDTH';
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(2)} Mbps`;
  if (bps >= 1_000) return `${Math.round(bps / 1_000)} kbps`;
  return `${bps} bps`;
}

/** formatResolution renders WxH with a real multiplication sign. */
export function formatResolution(r: Resolution | null): string {
  return r === null ? '' : `${r.width}×${r.height}`;
}

/** rungLabel names a rung by its height, falling back to its bitrate. */
function rungLabel(resolution: Resolution | null, bandwidth: number | null): string {
  if (resolution) return `${resolution.height}p`;
  return formatBandwidth(bandwidth);
}

/**
 * buildLadder returns the variants in ascending bitrate, with the I-frame streams
 * last: they are trick play, not a rung, and mixing them into the ladder makes the
 * ladder look wrong.
 */
export function buildLadder(pl: Playlist): LadderRow[] {
  const rows = pl.variants.map<LadderRow>((v) => {
    const details = [formatBandwidth(v.bandwidth), formatResolution(v.resolution), v.frameRate ? `${v.frameRate}fps` : ''].filter(
      (s) => s.length > 0,
    );
    const tooltipLines = [
      `**${rungLabel(v.resolution, v.bandwidth)}**${v.iframeOnly ? ' · I-frame only (trick play)' : ''}`,
      `- BANDWIDTH: ${v.bandwidth === null ? '—' : v.bandwidth}`,
      `- AVERAGE-BANDWIDTH: ${v.averageBandwidth === null ? '—' : v.averageBandwidth}`,
      `- RESOLUTION: ${formatResolution(v.resolution) || '—'}`,
      `- FRAME-RATE: ${v.frameRate ?? '—'}`,
      `- CODECS: ${v.codecs.length ? v.codecs.join(', ') : '—'}`,
      `- AUDIO: ${v.audio ?? '—'}`,
      `- SUBTITLES: ${v.subtitles ?? '—'}`,
      `- URI: ${v.uri || '—'}`,
    ];
    return {
      kind: 'variant',
      label: rungLabel(v.resolution, v.bandwidth),
      description: details.join(' · ') + (v.iframeOnly ? ' · I-frame' : ''),
      tooltip: tooltipLines.join('\n'),
      uri: v.uri,
      line: v.line,
      bandwidthBps: v.bandwidth,
      resolution: v.resolution,
      codecs: v.codecs,
      frameRate: v.frameRate,
      audioGroup: v.audio,
      iframeOnly: v.iframeOnly,
    };
  });

  return rows.sort((a, b) => {
    if (a.iframeOnly !== b.iframeOnly) return a.iframeOnly ? 1 : -1;
    return (a.bandwidthBps ?? 0) - (b.bandwidthBps ?? 0);
  });
}

/** renditionRows lists the alternate audio, subtitle and caption tracks. */
export function renditionRows(pl: Playlist): LadderRow[] {
  return pl.renditions.map<LadderRow>((r) => {
    const label = r.language ? `${r.name || r.groupId} (${r.language})` : r.name || r.groupId;
    const details = [
      r.type,
      r.groupId,
      r.isDefault ? 'default' : '',
      r.autoselect ? 'autoselect' : '',
      r.forced ? 'forced' : '',
      r.channels ? `${r.channels}ch` : '',
    ].filter((s) => s.length > 0);
    const tooltip = [
      `**${label}**`,
      `- TYPE: ${r.type}`,
      `- GROUP-ID: ${r.groupId}`,
      `- LANGUAGE: ${r.language ?? '—'}`,
      `- DEFAULT: ${r.isDefault ? 'YES' : 'NO'}`,
      `- AUTOSELECT: ${r.autoselect ? 'YES' : 'NO'}`,
      `- FORCED: ${r.forced ? 'YES' : 'NO'}`,
      `- CHANNELS: ${r.channels ?? '—'}`,
      `- URI: ${r.uri ?? '— (in the variant stream)'}`,
    ].join('\n');
    return {
      kind: 'rendition',
      label,
      description: details.join(' · '),
      tooltip,
      uri: r.uri ?? '',
      line: r.line,
      bandwidthBps: null,
      resolution: null,
      codecs: [],
      frameRate: null,
      audioGroup: r.groupId,
      iframeOnly: false,
    };
  });
}

/** ladderSummary states what the manifest is, in one line. */
export function ladderSummary(pl: Playlist): string {
  if (pl.kind === 'master' || pl.kind === 'mixed') {
    const rungs = buildLadder(pl).filter((r) => !r.iframeOnly);
    if (rungs.length === 0) return 'master playlist, no variants';
    const heights = rungs.filter((r) => r.resolution).map((r) => r.resolution!.height);
    const bitrates = rungs.filter((r) => r.bandwidthBps !== null).map((r) => r.bandwidthBps!);
    const parts = [`${rungs.length} variants`];
    if (heights.length > 0) {
      const low = Math.min(...heights);
      const high = Math.max(...heights);
      parts.push(low === high ? `${low}p` : `${low}p→${high}p`);
    }
    if (bitrates.length > 0) {
      parts.push(`${formatBandwidth(Math.min(...bitrates))}–${formatBandwidth(Math.max(...bitrates))}`);
    }
    if (pl.renditions.length > 0) parts.push(`${pl.renditions.length} alternate renditions`);
    return parts.join(' · ');
  }
  if (pl.kind === 'media') {
    const parts = [`${pl.segments.length} segments`, `${pl.totalDuration.toFixed(1)}s`];
    parts.push(pl.hasEndList || pl.playlistType === 'VOD' ? 'VOD' : 'live');
    if (pl.targetDuration !== null) parts.push(`target ${pl.targetDuration}s`);
    if (pl.partCount > 0) parts.push(`${pl.partCount} parts`);
    return parts.join(' · ');
  }
  return 'not an HLS playlist';
}
