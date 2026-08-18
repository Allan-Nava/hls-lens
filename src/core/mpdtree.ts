// The MPD as a tree: periods, adaptation sets, representations.
//
// The rules already read an .mpd; this is the other half of what the extension does
// with a manifest — showing its shape. A DASH manifest is XML, so the shape is there
// in the file, but nested four elements deep and wrapped in attributes: reading a
// ladder out of it by eye is exactly the work this extension exists to remove.
//
// Same split as everything else: the model is here and tested, the TreeItem glue is
// in extension.ts.
import { formatBandwidth } from './ladder';
import { parseIsoDuration } from './dash';
import { layoutRows, TimelineModel, TimelineOptions, TimelineSpan } from './timeline';
import { XmlNode, attr, findAll, parseXml } from './xml';

/** One row of the MPD tree. */
export interface MpdRow {
  label: string;
  /** What goes after the label, dimmed: the numbers a person scans for. */
  description: string;
  /** The whole truth about the row, for the hover. */
  tooltip: string;
  /** 0-based line index of the element that declares it. */
  line: number;
  kind: 'period' | 'adaptation' | 'representation';
  children: MpdRow[];
}

/** buildMpdTree reads the manifest's shape. An .mpd that is not one gives nothing. */
export function buildMpdTree(text: string): MpdRow[] {
  const { root } = parseXml(text);
  if (!root || !/(^|:)MPD$/.test(root.name)) return [];

  return findAll(root, 'Period').map((period, index) => {
    const id = attr(period, 'id') ?? `${index + 1}`;
    const start = parseIsoDuration(attr(period, 'start'));
    const duration = parseIsoDuration(attr(period, 'duration'));
    const sets = findAll(period, 'AdaptationSet').map(adaptationRow);
    return {
      label: `Period ${id}`,
      description: [
        start !== null ? `from ${clock(start)}` : '',
        duration !== null ? clock(duration) : '',
        `${sets.length} adaptation set${sets.length === 1 ? '' : 's'}`,
      ]
        .filter(Boolean)
        .join(' · '),
      tooltip: `Period ${id}${attr(period, 'start') ? ` starting at ${attr(period, 'start')}` : ''}`,
      line: period.line,
      kind: 'period' as const,
      children: sets,
    };
  });
}

/**
 * mpdSummary is the one line the status bar shows: what kind of manifest this is and
 * how much of it there is.
 */
export function mpdSummary(text: string): string {
  const { root } = parseXml(text);
  if (!root || !/(^|:)MPD$/.test(root.name)) return 'not a DASH manifest';

  const periods = findAll(root, 'Period');
  const sets = findAll(root, 'AdaptationSet');
  const representations = findAll(root, 'Representation');
  const duration = parseIsoDuration(attr(root, 'mediaPresentationDuration'));
  return [
    attr(root, 'type') === 'dynamic' ? 'dynamic' : 'static',
    `${periods.length} period${periods.length === 1 ? '' : 's'}`,
    `${sets.length} adaptation set${sets.length === 1 ? '' : 's'}`,
    `${representations.length} representation${representations.length === 1 ? '' : 's'}`,
    // A dynamic manifest has no total duration to state, and states none.
    duration !== null ? clock(duration) : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function adaptationRow(set: XmlNode): MpdRow {
  const representations = findAll(set, 'Representation').map((rep) => representationRow(rep, set));
  const label = attr(set, 'contentType') ?? (attr(set, 'mimeType') ?? '').split('/')[0] ?? '';
  const language = attr(set, 'lang');
  return {
    label: label || `AdaptationSet ${attr(set, 'id') ?? ''}`.trim(),
    description: [
      language ?? '',
      `${representations.length} representation${representations.length === 1 ? '' : 's'}`,
      // Whether a player may switch inside the set is the question an adaptation set
      // exists to answer, so it belongs on the row rather than in the hover.
      attr(set, 'segmentAlignment') === 'true' ? 'aligned' : 'not aligned',
    ]
      .filter(Boolean)
      .join(' · '),
    tooltip: [`AdaptationSet ${attr(set, 'id') ?? ''}`.trim(), attr(set, 'mimeType') ?? '', attr(set, 'codecs') ?? '']
      .filter(Boolean)
      .join('\n'),
    line: set.line,
    kind: 'adaptation',
    children: representations,
  };
}

function representationRow(rep: XmlNode, set: XmlNode): MpdRow {
  const height = attr(rep, 'height');
  const width = attr(rep, 'width');
  const bandwidth = Number.parseInt(attr(rep, 'bandwidth') ?? '', 10);
  const codecs = attr(rep, 'codecs') ?? attr(set, 'codecs') ?? '';
  return {
    label: attr(rep, 'id') ?? (height ? `${height}p` : `line ${rep.line + 1}`),
    description: [
      Number.isFinite(bandwidth) ? formatBandwidth(bandwidth) : '',
      width && height ? `${width}x${height}` : '',
      attr(rep, 'frameRate') ? `${attr(rep, 'frameRate')} fps` : '',
    ]
      .filter(Boolean)
      .join(' · '),
    tooltip: [`Representation ${attr(rep, 'id') ?? ''}`.trim(), codecs, attr(rep, 'audioSamplingRate') ? `${attr(rep, 'audioSamplingRate')} Hz` : '']
      .filter(Boolean)
      .join('\n'),
    line: rep.line,
    kind: 'representation',
    children: [],
  };
}

/** clock writes seconds the way a person reads a running time. */
function clock(seconds: number): string {
  const whole = Math.round(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  const pad = (value: number): string => (value < 10 ? `0${value}` : `${value}`);
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

/**
 * buildMpdTimeline draws an MPD the way the timeline draws a playlist: one row per
 * track, the segments in a row, the period boundaries marked as discontinuities —
 * because that is what they are, and crossing one is where a decoder gets
 * reconfigured.
 *
 * A <SegmentTimeline> is already a list of durations, so the layout, the axis and the
 * out-of-step detection are the same code the HLS timeline uses. An MPD that lists no
 * segments at all draws nothing: @duration with @startNumber and no timeline describes
 * a segment count this cannot know without the presentation duration, and a strip with
 * a guessed number of segments in it is a picture that lies.
 */
export function buildMpdTimeline(text: string, options: TimelineOptions = {}): TimelineModel {
  const { root } = parseXml(text);
  if (!root || !/(^|:)MPD$/.test(root.name)) return layoutRows([], options);

  const tracks = new Map<string, TimelineSpan[]>();
  const ends = new Map<string, number>();

  for (const period of findAll(root, 'Period')) {
    const declaredStart = parseIsoDuration(attr(period, 'start'));
    for (const set of findAll(period, 'AdaptationSet')) {
      const label = trackLabel(set);
      const spans = tracks.get(label) ?? [];
      if (!tracks.has(label)) tracks.set(label, spans);

      // A period starts where it says it does, and otherwise where this track left off.
      let at = declaredStart ?? ends.get(label) ?? 0;
      let first = true;
      for (const template of findAll(set, 'SegmentTemplate')) {
        const timescale = Number.parseFloat(attr(template, 'timescale') ?? '1') || 1;
        for (const timeline of findAll(template, 'SegmentTimeline')) {
          for (const s of timeline.children.filter((child) => child.name === 'S' || child.name.endsWith(':S'))) {
            const duration = Number.parseFloat(attr(s, 'd') ?? '');
            if (!Number.isFinite(duration)) continue;
            const repeat = Number.parseInt(attr(s, 'r') ?? '0', 10) || 0;
            // A negative @r means "until the period ends", which has no count here.
            const count = repeat >= 0 ? repeat + 1 : 1;
            for (let i = 0; i < count; i++) {
              spans.push({
                index: spans.length,
                uri: attr(template, 'media') ?? '',
                start: round(at),
                duration: round(duration / timescale),
                // Only the first segment of a period that is not the first period.
                discontinuity: first && spans.length > 0,
                gap: false,
                ad: false,
                line: s.line,
              });
              at += duration / timescale;
              first = false;
            }
          }
        }
      }
      ends.set(label, at);
    }
  }

  return layoutRows(
    [...tracks.entries()].filter(([, spans]) => spans.length > 0).map(([label, spans]) => ({ label, spans })),
    options,
  );
}

/** One URL found in an MPD, with the range that should be underlined. */
export interface MpdLink {
  uri: string;
  /** 0-based line. */
  line: number;
  /** Column range of the URL within that line. */
  start: number;
  end: number;
}

/** The attributes of an MPD that hold a URL rather than a template. */
const LINK_ATTRIBUTES = ['initialization', 'sourceURL', 'value'];

/**
 * mpdLinks finds the URLs in an MPD.
 *
 * This one reads the text rather than the parsed tree, because a document link is a
 * *range* and the parser keeps lines, not columns. The cost is that a <BaseURL> split
 * across lines is not found; the alternative — teaching the XML reader to record
 * column spans for every attribute — is a great deal of machinery for underlining a
 * URL.
 *
 * Templates are deliberately skipped: nothing here resolves $Number$, so offering a
 * link to `chunk-$Number$.m4s` would be offering a request that cannot be made.
 */
export function mpdLinks(text: string): MpdLink[] {
  const links: MpdLink[] = [];
  const lines = text.split('\n');

  lines.forEach((line, index) => {
    const base = /<BaseURL[^>]*>([^<]+)<\/BaseURL>/.exec(line);
    if (base) {
      const uri = base[1].trim();
      const start = line.indexOf(uri);
      if (uri && !uri.includes('$')) links.push({ uri, line: index, start, end: start + uri.length });
    }

    for (const attribute of LINK_ATTRIBUTES) {
      const pattern = new RegExp(`${attribute}\\s*=\\s*"([^"]*)"`, 'g');
      for (let match = pattern.exec(line); match !== null; match = pattern.exec(line)) {
        const uri = match[1].trim();
        if (!uri || uri.includes('$') || !looksLikeLocation(uri)) continue;
        const start = line.indexOf(match[1], match.index);
        links.push({ uri, line: index, start, end: start + match[1].length });
      }
    }
  });
  return links;
}

/**
 * A URL or a path, and not one of the many attribute values that are neither — a
 * scheme id like `urn:mpeg:dash:utc:direct:2014` is a name, not somewhere to go.
 */
function looksLikeLocation(value: string): boolean {
  if (value.startsWith('urn:')) return false;
  return /^https?:\/\//.test(value) || /^[^:]*[./][^:]*$/.test(value);
}

function trackLabel(set: XmlNode): string {
  const label = attr(set, 'contentType') ?? (attr(set, 'mimeType') ?? '').split('/')[0] ?? '';
  return label || `AdaptationSet ${attr(set, 'id') ?? ''}`.trim();
}

function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}
