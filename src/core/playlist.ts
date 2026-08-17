// The m3u8 parser.
//
// It keeps the line index of everything it decodes, because the whole point of
// reading a manifest inside an editor is that a finding can point at the line you
// have to fix. Line indexes are 0-based: that is what vscode.Position wants, and
// converting in two places is how off-by-one bugs get in.
//
// The parser is deliberately forgiving — its job is to describe a manifest well
// enough for the rules in analyze.ts to report what is wrong with it, so a
// malformed tag becomes data, never an exception.
import { Attrs, parseAttributeList, attrBool, attrFloat, attrInt, attrList, attrResolution, Resolution } from './attrs';

/** A decoded tag line. */
export interface Tag {
  /** Tag name without the leading '#', e.g. "EXT-X-STREAM-INF". */
  name: string;
  /** Everything after the first ':', raw. */
  value: string;
  /** Parsed attribute list, empty for tags that do not carry one. */
  attrs: Attrs;
  /** 0-based line index. */
  line: number;
}

/** One media segment of a media playlist. */
export interface Segment {
  uri: string;
  /** 0-based line index of the URI line. */
  uriLine: number;
  /** 0-based line index of the EXTINF tag. */
  extinfLine: number;
  duration: number | null;
  title: string;
  /** True when an EXT-X-DISCONTINUITY precedes this segment. */
  discontinuity: boolean;
  /** True when the segment is marked EXT-X-GAP. */
  gap: boolean;
  /** Raw EXT-X-BYTERANGE value, or null. */
  byterange: string | null;
  /** Raw EXT-X-PROGRAM-DATE-TIME value of this segment, or null. */
  programDateTime: string | null;
  programDateTimeLine: number | null;
}

/** One variant stream of a master playlist (including I-frame-only streams). */
export interface Variant {
  uri: string;
  /** 0-based line index of the URI (the next line, or the tag itself for I-frame streams). */
  uriLine: number;
  /** 0-based line index of the EXT-X-STREAM-INF tag. */
  line: number;
  attrs: Attrs;
  bandwidth: number | null;
  averageBandwidth: number | null;
  resolution: Resolution | null;
  codecs: string[];
  frameRate: number | null;
  audio: string | null;
  subtitles: string | null;
  closedCaptions: string | null;
  /** True for EXT-X-I-FRAME-STREAM-INF: trick-play, not a playable rendition. */
  iframeOnly: boolean;
}

/**
 * One partial segment. A part is published before the segment that contains it
 * exists, which is the whole point of it — so it is kept on its own rather than
 * hung off a Segment that may never be written.
 */
export interface Part {
  uri: string;
  duration: number | null;
  /** The part starts on an independent frame, so a player may join on it. */
  independent: boolean;
  /** The part is missing: the packager published a hole rather than nothing. */
  gap: boolean;
  byterange: string | null;
  /** 0-based line index of the EXT-X-PART tag. */
  line: number;
}

/** One alternate rendition declared with EXT-X-MEDIA. */
export interface Rendition {
  type: string;
  groupId: string;
  name: string;
  language: string | null;
  isDefault: boolean;
  autoselect: boolean;
  forced: boolean;
  channels: string | null;
  uri: string | null;
  line: number;
}

/** What a playlist file turned out to be. */
export type PlaylistKind = 'master' | 'media' | 'mixed' | 'unknown';

/** A parsed playlist. */
export interface Playlist {
  kind: PlaylistKind;
  /** Lines as the editor sees them, without line terminators and without the BOM. */
  lines: string[];
  tags: Tag[];
  unknownTags: Tag[];
  startsWithExtM3U: boolean;
  hasBom: boolean;

  version: number | null;
  versionLine: number | null;
  targetDuration: number | null;
  targetDurationLine: number | null;
  playlistType: string | null;
  hasEndList: boolean;
  iframesOnly: boolean;
  independentSegments: boolean;
  mediaSequence: number | null;
  discontinuitySequence: number | null;

  serverControl: Attrs | null;
  serverControlLine: number | null;
  partTarget: number | null;
  partInfLine: number | null;
  parts: Part[];
  /** EXT-X-PRELOAD-HINT tags, in the order the playlist writes them. */
  preloadHints: Tag[];
  /** EXT-X-RENDITION-REPORT tags, in the order the playlist writes them. */
  renditionReports: Tag[];

  segments: Segment[];
  variants: Variant[];
  renditions: Rendition[];
  keys: Tag[];
  maps: Tag[];

  /** EXTINF tags with no URI line after them — a broken segment. */
  danglingExtinf: Tag[];
  /** EXT-X-STREAM-INF tags with no URI line after them — a broken variant. */
  danglingStreamInf: Tag[];

  /** Sum of the EXTINF durations, rounded to milliseconds. */
  totalDuration: number;
  /** True when any EXTINF duration is written as a float (which requires version 3). */
  hasFloatDuration: boolean;
}

/**
 * Tags this parser knows. Anything else is reported as an unknown tag, which is
 * how a typo (EXT-X-TARGETDURATON) gets caught: a player ignores tags it does not
 * understand, so a misspelled TARGETDURATION reads as "no target duration at all"
 * and nothing complains.
 */
/** Every tag the parser recognises. Exported so the spec reference can be checked against it. */
export const KNOWN_TAG_NAMES: string[] = [
  'EXTM3U',
  'EXTINF',
  'EXT-X-VERSION',
  'EXT-X-TARGETDURATION',
  'EXT-X-MEDIA-SEQUENCE',
  'EXT-X-DISCONTINUITY-SEQUENCE',
  'EXT-X-DISCONTINUITY',
  'EXT-X-ENDLIST',
  'EXT-X-PLAYLIST-TYPE',
  'EXT-X-I-FRAMES-ONLY',
  'EXT-X-KEY',
  'EXT-X-MAP',
  'EXT-X-BYTERANGE',
  'EXT-X-PROGRAM-DATE-TIME',
  'EXT-X-DATERANGE',
  'EXT-X-GAP',
  'EXT-X-BITRATE',
  'EXT-X-PART',
  'EXT-X-PART-INF',
  'EXT-X-SERVER-CONTROL',
  'EXT-X-PRELOAD-HINT',
  'EXT-X-RENDITION-REPORT',
  'EXT-X-SKIP',
  'EXT-X-MEDIA',
  'EXT-X-STREAM-INF',
  'EXT-X-I-FRAME-STREAM-INF',
  'EXT-X-IMAGE-STREAM-INF',
  'EXT-X-SESSION-DATA',
  'EXT-X-SESSION-KEY',
  'EXT-X-INDEPENDENT-SEGMENTS',
  'EXT-X-START',
  'EXT-X-DEFINE',
  'EXT-X-CONTENT-STEERING',
  'EXT-X-ALLOW-CACHE',
];

const KNOWN_TAGS = new Set(KNOWN_TAG_NAMES);

/** Tags whose value is an attribute list rather than a scalar. */
const ATTRIBUTE_TAGS = new Set([
  'EXT-X-STREAM-INF',
  'EXT-X-I-FRAME-STREAM-INF',
  'EXT-X-IMAGE-STREAM-INF',
  'EXT-X-MEDIA',
  'EXT-X-KEY',
  'EXT-X-SESSION-KEY',
  'EXT-X-SESSION-DATA',
  'EXT-X-MAP',
  'EXT-X-PART',
  'EXT-X-PART-INF',
  'EXT-X-SERVER-CONTROL',
  'EXT-X-DATERANGE',
  'EXT-X-PRELOAD-HINT',
  'EXT-X-RENDITION-REPORT',
  'EXT-X-SKIP',
  'EXT-X-DEFINE',
  'EXT-X-START',
  'EXT-X-CONTENT-STEERING',
]);

/** looksLikePlaylist reports whether text is an m3u8 playlist at all. */
export function looksLikePlaylist(text: string): boolean {
  return stripBom(text).trimStart().startsWith('#EXTM3U');
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** parsePlaylist decodes a playlist, keeping every line index it finds. */
export function parsePlaylist(text: string): Playlist {
  const hasBom = text.charCodeAt(0) === 0xfeff;
  const lines = stripBom(text).split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));

  const pl: Playlist = {
    kind: 'unknown',
    lines,
    tags: [],
    unknownTags: [],
    startsWithExtM3U: false,
    hasBom,
    version: null,
    versionLine: null,
    targetDuration: null,
    targetDurationLine: null,
    playlistType: null,
    hasEndList: false,
    iframesOnly: false,
    independentSegments: false,
    mediaSequence: null,
    discontinuitySequence: null,
    serverControl: null,
    serverControlLine: null,
    partTarget: null,
    partInfLine: null,
    parts: [],
    preloadHints: [],
    renditionReports: [],
    segments: [],
    variants: [],
    renditions: [],
    keys: [],
    maps: [],
    danglingExtinf: [],
    danglingStreamInf: [],
    totalDuration: 0,
    hasFloatDuration: false,
  };

  // Per-segment state that accumulates until a URI line closes it.
  let pendingExtinf: { tag: Tag; duration: number | null; title: string } | null = null;
  let pendingStreamInf: Tag | null = null;
  let pendingDiscontinuity = false;
  let pendingGap = false;
  let pendingByterange: string | null = null;
  let pendingPdt: { value: string; line: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;

    if (line.startsWith('#')) {
      if (!line.startsWith('#EXT')) continue; // a comment, not a tag
      const tag = parseTag(line, i);
      pl.tags.push(tag);
      if (!KNOWN_TAGS.has(tag.name)) pl.unknownTags.push(tag);

      switch (tag.name) {
        case 'EXTM3U':
          if (i === firstContentLine(lines)) pl.startsWithExtM3U = true;
          break;
        case 'EXT-X-VERSION':
          pl.version = intOrNull(tag.value);
          pl.versionLine = i;
          break;
        case 'EXT-X-TARGETDURATION':
          pl.targetDuration = floatOrNull(tag.value);
          pl.targetDurationLine = i;
          break;
        case 'EXT-X-PLAYLIST-TYPE':
          pl.playlistType = tag.value.trim().toUpperCase();
          break;
        case 'EXT-X-ENDLIST':
          pl.hasEndList = true;
          break;
        case 'EXT-X-I-FRAMES-ONLY':
          pl.iframesOnly = true;
          break;
        case 'EXT-X-INDEPENDENT-SEGMENTS':
          pl.independentSegments = true;
          break;
        case 'EXT-X-MEDIA-SEQUENCE':
          pl.mediaSequence = intOrNull(tag.value);
          break;
        case 'EXT-X-DISCONTINUITY-SEQUENCE':
          pl.discontinuitySequence = intOrNull(tag.value);
          break;
        case 'EXT-X-SERVER-CONTROL':
          pl.serverControl = tag.attrs;
          pl.serverControlLine = i;
          break;
        case 'EXT-X-PART-INF':
          pl.partTarget = attrFloat(tag.attrs, 'PART-TARGET');
          pl.partInfLine = i;
          break;
        case 'EXT-X-PART':
          pl.parts.push(readPart(tag));
          break;
        case 'EXT-X-PRELOAD-HINT':
          pl.preloadHints.push(tag);
          break;
        case 'EXT-X-RENDITION-REPORT':
          pl.renditionReports.push(tag);
          break;
        case 'EXT-X-KEY':
        case 'EXT-X-SESSION-KEY':
          pl.keys.push(tag);
          break;
        case 'EXT-X-MAP':
          pl.maps.push(tag);
          break;
        case 'EXT-X-MEDIA':
          pl.renditions.push(readRendition(tag));
          break;
        case 'EXT-X-STREAM-INF':
          if (pendingStreamInf) pl.danglingStreamInf.push(pendingStreamInf);
          pendingStreamInf = tag;
          break;
        case 'EXT-X-I-FRAME-STREAM-INF':
          pl.variants.push(readVariant(tag, tag.attrs.get('URI') ?? '', i, true));
          break;
        case 'EXTINF': {
          if (pendingExtinf) pl.danglingExtinf.push(pendingExtinf.tag);
          const [rawDuration, ...titleParts] = tag.value.split(',');
          if (rawDuration.includes('.')) pl.hasFloatDuration = true;
          pendingExtinf = {
            tag,
            duration: floatOrNull(rawDuration),
            title: titleParts.join(',').trim(),
          };
          break;
        }
        case 'EXT-X-BYTERANGE':
          pendingByterange = tag.value.trim();
          break;
        case 'EXT-X-DISCONTINUITY':
          pendingDiscontinuity = true;
          break;
        case 'EXT-X-GAP':
          pendingGap = true;
          break;
        case 'EXT-X-PROGRAM-DATE-TIME':
          pendingPdt = { value: tag.value.trim(), line: i };
          break;
        default:
          break;
      }
      continue;
    }

    // A URI line closes whatever tag was pending.
    if (pendingStreamInf) {
      pl.variants.push(readVariant(pendingStreamInf, line, i, false));
      pendingStreamInf = null;
      continue;
    }
    if (pendingExtinf) {
      pl.segments.push({
        uri: line,
        uriLine: i,
        extinfLine: pendingExtinf.tag.line,
        duration: pendingExtinf.duration,
        title: pendingExtinf.title,
        discontinuity: pendingDiscontinuity,
        gap: pendingGap,
        byterange: pendingByterange,
        programDateTime: pendingPdt?.value ?? null,
        programDateTimeLine: pendingPdt?.line ?? null,
      });
      pendingExtinf = null;
      pendingDiscontinuity = false;
      pendingGap = false;
      pendingByterange = null;
      pendingPdt = null;
    }
  }
  if (pendingExtinf) pl.danglingExtinf.push(pendingExtinf.tag);
  if (pendingStreamInf) pl.danglingStreamInf.push(pendingStreamInf);

  // Durations are summed in milliseconds and divided back: 6+6+6+6+5.76 is
  // 29.759999999999998 in binary floating point, and a duration nobody can read
  // is worse than one rounded to the millisecond the manifest expresses anyway.
  pl.totalDuration = Math.round(pl.segments.reduce((sum, s) => sum + (s.duration ?? 0), 0) * 1000) / 1000;

  const hasVariants = pl.variants.length > 0 || pl.danglingStreamInf.length > 0;
  const hasMedia = pl.segments.length > 0 || pl.danglingExtinf.length > 0 || pl.targetDuration !== null;
  if (hasVariants && hasMedia) pl.kind = 'mixed';
  else if (hasVariants) pl.kind = 'master';
  else if (hasMedia) pl.kind = 'media';

  return pl;
}

function firstContentLine(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().length > 0) return i;
  }
  return 0;
}

function parseTag(line: string, index: number): Tag {
  const withoutHash = line.slice(1);
  const colon = withoutHash.indexOf(':');
  const name = colon === -1 ? withoutHash.trim() : withoutHash.slice(0, colon).trim();
  const value = colon === -1 ? '' : withoutHash.slice(colon + 1);
  const attrs = ATTRIBUTE_TAGS.has(name) ? parseAttributeList(value) : new Map<string, string>();
  return { name, value, attrs, line: index };
}

function readVariant(tag: Tag, uri: string, uriLine: number, iframeOnly: boolean): Variant {
  return {
    uri,
    uriLine,
    line: tag.line,
    attrs: tag.attrs,
    bandwidth: attrInt(tag.attrs, 'BANDWIDTH'),
    averageBandwidth: attrInt(tag.attrs, 'AVERAGE-BANDWIDTH'),
    resolution: attrResolution(tag.attrs, 'RESOLUTION'),
    codecs: attrList(tag.attrs, 'CODECS'),
    frameRate: attrFloat(tag.attrs, 'FRAME-RATE'),
    audio: tag.attrs.get('AUDIO') ?? null,
    subtitles: tag.attrs.get('SUBTITLES') ?? null,
    closedCaptions: tag.attrs.get('CLOSED-CAPTIONS') ?? null,
    iframeOnly,
  };
}

function readPart(tag: Tag): Part {
  return {
    uri: tag.attrs.get('URI') ?? '',
    duration: attrFloat(tag.attrs, 'DURATION'),
    independent: attrBool(tag.attrs, 'INDEPENDENT'),
    gap: attrBool(tag.attrs, 'GAP'),
    byterange: tag.attrs.get('BYTERANGE') ?? null,
    line: tag.line,
  };
}

function readRendition(tag: Tag): Rendition {
  return {
    type: (tag.attrs.get('TYPE') ?? '').toUpperCase(),
    groupId: tag.attrs.get('GROUP-ID') ?? '',
    name: tag.attrs.get('NAME') ?? '',
    language: tag.attrs.get('LANGUAGE') ?? null,
    isDefault: attrBool(tag.attrs, 'DEFAULT'),
    autoselect: attrBool(tag.attrs, 'AUTOSELECT'),
    forced: attrBool(tag.attrs, 'FORCED'),
    channels: tag.attrs.get('CHANNELS') ?? null,
    uri: tag.attrs.get('URI') ?? null,
    line: tag.line,
  };
}

function intOrNull(raw: string): number | null {
  const t = raw.trim();
  return /^\d+$/.test(t) ? Number.parseInt(t, 10) : null;
}

function floatOrNull(raw: string): number | null {
  const t = raw.trim();
  return /^\d+(\.\d+)?$/.test(t) ? Number.parseFloat(t) : null;
}
