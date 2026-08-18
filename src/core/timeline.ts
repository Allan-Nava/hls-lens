// The timeline: a media playlist as a strip, and several renditions stacked on one
// axis so that what they disagree about is visible instead of computed.
//
// The rules in analyze.ts and crosscheck.ts say *that* boundaries drift; a picture
// says where, and how much, and whether the drift is one segment or all of them.
// That is the only reason this exists — everything here is derived from the same
// parsed playlists the rules read.
//
// The whole page is rendered here, as a string, so the webview glue in
// extension.ts has nothing to decide: it creates a panel, sets the html and turns a
// click back into a line to reveal. Rendering is a pure function of the model, which
// is how a webview ends up with tests.
import { Playlist } from './playlist';

/** One playlist to draw, with the name to put in front of its strip. */
export interface TimelineTrack {
  label: string;
  playlist: Playlist;
}

/** One segment as a bar. */
export interface TimelineSpan {
  /** Index within its own playlist. */
  index: number;
  uri: string;
  /** Seconds from the start of the track. */
  start: number;
  duration: number;
  /** An EXT-X-DISCONTINUITY precedes this segment. */
  discontinuity: boolean;
  /** The segment is marked EXT-X-GAP: the packager published a hole. */
  gap: boolean;
  /** The segment falls inside an ad break an EXT-X-DATERANGE declares. */
  ad: boolean;
  /** 0-based line index of the EXTINF, for the click that reveals it. */
  line: number;
}

/** One track, laid out. */
export interface TimelineRow {
  label: string;
  spans: TimelineSpan[];
  duration: number;
  /** Every boundary of this row is shared by every other row. */
  aligned: boolean;
}

/** What the page draws. */
export interface TimelineModel {
  rows: TimelineRow[];
  /** The longest track: how much stream there is, whatever is being drawn. */
  duration: number;
  /** The window actually drawn. Without a range it is the whole thing. */
  from: number;
  to: number;
  ticks: number[];
  /** Boundary times that not every row has — the drift, in seconds. */
  misaligned: number[];
  /**
   * Where the stream currently ends, when it has not ended: the point a live player
   * is chasing. Null for a finished asset, which has an end rather than an edge.
   */
  liveEdge: number | null;
}

/** Options for one layout. */
export interface TimelineOptions {
  /** Two boundaries this close are the same boundary. */
  toleranceS?: number;
  /** Draw only this window. A live window of hundreds of segments is unreadable whole. */
  range?: { from: number; to: number };
  /** Where the stream ends while it is still going. */
  liveEdge?: number | null;
}

/** How far apart two boundaries may be and still count as the same one. */
const DEFAULT_TOLERANCE_S = 0.05;

/** The steps the axis is allowed to use, in seconds. */
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];

/** buildTimeline lays out one or more playlists on a shared axis. */
export function buildTimeline(tracks: TimelineTrack[], options: TimelineOptions = {}): TimelineModel {
  const rows = tracks.map((track) => ({ label: track.label, spans: layout(track.playlist) }));
  // A playlist with no EXT-X-ENDLIST has not ended: where it stops is the live edge a
  // player is chasing, which is a different thing from where an asset finishes.
  const live = tracks.some((track) => !track.playlist.hasEndList && track.playlist.segments.length > 0);
  return layoutRows(rows, { ...options, liveEdge: options.liveEdge ?? (live ? null : undefined) });
}

/**
 * layoutRows is the half of the timeline that has nothing to do with HLS: given rows
 * of spans it computes the axis, the ticks and which rows are out of step. DASH feeds
 * it too (see mpdtree.ts) — a <SegmentTimeline> is a list of durations, which is all
 * this needs.
 */
export function layoutRows(tracks: Array<{ label: string; spans: TimelineSpan[] }>, options: TimelineOptions = {}): TimelineModel {
  const tolerance = options.toleranceS ?? DEFAULT_TOLERANCE_S;

  const rows: TimelineRow[] = tracks.map((track) => {
    const spans = track.spans;
    return {
      label: track.label,
      spans,
      duration: spans.length === 0 ? 0 : round(spans[spans.length - 1].start + spans[spans.length - 1].duration),
      aligned: true,
    };
  });

  const duration = rows.reduce((longest, row) => Math.max(longest, row.duration), 0);

  // Boundaries, clustered: a cluster every row appears in is a boundary a player can
  // switch at. Anything else is drift, and it is what the picture is for.
  const marks: Array<{ at: number; row: number }> = [];
  rows.forEach((row, index) => {
    for (const span of row.spans) {
      if (span.start > 0) marks.push({ at: span.start, row: index });
    }
    if (row.duration > 0) marks.push({ at: row.duration, row: index });
  });
  marks.sort((a, b) => a.at - b.at);

  const misaligned: number[] = [];
  const offRows = new Set<number>();
  for (let i = 0; i < marks.length; ) {
    const at = marks[i].at;
    const cluster = new Set<number>();
    let j = i;
    while (j < marks.length && marks[j].at - at <= tolerance) {
      cluster.add(marks[j].row);
      j++;
    }
    if (cluster.size < rows.length) {
      misaligned.push(at);
      // The rows to blame are the minority: with one rung out of five it is that rung
      // that is out of step, not the four that agree. Read from whichever side is
      // smaller, so a boundary only one rung has and a boundary only one rung lacks
      // both name the same single rung.
      const odd =
        cluster.size * 2 <= rows.length
          ? [...cluster]
          : rows.map((_row, index) => index).filter((index) => !cluster.has(index));
      for (const index of odd) offRows.add(index);
    }
    i = j;
  }
  for (const index of offRows) rows[index].aligned = false;

  const from = options.range ? Math.max(0, options.range.from) : 0;
  const to = options.range ? Math.min(options.range.to, Math.max(duration, options.range.to)) : duration;
  if (options.range) {
    // Keep the spans the window covers, and the ones straddling its edges: a segment
    // half in view is still what a viewer is watching.
    for (const row of rows) row.spans = row.spans.filter((span) => span.start < to && span.start + span.duration > from);
  }

  const liveEdge = options.liveEdge === undefined ? null : (options.liveEdge ?? duration);
  return {
    rows,
    duration,
    from,
    to,
    ticks: niceTicks(to - from).map((tick) => round(tick + from)),
    misaligned,
    liveEdge,
  };
}

/**
 * niceTicks picks an axis a person can read: the smallest round step that keeps the
 * number of ticks near `target`. A tick every 6.4 seconds is arithmetically fine and
 * nobody can use it.
 */
export function niceTicks(duration: number, target = 8): number[] {
  if (!(duration > 0)) return [0];
  const step = TICK_STEPS.find((candidate) => duration / candidate <= target) ?? TICK_STEPS[TICK_STEPS.length - 1];
  const ticks: number[] = [];
  for (let at = 0; at <= duration + 1e-9; at += step) ticks.push(round(at));
  return ticks;
}

/** layout turns the segments of one playlist into bars, with the ad breaks marked. */
function layout(pl: Playlist): TimelineSpan[] {
  const spans: TimelineSpan[] = [];
  let at = 0;
  for (const [index, segment] of pl.segments.entries()) {
    const duration = segment.duration ?? 0;
    spans.push({
      index,
      uri: segment.uri,
      start: round(at),
      duration: round(duration),
      discontinuity: segment.discontinuity,
      gap: segment.gap,
      ad: false,
      line: segment.extinfLine,
    });
    at += duration;
  }

  for (const window of adWindows(pl, spans)) {
    for (const span of spans) {
      const end = span.start + span.duration;
      const covered =
        window.end > window.start ? span.start < window.end && end > window.start : span.start <= window.start && window.start < end;
      if (covered) span.ad = true;
    }
  }
  return spans;
}

/**
 * adWindows converts the ad breaks an EXT-X-DATERANGE declares into media time.
 *
 * A DATERANGE is anchored to the wall clock, so without an EXT-X-PROGRAM-DATE-TIME
 * to tie the media timeline to it there is nothing to convert — and a guessed ad
 * break in a picture is worse than none, because it looks like a fact.
 */
function adWindows(pl: Playlist, spans: TimelineSpan[]): Array<{ start: number; end: number }> {
  const ranges = pl.tags.filter((t) => t.name === 'EXT-X-DATERANGE');
  if (ranges.length === 0) return [];

  let zero: number | null = null;
  for (const span of spans) {
    const segment = pl.segments[span.index];
    if (!segment.programDateTime) continue;
    const at = Date.parse(segment.programDateTime);
    if (Number.isNaN(at)) continue;
    zero = at - span.start * 1000;
    break;
  }
  if (zero === null) return [];

  const windows: Array<{ start: number; end: number }> = [];
  for (const tag of ranges) {
    const cls = tag.attrs.get('CLASS') ?? '';
    const isAd = tag.attrs.has('SCTE35-OUT') || /(^|[.-])ad([s.-]|$)/i.test(cls) || /\bad\b/i.test(cls);
    if (!isAd) continue;
    const start = Date.parse(tag.attrs.get('START-DATE') ?? '');
    if (Number.isNaN(start)) continue;
    const declared = Number.parseFloat(tag.attrs.get('DURATION') ?? '');
    const endDate = Date.parse(tag.attrs.get('END-DATE') ?? '');
    const from = round((start - zero) / 1000);
    const to = Number.isFinite(declared) ? round(from + declared) : Number.isNaN(endDate) ? from : round((endDate - zero) / 1000);
    windows.push({ start: from, end: to });
  }
  return windows;
}

/** Options for one page. */
export interface RenderOptions {
  /** What the panel is about: normally the manifest's name or URL. */
  title: string;
  /** The nonce the webview's script is allowed to run under. */
  nonce: string;
}

/** renderTimelineHtml renders the whole page, deterministically. */
export function renderTimelineHtml(model: TimelineModel, options: RenderOptions): string {
  // Percentages are against the window being drawn, which is the whole stream unless
  // a range was asked for.
  const span = model.to - model.from;
  const pct = (seconds: number): string => (span > 0 ? (((seconds - model.from) / span) * 100).toFixed(4) : '0.0000');
  const width = (seconds: number): string => (span > 0 ? ((seconds / span) * 100).toFixed(4) : '0.0000');

  const rows = model.rows
    .map((row) => {
      const bars = row.spans
        .map((span) => {
          const classes = ['seg'];
          if (span.discontinuity) classes.push('disc');
          if (span.gap) classes.push('gap');
          if (span.ad) classes.push('ad');
          const marks = [span.discontinuity ? 'discontinuity' : '', span.gap ? 'EXT-X-GAP' : '', span.ad ? 'ad break' : '']
            .filter(Boolean)
            .join(', ');
          const tooltip = `#${span.index} ${span.uri} · ${span.duration}s at ${span.start}s${marks ? ` · ${marks}` : ''}`;
          return (
            `<button class="${classes.join(' ')}" style="left:${pct(span.start)}%;width:${width(span.duration)}%" ` +
            `data-line="${span.line}" title="${escape(tooltip)}" aria-label="${escape(tooltip)}"><span>${escape(span.uri)}</span></button>`
          );
        })
        .join('');
      const state = row.aligned ? '' : ' <span class="warn">out of step</span>';
      return (
        `<div class="track">\n  <div class="label">${escape(row.label)}<span class="dim">${row.spans.length} seg · ${row.duration}s</span>${state}</div>\n` +
        `  <div class="bars">${bars}</div>\n</div>`
      );
    })
    .join('\n');

  const ticks = model.ticks
    .map((at) => `<span class="tick" style="left:${pct(at)}%">${formatClock(at)}</span>`)
    .join('');
  const drift = model.misaligned
    .map((at) => `<span class="drift" style="left:${pct(at)}%" title="boundary at ${at}s is not in every rendition"></span>`)
    .join('');

  const edge =
    model.liveEdge === null
      ? ''
      : `<span class="edge" style="left:${pct(model.liveEdge)}%" title="live edge at ${model.liveEdge}s"></span>`;

  const summary = [
    `${model.rows.length} ${model.rows.length === 1 ? 'rendition' : 'renditions'}`,
    model.from > 0 || model.to < model.duration ? `${model.from}s–${model.to}s of ${model.duration}s` : `${model.duration}s`,
    model.liveEdge === null ? '' : 'live',
    model.misaligned.length === 0 ? 'boundaries aligned' : `${model.misaligned.length} unshared boundar${model.misaligned.length === 1 ? 'y' : 'ies'}`,
  ].join(' · ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${escape(options.nonce)}';">
<title>${escape(options.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header><strong>${escape(options.title)}</strong><span class="dim">${summary}</span></header>
<div class="chart">
  <div class="axis">${ticks}</div>
  <div class="tracks">
${rows}
    <div class="drifts">${drift}${edge}</div>
  </div>
</div>
<footer>
  <span class="key seg"></span> segment
  <span class="key disc"></span> discontinuity
  <span class="key gap"></span> EXT-X-GAP
  <span class="key ad"></span> ad break
  <span class="key drift-key"></span> boundary not in every rendition
  <span class="key edge-key"></span> live edge
  <span class="dim">click a segment to reveal its line</span>
</footer>
<script nonce="${escape(options.nonce)}">
const api = acquireVsCodeApi();
for (const bar of document.querySelectorAll('button.seg')) {
  bar.addEventListener('click', () => api.postMessage({ type: 'reveal', line: Number(bar.dataset.line) }));
}
</script>
</body>
</html>
`;
}

/** The stylesheet: the editor's own colours, so the panel belongs to the theme. */
const STYLE = `
body{margin:0;padding:0 0 1rem;font:13px/1.5 var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background)}
header{display:flex;gap:.75rem;align-items:baseline;padding:.75rem 1rem;border-bottom:1px solid var(--vscode-panel-border)}
.dim{color:var(--vscode-descriptionForeground)}
.warn{color:var(--vscode-editorWarning-foreground)}
.chart{padding:1rem}
.axis{position:relative;height:1.25rem;margin-left:9rem;border-bottom:1px solid var(--vscode-panel-border)}
.tick{position:absolute;transform:translateX(-50%);font-size:11px;color:var(--vscode-descriptionForeground);white-space:nowrap}
.tracks{position:relative}
.track{display:flex;align-items:center;gap:.5rem;margin:.35rem 0}
.label{width:9rem;flex:none;display:flex;flex-direction:column;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.label .dim{font-size:11px}
.bars{position:relative;flex:1;height:1.6rem}
button.seg{position:absolute;top:0;height:100%;margin:0;padding:0 .2rem;overflow:hidden;text-align:left;font:inherit;font-size:10px;color:var(--vscode-button-foreground);background:var(--vscode-charts-blue);border:0;border-radius:2px;box-shadow:inset -1px 0 0 var(--vscode-editor-background);cursor:pointer;white-space:nowrap}
button.seg span{opacity:.85}
button.seg:hover{outline:1px solid var(--vscode-focusBorder)}
button.seg.disc{box-shadow:inset -1px 0 0 var(--vscode-editor-background),inset 3px 0 0 var(--vscode-charts-orange)}
button.seg.gap{background:repeating-linear-gradient(45deg,var(--vscode-charts-red) 0 4px,transparent 4px 8px);color:var(--vscode-foreground)}
button.seg.ad{background:var(--vscode-charts-purple)}
.drifts{position:absolute;inset:0;margin-left:9.5rem;pointer-events:none}
.drift{position:absolute;top:0;bottom:0;width:0;border-left:1px dashed var(--vscode-charts-yellow)}
.edge{position:absolute;top:0;bottom:0;width:0;border-left:2px solid var(--vscode-charts-green)}
footer{display:flex;gap:.4rem;align-items:center;flex-wrap:wrap;padding:0 1rem;color:var(--vscode-descriptionForeground)}
.key{display:inline-block;width:.8rem;height:.8rem;border-radius:2px;background:var(--vscode-charts-blue)}
.key.disc{background:var(--vscode-charts-orange)}
.key.gap{background:repeating-linear-gradient(45deg,var(--vscode-charts-red) 0 3px,transparent 3px 6px)}
.key.ad{background:var(--vscode-charts-purple)}
.key.drift-key{width:0;border-left:1px dashed var(--vscode-charts-yellow);border-radius:0}
.key.edge-key{width:0;border-left:2px solid var(--vscode-charts-green);border-radius:0}
footer .dim{margin-left:auto}
`.trim();

/** formatClock writes an axis label: seconds under a minute, m:ss above it. */
function formatClock(seconds: number): string {
  if (seconds < 60) return `${round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = round(seconds - minutes * 60);
  return `${minutes}:${rest < 10 ? '0' : ''}${rest}`;
}

/**
 * escape covers text and attributes both, quotes included: a segment URI goes into
 * a title attribute, and one unescaped quote there is an injection into the page.
 */
function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}
