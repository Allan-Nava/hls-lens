// DASH: reading an MPD and reporting what it claims that does not hold together.
//
// The extension stays HLS-first — the name says so — but the same stream is usually
// packaged both ways from the same mezzanine, and the defects that matter are the
// same ones: a declared duration the segments do not fill, a timeline with a hole in
// it, a live manifest with no clock to synchronise to, renditions that cannot be
// switched between. An operator debugging a stream should not have to change tool
// halfway.
//
// As with the HLS rules, everything here reads the manifest's declarations. Anything
// that needs the segment bytes is segcheck's job, which speaks DASH too.
import { Finding, RULES, Severity } from './analyze';
import { XmlNode, attr, findAll, parseXml } from './xml';

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, hint: 2 };

/** How far the timeline may fall short of @mediaPresentationDuration, in seconds. */
const DURATION_TOLERANCE_S = 1;

/**
 * parseIsoDuration reads the ISO 8601 durations DASH writes (PT30S, PT1M30.5S,
 * P1DT2H3M4S). Years and months are deliberately not handled: they have no fixed
 * length, and nothing in a media presentation is measured in them.
 */
export function parseIsoDuration(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value.trim());
  if (!m || m.slice(1).every((piece) => piece === undefined)) return null;
  const [days, hours, minutes, seconds] = m.slice(1).map((piece) => (piece === undefined ? 0 : Number.parseFloat(piece)));
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

/**
 * analyzeMpd runs the dash/* rules over the text of an MPD. Findings carry 0-based
 * line indexes into that text, like everything else the extension reports.
 */
export function analyzeMpd(text: string): Finding[] {
  const findings: Finding[] = [];
  const add = (rule: string, line: number, message: string, hint?: string): void => {
    const doc = RULES.find((r) => r.id === rule);
    findings.push({ rule, severity: doc?.severity ?? 'warning', line, message, ...(hint ? { hint } : {}) });
  };

  const { root, errors } = parseXml(text);
  if (!root || !/(^|:)MPD$/.test(root.name)) {
    // A .mpd that is not an MPD is nearly always an error page or a redirect saved by
    // hand: say that, rather than reporting thirty missing attributes.
    add(
      'dash/not-an-mpd',
      root?.line ?? 0,
      root ? `the root element is <${root.name}>, not <MPD>` : 'the file does not parse as XML',
      'check that the file is the manifest and not an error page a CDN returned',
    );
    return findings;
  }
  for (const error of errors) {
    add('dash/malformed-xml', error.line, `the manifest is not well formed: ${error.message}`, 'players parse an MPD strictly; a broken document is not read at all');
  }

  const dynamic = attr(root, 'type') === 'dynamic';
  const presentationDuration = parseIsoDuration(attr(root, 'mediaPresentationDuration'));

  if (dynamic && findAll(root, 'UTCTiming').length === 0) {
    add(
      'dash/dynamic-without-utctiming',
      root.line,
      'this is a dynamic (live) MPD with no <UTCTiming>: players have nothing to synchronise their clock to',
      'add a UTCTiming element; a client whose clock is off by seconds requests segments that do not exist yet',
    );
  }
  if (!dynamic && presentationDuration === null) {
    add(
      'dash/missing-presentation-duration',
      root.line,
      'this is a static MPD with no @mediaPresentationDuration: a player cannot know how long the asset is',
      'add @mediaPresentationDuration as an ISO 8601 duration, e.g. PT1M30S',
    );
  }

  let timelineSeconds = 0;
  let sawTimeline = false;

  for (const set of findAll(root, 'AdaptationSet')) {
    const representations = findAll(set, 'Representation');
    const label = attr(set, 'id') ?? attr(set, 'contentType') ?? attr(set, 'mimeType') ?? `line ${set.line + 1}`;

    if (representations.length > 1 && attr(set, 'segmentAlignment') !== 'true') {
      add(
        'dash/adaptationset-not-aligned',
        set.line,
        `the adaptation set "${label}" holds ${representations.length} representations without @segmentAlignment="true"`,
        'a player may only switch representations at aligned boundaries; without the flag it has to assume it cannot',
      );
    }

    for (const rep of representations) {
      const repLabel = attr(rep, 'id') ?? `line ${rep.line + 1}`;
      if (!attr(rep, 'bandwidth')) {
        add('dash/missing-bandwidth', rep.line, `the representation "${repLabel}" declares no @bandwidth`, '@bandwidth is required, and it is what adaptation ranks representations on');
      }
      if (!attr(rep, 'codecs') && !attr(set, 'codecs')) {
        add('dash/missing-codecs', rep.line, `the representation "${repLabel}" declares no @codecs, on itself or on its adaptation set`, 'add @codecs so a player knows whether it can decode the representation before fetching it');
      }
    }

    for (const template of findAll(set, 'SegmentTemplate')) {
      const media = attr(template, 'media') ?? '';
      const timelines = findAll(template, 'SegmentTimeline');
      const addressable = media.includes('$Number$') || media.includes('$Time$');
      if (media && !addressable) {
        add(
          'dash/segment-template-without-number',
          template.line,
          `the segment template "${media}" has neither $Number$ nor $Time$: every segment resolves to the same URL`,
          'put $Number$ (with @startNumber and @duration or a timeline) or $Time$ in @media',
        );
      }
      if (!attr(template, 'initialization') && !findAll(template, 'Initialization').length) {
        add(
          'dash/segment-template-without-init',
          template.line,
          'the segment template declares no @initialization: a player has no initialisation segment to configure its decoder with',
          'add @initialization, or an <Initialization> child',
        );
      }

      const timescale = Number.parseFloat(attr(template, 'timescale') ?? '1') || 1;
      for (const timeline of timelines) {
        sawTimeline = true;
        timelineSeconds = Math.max(timelineSeconds, checkTimeline(timeline, timescale, add));
      }
    }
  }

  if (presentationDuration !== null && sawTimeline && timelineSeconds > 0) {
    const difference = presentationDuration - timelineSeconds;
    if (Math.abs(difference) > DURATION_TOLERANCE_S) {
      add(
        'dash/duration-vs-timeline',
        root.line,
        `@mediaPresentationDuration is ${presentationDuration}s but the segment timeline covers ${round(timelineSeconds)}s`,
        difference > 0
          ? 'the presentation claims media the timeline does not address: players stall at the end, or seek into nothing'
          : 'the timeline addresses more media than the presentation declares: the tail is unreachable',
      );
    }
  }

  return findings.sort((a, b) =>
    SEVERITY_RANK[a.severity] !== SEVERITY_RANK[b.severity]
      ? SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
      : a.line - b.line || a.rule.localeCompare(b.rule),
  );
}

/**
 * checkTimeline walks the <S> elements, which chain: each one starts where the
 * previous ended unless it says otherwise with @t. A @t that does not match the
 * running time is a hole in the presentation (or an overlap), and it is invisible
 * unless you add the durations up.
 */
function checkTimeline(
  timeline: XmlNode,
  timescale: number,
  add: (rule: string, line: number, message: string, hint?: string) => void,
): number {
  let current: number | null = null;
  let start: number | null = null;

  for (const s of timeline.children.filter((child) => child.name === 'S' || child.name.endsWith(':S'))) {
    const t = attr(s, 't') !== undefined ? Number.parseFloat(attr(s, 't')!) : null;
    const d = Number.parseFloat(attr(s, 'd') ?? '');
    const repeat = Number.parseInt(attr(s, 'r') ?? '0', 10) || 0;
    if (!Number.isFinite(d)) {
      add('dash/timeline-gap', s.line, 'this <S> has no usable @d: a segment with no duration cannot be placed on the timeline', 'every <S> needs @d in @timescale units');
      continue;
    }

    if (t !== null) {
      if (current !== null && t !== current) {
        const delta = (t - current) / timescale;
        add(
          'dash/timeline-gap',
          s.line,
          delta > 0
            ? `this <S> starts ${round(delta)}s after the previous one ends (@t=${t}, expected ${current}): a gap in the timeline`
            : `this <S> starts ${round(-delta)}s before the previous one ends (@t=${t}, expected ${current}): the segments overlap`,
          'segments chain: leave @t off, or make it match where the previous segment ended',
        );
      }
      current = t;
      if (start === null) start = t;
    } else if (current === null) {
      current = 0;
      start = 0;
    }

    // r is a repeat count: r="2" means the segment plus two more of the same length.
    // A negative r means "until the period ends", which has no length to add here.
    current += repeat >= 0 ? d * (repeat + 1) : d;
  }

  if (current === null || start === null) return 0;
  return (current - start) / timescale;
}

function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}
