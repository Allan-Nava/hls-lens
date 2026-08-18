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
