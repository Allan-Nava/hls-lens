// The DASH vocabulary, as data — the counterpart of spec.ts for MPDs.
//
// The hover over an HLS tag exists because a manifest is written far from the
// specification that defines it, and that is more true of DASH, not less: the
// interesting facts sit on attributes of elements four levels deep, and half of them
// are optional in a way that changes what the rest mean.
//
// It is deliberately not the whole of ISO/IEC 23009-1. It covers what the tree, the
// rules and the timeline of this extension read — a test asserts exactly that, so the
// reference cannot have a hole where the reader is looking.

/** One attribute of one element. */
export interface DashAttribute {
  name: string;
  summary: string;
  required?: boolean;
  values?: string[];
}

/** One element of the manifest. */
export interface DashElement {
  name: string;
  summary: string;
  attributes: DashAttribute[];
}

const ELEMENTS: DashElement[] = [
  {
    name: 'MPD',
    summary: 'The manifest itself: what kind of presentation this is and how long it lasts.',
    attributes: [
      { name: 'type', summary: 'static for an asset that is finished, dynamic for a live presentation.', values: ['static', 'dynamic'] },
      { name: 'mediaPresentationDuration', summary: 'Total duration, as an ISO 8601 duration. Required for a static presentation.' },
      { name: 'minimumUpdatePeriod', summary: 'How often a player should re-fetch the manifest of a dynamic presentation.' },
      { name: 'availabilityStartTime', summary: 'The wall-clock zero of a dynamic presentation: segment availability is computed from it.' },
      { name: 'profiles', summary: 'The DASH profiles this manifest conforms to.', required: true },
      { name: 'publishTime', summary: 'When this version of the manifest was produced.' },
    ],
  },
  {
    name: 'Period',
    summary: 'A stretch of the presentation with its own set of tracks. Periods run back to back, and a boundary is where the content can change entirely.',
    attributes: [
      { name: 'id', summary: 'Identifies the period; what a player uses to tell one from another across manifest updates.' },
      { name: 'start', summary: 'Where the period begins, as an ISO 8601 duration from the start of the presentation.' },
      { name: 'duration', summary: 'How long the period lasts.' },
    ],
  },
  {
    name: 'AdaptationSet',
    summary: 'One track — a video, an audio language, a subtitle — holding the representations a player may switch between freely.',
    attributes: [
      { name: 'id', summary: 'Identifies the set within its period.' },
      { name: 'contentType', summary: 'What the track carries.', values: ['video', 'audio', 'text', 'image'] },
      { name: 'mimeType', summary: 'The MIME type of the segments, when contentType is not given.' },
      { name: 'lang', summary: 'RFC 5646 language tag of the track.' },
      {
        name: 'segmentAlignment',
        summary: 'Whether segment boundaries line up across the representations. Without it a player must assume it cannot switch.',
        values: ['true', 'false'],
      },
      { name: 'codecs', summary: 'The codec string, when every representation shares it.' },
      { name: 'startWithSAP', summary: 'Whether every segment starts with a stream access point, which is what makes switching possible.' },
    ],
  },
  {
    name: 'Representation',
    summary: 'One encoding of a track: a rung of the ladder.',
    attributes: [
      { name: 'id', summary: 'Identifies the representation; it also substitutes into $RepresentationID$ in a segment template.', required: true },
      { name: 'bandwidth', summary: 'Bits per second the representation needs. This is what adaptation ranks on.', required: true },
      { name: 'codecs', summary: 'RFC 6381 codec string: what a player has to be able to decode.' },
      { name: 'width', summary: 'Frame width in pixels.' },
      { name: 'height', summary: 'Frame height in pixels.' },
      { name: 'frameRate', summary: 'Frames per second, as a number or a ratio.' },
      { name: 'audioSamplingRate', summary: 'Samples per second, for audio.' },
    ],
  },
  {
    name: 'SegmentTemplate',
    summary: 'How to build a segment URL without listing every segment: $Number$ or $Time$ is substituted per segment.',
    attributes: [
      { name: 'media', summary: 'The template for a media segment. Needs $Number$ or $Time$, or every segment resolves to one URL.', required: true },
      { name: 'initialization', summary: 'The initialisation segment: what configures the decoder before any media arrives.' },
      { name: 'timescale', summary: 'Ticks per second that @duration and the timeline are expressed in.' },
      { name: 'duration', summary: 'Segment duration in @timescale units, when there is no SegmentTimeline.' },
      { name: 'startNumber', summary: 'The number $Number$ starts counting from.' },
      { name: 'presentationTimeOffset', summary: 'The media time that maps to the start of the period.' },
    ],
  },
  {
    name: 'SegmentTimeline',
    summary: 'The segments listed explicitly, as a run of <S> elements. What a live packager writes when durations vary.',
    attributes: [],
  },
  {
    name: 'S',
    summary: 'One segment, or a run of identical ones. Segments chain: each starts where the previous ended unless @t says otherwise.',
    attributes: [
      { name: 't', summary: 'Start time in @timescale units. Leave it off to continue from the previous segment.' },
      { name: 'd', summary: 'Duration in @timescale units.', required: true },
      { name: 'r', summary: 'Repeat count: r="2" means this segment and two more of the same length. Negative means "until the period ends".' },
    ],
  },
  {
    name: 'BaseURL',
    summary: 'The URL everything below it resolves against. Several of them are alternative sources for the same content.',
    attributes: [
      { name: 'serviceLocation', summary: 'Names the source, so a player can tell two alternatives apart when it fails over.' },
    ],
  },
  {
    name: 'UTCTiming',
    summary: 'Where a player should get the time. A live client computes which segment exists from its own clock, so without this a device whose clock is off requests segments that do not exist yet.',
    attributes: [
      { name: 'schemeIdUri', summary: 'Which timing scheme this is.', required: true },
      { name: 'value', summary: 'The server or the value the scheme needs.' },
    ],
  },
  {
    name: 'Initialization',
    summary: 'The initialisation segment, as an element rather than an attribute of the template.',
    attributes: [{ name: 'sourceURL', summary: 'Where the initialisation segment is.' }],
  },
  {
    name: 'ContentProtection',
    summary: 'A DRM system the content is protected with. One element per system, plus one for the common encryption scheme.',
    attributes: [
      { name: 'schemeIdUri', summary: 'Which system: the common encryption UUID, or a vendor one.', required: true },
      { name: 'value', summary: 'The encryption scheme, e.g. cenc or cbcs.' },
    ],
  },
];

const BY_NAME = new Map(ELEMENTS.map((element) => [element.name, element]));

/** Every element this reference documents. Exported so a test can cross-check it. */
export const DASH_ELEMENTS: DashElement[] = ELEMENTS;

/** dashSpec looks an element up, namespace prefix and all. */
export function dashSpec(name: string): DashElement | undefined {
  return BY_NAME.get(name.replace(/^.*:/, ''));
}

/** renderDashHover turns one element into the markdown a hover shows. */
export function renderDashHover(element: DashElement): string {
  const lines = [`**<${element.name}>**`, '', element.summary];
  if (element.attributes.length > 0) {
    lines.push('', '| Attribute | Meaning |', '|---|---|');
    for (const attribute of element.attributes) {
      const values = attribute.values ? ` _(${attribute.values.join(' · ')})_` : '';
      const required = attribute.required ? ' **required**' : '';
      lines.push(`| \`@${attribute.name}\`${required} | ${attribute.summary}${values} |`);
    }
  }
  return lines.join('\n');
}
