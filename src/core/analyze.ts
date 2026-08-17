// The rules: what "wrong with this manifest" means, one rule at a time.
//
// Every rule is a pure function of a parsed playlist, so the whole catalogue is
// tested against fixtures and nothing here touches the network. A rule reports the
// line the operator has to edit — the reason this exists as an editor extension
// rather than a linter you run and then go hunting through the file.
//
// Severities map onto the editor: error → red squiggle (the stream is broken or
// the spec is violated), warning → something a player tolerates but a viewer pays
// for, hint → advisory, from the Apple HLS authoring specification rather than
// from RFC 8216.
import { Playlist, Segment } from './playlist';
import { attrFloat } from './attrs';
import { isPlainHttp, looksLikeFmp4Uri } from './uri';

/** How loudly a finding is reported. */
export type Severity = 'error' | 'warning' | 'hint';

/** One observation about one line of one manifest. */
export interface Finding {
  /** Stable "category/name" id: this is what --skip and the settings pin. */
  rule: string;
  severity: Severity;
  /** 0-based line index the finding points at. */
  line: number;
  message: string;
  /** What to do about it, when there is something short to say. */
  hint?: string;
}

/** Options for one analysis run. */
export interface AnalyzeOptions {
  /** Allowed drift between PROGRAM-DATE-TIME steps and EXTINF durations. */
  pdtDriftToleranceMs?: number;
  /** TARGETDURATION is overstated past this multiple of the longest segment. */
  targetDurationSlack?: number;
  /** Rule ids or categories to skip. */
  skip?: string[];
}

/** A documented rule, for the reference and the README. */
export interface RuleDoc {
  id: string;
  severity: Severity;
  scope: 'syntax' | 'master' | 'media';
  title: string;
  rationale: string;
}

export const RULES: RuleDoc[] = [
  {
    id: 'syntax/missing-extm3u',
    severity: 'error',
    scope: 'syntax',
    title: 'The playlist starts with #EXTM3U',
    rationale:
      'A playlist whose first line is not #EXTM3U is not a playlist: players reject it outright, so nothing else in the file matters.',
  },
  {
    id: 'syntax/leading-bom',
    severity: 'error',
    scope: 'syntax',
    title: 'The file has no UTF-8 byte order mark',
    rationale:
      'A BOM before #EXTM3U is invisible in most editors and makes strict players reject the playlist. It usually arrives from a template written on Windows or from a spreadsheet export.',
  },
  {
    id: 'syntax/mixed-playlist',
    severity: 'error',
    scope: 'syntax',
    title: 'A playlist is either a master or a media playlist, never both',
    rationale:
      'EXT-X-STREAM-INF and EXTINF in the same file is undefined: a player picks one interpretation and ignores half the file. It is normally a packager writing the wrong template, or a copy-paste between two playlists.',
  },
  {
    id: 'syntax/unknown-tag',
    severity: 'hint',
    scope: 'syntax',
    title: 'Every #EXT tag is one the spec defines',
    rationale:
      'Players must ignore tags they do not recognise, so a typo like EXT-X-TARGETDURATON reads as "no target duration at all" and nothing complains. A misspelled tag is silence, not an error.',
  },
  {
    id: 'syntax/version-too-low',
    severity: 'error',
    scope: 'syntax',
    title: 'EXT-X-VERSION covers the tags the playlist uses',
    rationale:
      'The compatibility version tells a player what it must understand. Declaring less than the playlist uses is how a stream plays on your desk and fails on a TV app that honours the declared version.',
  },
  {
    id: 'master/missing-bandwidth',
    severity: 'error',
    scope: 'master',
    title: 'Every variant declares BANDWIDTH',
    rationale:
      'BANDWIDTH is the only required attribute of EXT-X-STREAM-INF and the number ABR selection is built on. Without it a player cannot rank the variant and may skip it entirely.',
  },
  {
    id: 'master/missing-resolution',
    severity: 'warning',
    scope: 'master',
    title: 'Video variants declare RESOLUTION',
    rationale:
      'Without RESOLUTION a player cannot avoid sending a 1080p rendition to a 360p viewport, and no client-side cap on resolution can work. Apple requires it for video renditions.',
  },
  {
    id: 'master/missing-codecs',
    severity: 'warning',
    scope: 'master',
    title: 'Variants declare CODECS',
    rationale:
      'CODECS is what lets a player decide, before downloading anything, whether it can decode a rendition — and what Media Source Extensions needs to set up a buffer. Without it a browser player has to probe, which costs startup time and sometimes fails.',
  },
  {
    id: 'master/duplicate-bandwidth',
    severity: 'warning',
    scope: 'master',
    title: 'No two variants share the same BANDWIDTH',
    rationale:
      'Two variants with identical BANDWIDTH are indistinguishable to ABR: the player picks whichever it saw first and the other rung is dead weight in the ladder.',
  },
  {
    id: 'master/missing-uri',
    severity: 'error',
    scope: 'master',
    title: 'Every EXT-X-STREAM-INF is followed by a URI',
    rationale:
      'The line after EXT-X-STREAM-INF is the variant playlist. Without it the variant does not exist, and a player either skips it or fails to load the master.',
  },
  {
    id: 'master/undefined-group',
    severity: 'error',
    scope: 'master',
    title: 'AUDIO, SUBTITLES and CLOSED-CAPTIONS groups exist',
    rationale:
      'A variant pointing at a rendition group that no EXT-X-MEDIA declares has no audio (or no subtitles) at all. It is the classic result of renaming a group in one place.',
  },
  {
    id: 'master/group-no-default',
    severity: 'warning',
    scope: 'master',
    title: 'Each rendition group has a default',
    rationale:
      'With no DEFAULT=YES in a group, which audio or subtitle track a player starts with is its own choice — so the same stream starts in a different language depending on the device.',
  },
  {
    id: 'master/group-multiple-defaults',
    severity: 'error',
    scope: 'master',
    title: 'A rendition group has at most one default',
    rationale:
      'Two DEFAULT=YES renditions of the same type in the same group contradict each other; the spec allows one, and players resolve the conflict differently.',
  },
  {
    id: 'master/no-iframe-stream',
    severity: 'hint',
    scope: 'master',
    title: 'The master offers an I-frame playlist for trick play',
    rationale:
      'Without EXT-X-I-FRAME-STREAM-INF there is nothing to show while scrubbing: players fall back to seeking on the video renditions, which is slow and looks broken on a TV remote.',
  },
  {
    id: 'master/plaintext-uri',
    severity: 'warning',
    scope: 'master',
    title: 'Child playlists are addressed over HTTPS',
    rationale:
      'An http:// URI inside an https:// manifest is blocked as mixed content by every browser player, and readable in transit everywhere else.',
  },
  {
    id: 'master/average-bandwidth-missing',
    severity: 'hint',
    scope: 'master',
    title: 'Variants declare AVERAGE-BANDWIDTH',
    rationale:
      'BANDWIDTH is the peak a player must sustain; AVERAGE-BANDWIDTH is what the rendition actually costs. Players that have both make better decisions on a variable connection.',
  },
  {
    id: 'master/bandwidth-not-ascending',
    severity: 'hint',
    scope: 'master',
    title: 'Variants are listed in ascending BANDWIDTH',
    rationale:
      'Some players start on the first variant listed. An unordered ladder makes the initial pick arbitrary, which shows up as a stream that sometimes starts at the top rung on a slow connection.',
  },
  {
    id: 'media/missing-target-duration',
    severity: 'error',
    scope: 'media',
    title: 'The media playlist declares EXT-X-TARGETDURATION',
    rationale:
      'TARGETDURATION is required, and it is what a player uses to time its reloads. Without it a live playlist is polled at an arbitrary rate, or not at all.',
  },
  {
    id: 'media/extinf-exceeds-target',
    severity: 'error',
    scope: 'media',
    title: 'No segment is longer than EXT-X-TARGETDURATION',
    rationale:
      'The spec requires every EXTINF, rounded to the nearest integer, to be at most TARGETDURATION. A longer segment breaks the reload timing a player derives from it, which shows up as a stall right at that segment.',
  },
  {
    id: 'media/target-duration-overstated',
    severity: 'warning',
    scope: 'media',
    title: 'EXT-X-TARGETDURATION is close to the real segment duration',
    rationale:
      'A player reloads a live playlist on the target duration and buffers a multiple of it, so a target far above the real segments adds latency and a bigger buffer for nothing.',
  },
  {
    id: 'media/missing-endlist',
    severity: 'error',
    scope: 'media',
    title: 'A VOD playlist ends with EXT-X-ENDLIST',
    rationale:
      'PLAYLIST-TYPE:VOD without EXT-X-ENDLIST tells a player the content is complete and then never says it ended: the player keeps reloading the playlist forever and the seek bar never settles.',
  },
  {
    id: 'media/missing-map',
    severity: 'error',
    scope: 'media',
    title: 'fMP4 segments come with an EXT-X-MAP init segment',
    rationale:
      'A fragmented MP4 segment carries no codec configuration: without the initialisation segment from EXT-X-MAP there is nothing to initialise the decoder with, and playback fails immediately.',
  },
  {
    id: 'media/key-over-http',
    severity: 'error',
    scope: 'media',
    title: 'Content keys are fetched over HTTPS',
    rationale:
      'An EXT-X-KEY URI on http:// hands the AES key to anyone on the path, which makes the encryption decorative. Unlike a password, a content key cannot be rotated without re-encrypting the content.',
  },
  {
    id: 'media/pdt-not-monotonic',
    severity: 'error',
    scope: 'media',
    title: 'EXT-X-PROGRAM-DATE-TIME moves forward',
    rationale:
      'Wall-clock times that go backwards break every consumer that maps media time to real time: DVR windows, ad insertion, subtitle sync and any correlation with an event clock.',
  },
  {
    id: 'media/pdt-drift',
    severity: 'warning',
    scope: 'media',
    title: 'EXT-X-PROGRAM-DATE-TIME agrees with the EXTINF durations',
    rationale:
      'Two PROGRAM-DATE-TIME tags whose distance does not match the segment durations between them mean the wall clock and the media timeline disagree — the manifest is telling two different stories about when a frame was captured.',
  },
  {
    id: 'media/pdt-missing',
    severity: 'hint',
    scope: 'media',
    title: 'A live playlist carries EXT-X-PROGRAM-DATE-TIME',
    rationale:
      'Without a wall clock in the playlist there is no way to correlate a live stream with anything outside it: no absolute seeking in the DVR window, no matching an incident to a timestamp.',
  },
  {
    id: 'media/discontinuity-without-sequence',
    severity: 'warning',
    scope: 'media',
    title: 'A sliding playlist with discontinuities declares EXT-X-DISCONTINUITY-SEQUENCE',
    rationale:
      'When a discontinuity slides out of a live window, players that joined at different times disagree on which discontinuity they are in unless the sequence number is declared. Ad breaks are where this shows up.',
  },
  {
    id: 'media/missing-uri',
    severity: 'error',
    scope: 'media',
    title: 'Every EXTINF is followed by a segment URI',
    rationale:
      'An EXTINF with no URI after it is a segment that does not exist. Players stop at that point in the playlist.',
  },
  {
    id: 'media/part-without-server-control',
    severity: 'error',
    scope: 'media',
    title: 'Low-latency parts come with the EXT-X-SERVER-CONTROL that makes them usable',
    rationale:
      'EXT-X-PART only reduces latency if the player can block on a playlist reload and knows how far from the live edge to start: that is CAN-BLOCK-RELOAD=YES and PART-HOLD-BACK. Without them the parts are downloaded and the latency stays where it was.',
  },
  {
    id: 'media/holdback-too-small',
    severity: 'warning',
    scope: 'media',
    title: 'HOLD-BACK leaves a player three target durations of buffer',
    rationale:
      'The spec sets the floor at three target durations (three part durations for PART-HOLD-BACK). Below it a player starts too close to the live edge and rebuffers on the first hiccup.',
  },
  {
    id: 'media/gap-segments',
    severity: 'warning',
    scope: 'media',
    title: 'The playlist has no EXT-X-GAP segments',
    rationale:
      'EXT-X-GAP marks a segment the packager could not produce. Players skip it, so it is a hole in the content that the manifest is honest about — worth knowing before a viewer reports it.',
  },
  {
    id: 'media/short-live-window',
    severity: 'warning',
    scope: 'media',
    title: 'A live playlist holds at least three target durations',
    rationale:
      'A player buffers a multiple of the target duration before it starts. A window shorter than three target durations makes joining unreliable and leaves no room to recover from a slow segment.',
  },
  {
    id: 'media/plaintext-segment',
    severity: 'warning',
    scope: 'media',
    title: 'Segments are addressed over HTTPS',
    rationale:
      'An http:// segment URI in an https:// playlist is blocked as mixed content in browsers, and readable in transit everywhere else.',
  },
];

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, hint: 2 };

/**
 * Minimum EXT-X-VERSION per feature, from RFC 8216 §7 and the Apple HLS
 * authoring specification. Only the entries that are unambiguous are listed: a
 * false "version too low" is worse than a missing one, because it sends people
 * bumping a version for no reason.
 */
const VERSION_REQUIREMENTS: Array<{ version: number; feature: string; used: (pl: Playlist) => boolean }> = [
  { version: 3, feature: 'a floating-point EXTINF duration', used: (pl) => pl.hasFloatDuration },
  { version: 4, feature: 'EXT-X-BYTERANGE', used: (pl) => pl.segments.some((s) => s.byterange !== null) },
  {
    version: 5,
    feature: 'EXT-X-KEY with KEYFORMAT or METHOD=SAMPLE-AES',
    used: (pl) =>
      pl.keys.some(
        (k) =>
          k.attrs.has('KEYFORMAT') ||
          k.attrs.has('KEYFORMATVERSIONS') ||
          (k.attrs.get('METHOD') ?? '').toUpperCase().startsWith('SAMPLE-AES'),
      ),
  },
  // EXT-X-MAP needs 5 in an I-frame-only playlist and 6 in a playlist with media
  // segments, which is the case that actually appears in the wild.
  { version: 5, feature: 'EXT-X-MAP', used: (pl) => pl.maps.length > 0 && pl.iframesOnly },
  { version: 6, feature: 'EXT-X-MAP', used: (pl) => pl.maps.length > 0 && !pl.iframesOnly },
  {
    version: 9,
    feature: 'low-latency partial segments',
    used: (pl) => pl.partCount > 0 || pl.partTarget !== null || pl.tags.some((t) => t.name === 'EXT-X-SKIP' || t.name === 'EXT-X-PRELOAD-HINT'),
  },
];

/** analyze runs the catalogue over one playlist, worst-first then by line. */
export function analyze(pl: Playlist, options: AnalyzeOptions = {}): Finding[] {
  const pdtTolerance = options.pdtDriftToleranceMs ?? 500;
  const slack = options.targetDurationSlack ?? 1.5;
  const findings: Finding[] = [];
  const add = (rule: string, line: number, message: string, hint?: string): void => {
    const doc = RULES.find((r) => r.id === rule);
    findings.push({ rule, severity: doc?.severity ?? 'warning', line, message, ...(hint ? { hint } : {}) });
  };

  checkSyntax(pl, add);
  if (pl.kind === 'master' || pl.kind === 'mixed') checkMaster(pl, add);
  if (pl.kind === 'media' || pl.kind === 'mixed') checkMedia(pl, add, pdtTolerance, slack);

  const skip = options.skip ?? [];
  const kept = findings.filter((f) => !skip.includes(f.rule) && !skip.includes(f.rule.split('/')[0]));
  return kept.sort((a, b) =>
    SEVERITY_RANK[a.severity] !== SEVERITY_RANK[b.severity]
      ? SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
      : a.line - b.line || a.rule.localeCompare(b.rule),
  );
}

type Add = (rule: string, line: number, message: string, hint?: string) => void;

function checkSyntax(pl: Playlist, add: Add): void {
  if (!pl.startsWithExtM3U) {
    add('syntax/missing-extm3u', 0, 'the playlist does not start with #EXTM3U', 'make #EXTM3U the very first line');
  }
  if (pl.hasBom) {
    add('syntax/leading-bom', 0, 'the file starts with a UTF-8 byte order mark before #EXTM3U', 'save the file as UTF-8 without BOM');
  }
  if (pl.kind === 'mixed') {
    add(
      'syntax/mixed-playlist',
      0,
      'the file mixes EXT-X-STREAM-INF (master) with EXTINF (media): a player can only read it as one of the two',
      'split it into a master playlist and its variant playlists',
    );
  }
  for (const tag of pl.unknownTags) {
    add('syntax/unknown-tag', tag.line, `#${tag.name} is not a tag the HLS spec defines — a player will ignore this line`, 'check the spelling against RFC 8216');
  }

  const declared = pl.version ?? 1;
  let required = 1;
  const features: string[] = [];
  for (const req of VERSION_REQUIREMENTS) {
    if (!req.used(pl)) continue;
    if (req.version > declared) features.push(`${req.feature} needs ${req.version}`);
    required = Math.max(required, req.version);
  }
  if (required > declared) {
    add(
      'syntax/version-too-low',
      pl.versionLine ?? 0,
      `EXT-X-VERSION is ${pl.version === null ? 'absent (so 1)' : pl.version} but the playlist uses features that need ${required}: ${features.join(', ')}`,
      `declare #EXT-X-VERSION:${required}`,
    );
  }
}

function checkMaster(pl: Playlist, add: Add): void {
  const playable = pl.variants.filter((v) => !v.iframeOnly);

  // Rendition groups, so a variant can be checked against what exists.
  const groups = new Map<string, { defaults: number; total: number; line: number }>();
  for (const r of pl.renditions) {
    const key = `${r.type} ${r.groupId}`;
    const g = groups.get(key) ?? { defaults: 0, total: 0, line: r.line };
    g.total++;
    if (r.isDefault) g.defaults++;
    groups.set(key, g);
    if (r.uri && isPlainHttp(r.uri)) {
      add('master/plaintext-uri', r.line, `rendition "${r.name || r.groupId}" is addressed over plaintext HTTP (${r.uri})`, 'serve it over HTTPS');
    }
  }
  for (const [key, g] of groups) {
    const [type, groupId] = key.split(' ');
    if (g.defaults === 0) {
      add('master/group-no-default', g.line, `no rendition of the ${type} group "${groupId}" is DEFAULT=YES: which one plays is up to the player`, 'mark exactly one rendition DEFAULT=YES');
    } else if (g.defaults > 1) {
      add('master/group-multiple-defaults', g.line, `the ${type} group "${groupId}" has ${g.defaults} renditions marked DEFAULT=YES`, 'keep exactly one default per group');
    }
  }

  const seenBandwidth = new Map<number, number>();
  for (const v of pl.variants) {
    const label = v.uri || `line ${v.line + 1}`;
    if (v.bandwidth === null) {
      add('master/missing-bandwidth', v.line, `the variant "${label}" declares no BANDWIDTH, the one attribute EXT-X-STREAM-INF requires`, 'add BANDWIDTH with the peak bitrate of the rendition');
    } else {
      const first = seenBandwidth.get(v.bandwidth);
      if (first !== undefined) {
        add('master/duplicate-bandwidth', v.line, `BANDWIDTH=${v.bandwidth} is already used by the variant on line ${first + 1}: ABR cannot tell the two rungs apart`, 'give each rung a distinct BANDWIDTH');
      } else {
        seenBandwidth.set(v.bandwidth, v.line);
      }
    }
    if (v.codecs.length === 0) {
      add('master/missing-codecs', v.line, `the variant "${label}" declares no CODECS: a player has to download media to find out whether it can decode it`, 'add CODECS with the RFC 6381 strings of the rendition');
    }
    if (!v.iframeOnly) {
      if (v.resolution === null) {
        add('master/missing-resolution', v.line, `the variant "${label}" declares no RESOLUTION`, 'add RESOLUTION so players can match the rendition to the viewport');
      }
      if (v.averageBandwidth === null) {
        add('master/average-bandwidth-missing', v.line, `the variant "${label}" declares no AVERAGE-BANDWIDTH`, 'add AVERAGE-BANDWIDTH: BANDWIDTH is the peak, this is what the rendition costs');
      }
    }
    for (const [attr, group] of [
      ['AUDIO', v.audio],
      ['SUBTITLES', v.subtitles],
      ['CLOSED-CAPTIONS', v.closedCaptions],
    ] as const) {
      if (!group || group.toUpperCase() === 'NONE') continue;
      const type = attr === 'CLOSED-CAPTIONS' ? 'CLOSED-CAPTIONS' : attr;
      if (!groups.has(`${type} ${group}`)) {
        add('master/undefined-group', v.line, `${attr}="${group}" names a rendition group no EXT-X-MEDIA declares`, `add an EXT-X-MEDIA with TYPE=${type} and GROUP-ID="${group}", or fix the name`);
      }
    }
    if (v.uri && isPlainHttp(v.uri)) {
      add('master/plaintext-uri', v.uriLine, `the variant playlist is addressed over plaintext HTTP (${v.uri})`, 'serve it over HTTPS: browsers block mixed content');
    }
  }

  for (const tag of pl.danglingStreamInf) {
    add('master/missing-uri', tag.line, 'this EXT-X-STREAM-INF is not followed by a variant playlist URI', 'put the variant playlist URI on the next line');
  }

  if (playable.length > 0 && !pl.variants.some((v) => v.iframeOnly)) {
    add('master/no-iframe-stream', 0, 'the master offers no EXT-X-I-FRAME-STREAM-INF: there is nothing to show while scrubbing', 'add an I-frame playlist for trick play');
  }

  const withBandwidth = playable.filter((v) => v.bandwidth !== null);
  for (let i = 1; i < withBandwidth.length; i++) {
    if (withBandwidth[i].bandwidth! < withBandwidth[i - 1].bandwidth!) {
      add('master/bandwidth-not-ascending', withBandwidth[i].line, 'the variants are not listed in ascending BANDWIDTH: players that start on the first one listed pick arbitrarily', 'sort the variants from the lowest bitrate up');
      break;
    }
  }
}

function checkMedia(pl: Playlist, add: Add, pdtToleranceMs: number, slack: number): void {
  const isLive = !pl.hasEndList && pl.playlistType !== 'VOD';

  if (pl.targetDuration === null) {
    add('media/missing-target-duration', 0, 'the media playlist declares no EXT-X-TARGETDURATION', 'add #EXT-X-TARGETDURATION with the longest segment duration, rounded up');
  } else {
    for (const s of pl.segments) {
      if (s.duration !== null && Math.round(s.duration) > pl.targetDuration) {
        add(
          'media/extinf-exceeds-target',
          s.extinfLine,
          `this segment is ${s.duration}s but EXT-X-TARGETDURATION is ${pl.targetDuration}s`,
          `raise the target duration to ${Math.ceil(s.duration)} or shorten the segment`,
        );
      }
    }
    const longest = pl.segments.reduce((max, s) => Math.max(max, s.duration ?? 0), 0);
    if (pl.segments.length >= 2 && longest > 0 && pl.targetDuration > longest * slack) {
      add(
        'media/target-duration-overstated',
        pl.targetDurationLine ?? 0,
        `EXT-X-TARGETDURATION is ${pl.targetDuration}s but the longest segment is ${longest}s: players reload and buffer on the declared value`,
        `declare ${Math.ceil(longest)}`,
      );
    }
  }

  if (pl.playlistType === 'VOD' && !pl.hasEndList) {
    add('media/missing-endlist', pl.lines.length > 0 ? pl.lines.length - 1 : 0, 'the playlist is PLAYLIST-TYPE:VOD but has no EXT-X-ENDLIST: players keep reloading it forever', 'append #EXT-X-ENDLIST');
  }

  if (pl.maps.length === 0) {
    const fmp4 = pl.segments.find((s) => looksLikeFmp4Uri(s.uri));
    if (fmp4) {
      add('media/missing-map', fmp4.uriLine, `the segments are fragmented MP4 (${fmp4.uri}) but the playlist has no EXT-X-MAP initialisation segment`, 'add #EXT-X-MAP:URI="init.mp4" before the first segment');
    }
  }

  for (const key of pl.keys) {
    const uri = key.attrs.get('URI') ?? '';
    if (isPlainHttp(uri)) {
      add('media/key-over-http', key.line, `the content key is fetched over plaintext HTTP (${uri}): anyone on the path can read it`, 'serve the key over HTTPS; a leaked content key cannot be rotated without re-encrypting');
    }
  }

  for (const s of pl.segments) {
    if (isPlainHttp(s.uri)) {
      add('media/plaintext-segment', s.uriLine, `the segment is addressed over plaintext HTTP (${s.uri})`, 'serve the segments over HTTPS');
      break; // one finding is enough: it is a playlist-wide packaging choice
    }
  }

  checkProgramDateTime(pl, add, pdtToleranceMs, isLive);

  if (pl.segments.some((s) => s.discontinuity) && pl.discontinuitySequence === null && (pl.mediaSequence ?? 0) > 0) {
    const first = pl.segments.find((s) => s.discontinuity)!;
    add(
      'media/discontinuity-without-sequence',
      first.extinfLine,
      'the playlist has discontinuities and a non-zero media sequence but no EXT-X-DISCONTINUITY-SEQUENCE',
      'add #EXT-X-DISCONTINUITY-SEQUENCE so players that join later agree on which discontinuity they are in',
    );
  }

  for (const tag of pl.danglingExtinf) {
    add('media/missing-uri', tag.line, 'this EXTINF is not followed by a segment URI', 'put the segment URI on the next line');
  }

  if (pl.partCount > 0 || pl.partTarget !== null) {
    const sc = pl.serverControl;
    const canBlock = (sc?.get('CAN-BLOCK-RELOAD') ?? '').toUpperCase() === 'YES';
    const partHoldBack = sc ? attrFloat(sc, 'PART-HOLD-BACK') : null;
    if (!sc || !canBlock || partHoldBack === null) {
      add(
        'media/part-without-server-control',
        pl.serverControlLine ?? 0,
        'the playlist publishes EXT-X-PART without EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES and PART-HOLD-BACK: the parts cost bandwidth and buy no latency',
        'add #EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=<3× part target>',
      );
    }
  }

  if (pl.serverControl) {
    const holdBack = attrFloat(pl.serverControl, 'HOLD-BACK');
    if (holdBack !== null && pl.targetDuration !== null && holdBack < 3 * pl.targetDuration) {
      add(
        'media/holdback-too-small',
        pl.serverControlLine ?? 0,
        `HOLD-BACK is ${holdBack}s, under the three target durations (${3 * pl.targetDuration}s) the spec requires`,
        `raise HOLD-BACK to at least ${3 * pl.targetDuration}`,
      );
    }
    const partHoldBack = attrFloat(pl.serverControl, 'PART-HOLD-BACK');
    if (partHoldBack !== null && pl.partTarget !== null && partHoldBack < 3 * pl.partTarget) {
      add(
        'media/holdback-too-small',
        pl.serverControlLine ?? 0,
        `PART-HOLD-BACK is ${partHoldBack}s, under the three part durations (${3 * pl.partTarget}s) the spec requires`,
        `raise PART-HOLD-BACK to at least ${3 * pl.partTarget}`,
      );
    }
  }

  const gap = pl.segments.find((s) => s.gap);
  if (gap) {
    const count = pl.segments.filter((s) => s.gap).length;
    add('media/gap-segments', gap.extinfLine, `${count} segment(s) are marked EXT-X-GAP: the packager could not produce them and players will skip them`, 'find out why the packager missed them; the content is missing, not just the bytes');
  }

  if (isLive && pl.targetDuration !== null && pl.segments.length > 0 && pl.totalDuration < 3 * pl.targetDuration) {
    add(
      'media/short-live-window',
      0,
      `the live window is ${pl.totalDuration}s, under the three target durations (${3 * pl.targetDuration}s) a player needs to join reliably`,
      'keep at least three target durations of segments in the playlist',
    );
  }
}

function checkProgramDateTime(pl: Playlist, add: Add, toleranceMs: number, isLive: boolean): void {
  const stamped: Array<{ segment: Segment; index: number; at: number; line: number }> = [];
  pl.segments.forEach((segment, index) => {
    if (!segment.programDateTime) return;
    const at = Date.parse(segment.programDateTime);
    if (Number.isNaN(at)) return;
    stamped.push({ segment, index, at, line: segment.programDateTimeLine ?? segment.extinfLine });
  });

  if (stamped.length === 0) {
    if (isLive) {
      add('media/pdt-missing', 0, 'the live playlist carries no EXT-X-PROGRAM-DATE-TIME: nothing maps media time to wall-clock time', 'emit a PROGRAM-DATE-TIME at least on the first segment of the playlist');
    }
    return;
  }

  for (let i = 1; i < stamped.length; i++) {
    const prev = stamped[i - 1];
    const cur = stamped[i];
    if (cur.at <= prev.at) {
      add(
        'media/pdt-not-monotonic',
        cur.line,
        `EXT-X-PROGRAM-DATE-TIME goes backwards: ${cur.segment.programDateTime} is not after ${prev.segment.programDateTime}`,
        'emit a monotonically increasing wall clock',
      );
      continue;
    }
    // Expected distance is the media time between the two stamped segments.
    let expectedMs = 0;
    for (let s = prev.index; s < cur.index; s++) expectedMs += (pl.segments[s].duration ?? 0) * 1000;
    const actualMs = cur.at - prev.at;
    const driftMs = Math.round(actualMs - expectedMs);
    if (Math.abs(driftMs) > toleranceMs) {
      add(
        'media/pdt-drift',
        cur.line,
        `the wall clock advances ${(actualMs / 1000).toFixed(3)}s here but the EXTINF durations between the two stamps add up to ${(expectedMs / 1000).toFixed(3)}s (drift ${driftMs > 0 ? '+' : ''}${driftMs}ms)`,
        'emit PROGRAM-DATE-TIME from the media timeline, not from the packager wall clock',
      );
    }
  }
}
