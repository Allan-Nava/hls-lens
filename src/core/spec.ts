// The spec, as data: what each tag means, the version it needs, and the attributes
// it accepts — the reference the hover and the completions are rendered from.
//
// It exists because reading a manifest means remembering which of thirty-odd tags
// takes an attribute list, which enumerated values are legal, and what a player does
// when one is missing. That is a browser tab per question; this is the same answer in
// the editor, and it cannot drift from the parser: a test asserts that this list and
// the parser's set of known tags are the same set.
//
// Sources: RFC 8216 (§4.3, §4.4) and the Apple HLS authoring specification for the
// low-latency and image tags.
import { KNOWN_TAG_NAMES } from './playlist';

/** One attribute of one tag. */
export interface AttributeSpec {
  name: string;
  /** What it is for, in one line. */
  summary: string;
  required?: boolean;
  /** The enumerated values, when the attribute has a closed set. */
  values?: string[];
}

/** One tag of the HLS specification. */
export interface TagSpec {
  /** Name without the leading '#'. */
  name: string;
  /** Where the tag is legal: a master playlist, a media playlist, or either. */
  scope: 'master' | 'media' | 'both';
  /** Lowest EXT-X-VERSION that allows it. */
  since: number;
  /** What the tag does, and what happens when it is wrong or absent. */
  summary: string;
  /** True when the tag carries an attribute list rather than a bare value. */
  attributeList?: boolean;
  attributes: AttributeSpec[];
}

const YES_NO = ['YES', 'NO'];

export const SPEC_TAGS: TagSpec[] = [
  {
    name: 'EXTM3U',
    scope: 'both',
    since: 1,
    summary: 'The first line of every playlist. A file that does not start with it is not a playlist and players reject it.',
    attributes: [],
  },
  {
    name: 'EXTINF',
    scope: 'media',
    since: 1,
    summary: 'The duration of the segment on the next line, in seconds, followed by a comma and an optional title.',
    attributes: [],
  },
  {
    name: 'EXT-X-VERSION',
    scope: 'both',
    since: 1,
    summary: 'The compatibility version the playlist requires. Declaring less than the tags in use is how a stream plays on a desktop and fails on a TV that honours it.',
    attributes: [],
  },
  {
    name: 'EXT-X-TARGETDURATION',
    scope: 'media',
    since: 1,
    summary: 'The longest segment duration, rounded to the nearest integer. Players size their buffer and their reload interval on it, so an overstated value costs latency on every viewer.',
    attributes: [],
  },
  {
    name: 'EXT-X-MEDIA-SEQUENCE',
    scope: 'media',
    since: 1,
    summary: 'The sequence number of the first segment listed. It is how a player that reloads a live playlist knows which segments are new.',
    attributes: [],
  },
  {
    name: 'EXT-X-DISCONTINUITY-SEQUENCE',
    scope: 'media',
    since: 6,
    summary: 'How many discontinuities have already slid out of the window. Without it, players that joined at different times disagree about which discontinuity they are in.',
    attributes: [],
  },
  {
    name: 'EXT-X-DISCONTINUITY',
    scope: 'media',
    since: 1,
    summary: 'The next segment breaks continuity: a different encoding, timestamp base or ad break. Players reset their decoder here.',
    attributes: [],
  },
  {
    name: 'EXT-X-ENDLIST',
    scope: 'media',
    since: 1,
    summary: 'The playlist is complete and will not change. Without it a player keeps reloading the file forever, however finished the asset is.',
    attributes: [],
  },
  {
    name: 'EXT-X-PLAYLIST-TYPE',
    scope: 'media',
    since: 3,
    summary: 'VOD means the playlist never changes; EVENT means segments may only be appended. Omitting it leaves a live playlist that may drop segments from the front.',
    attributes: [{ name: '', summary: 'VOD or EVENT.', values: ['VOD', 'EVENT'] }],
  },
  {
    name: 'EXT-X-I-FRAMES-ONLY',
    scope: 'media',
    since: 4,
    summary: 'Every segment is a single I-frame, for trick play. The segments should be EXT-X-BYTERANGE ranges into the media file, not whole files.',
    attributes: [],
  },
  {
    name: 'EXT-X-KEY',
    scope: 'media',
    since: 1,
    summary: 'How the segments that follow are encrypted, and where the content key lives. It applies until the next EXT-X-KEY, so METHOD=NONE part-way through leaves the rest in the clear.',
    attributeList: true,
    attributes: [
      { name: 'METHOD', summary: 'The encryption method.', required: true, values: ['NONE', 'AES-128', 'SAMPLE-AES'] },
      { name: 'URI', summary: 'Where to fetch the key. Over HTTPS: a leaked content key cannot be rotated without re-encrypting.' },
      { name: 'IV', summary: 'The initialisation vector, as a hex string. Defaults to the media sequence number.' },
      { name: 'KEYFORMAT', summary: 'How the key is presented, e.g. "identity" or a DRM system id.' },
      { name: 'KEYFORMATVERSIONS', summary: 'Which versions of that key format the key is valid for.' },
    ],
  },
  {
    name: 'EXT-X-MAP',
    scope: 'media',
    since: 5,
    summary: 'The initialisation segment for fragmented MP4. Without it a player has no decoder configuration and the first segment fails.',
    attributeList: true,
    attributes: [
      { name: 'URI', summary: 'The initialisation segment.', required: true },
      { name: 'BYTERANGE', summary: 'The range of the resource the init segment occupies.' },
    ],
  },
  {
    name: 'EXT-X-BYTERANGE',
    scope: 'media',
    since: 4,
    summary: 'The segment is a range of a larger resource, written length@offset. It is how I-frame playlists address single frames.',
    attributes: [],
  },
  {
    name: 'EXT-X-PROGRAM-DATE-TIME',
    scope: 'media',
    since: 1,
    summary: 'The wall-clock time of the first sample of the next segment. It is what maps media time to real time for DVR, ad insertion and subtitle sync.',
    attributes: [],
  },
  {
    name: 'EXT-X-DATERANGE',
    scope: 'media',
    since: 4,
    summary: 'A span of wall-clock time carrying metadata — usually an SCTE-35 ad break. Players act on it, so a malformed range is an ad that does not start or does not end.',
    attributeList: true,
    attributes: [
      { name: 'ID', summary: 'Unique identifier of the range.', required: true },
      { name: 'CLASS', summary: 'The set of ranges this one belongs to; ranges of one class must not overlap.' },
      { name: 'START-DATE', summary: 'When the range begins, ISO-8601.', required: true },
      { name: 'END-DATE', summary: 'When it ends. Must agree with DURATION when both are present.' },
      { name: 'DURATION', summary: 'How long it lasts, in seconds.' },
      { name: 'PLANNED-DURATION', summary: 'The expected duration, when the real one is not known yet.' },
      { name: 'SCTE35-OUT', summary: 'The SCTE-35 splice_info_section that opens an ad break.' },
      { name: 'SCTE35-IN', summary: 'The splice that closes it.' },
      { name: 'END-ON-NEXT', summary: 'The range ends where the next range of the same CLASS begins.', values: YES_NO },
    ],
  },
  {
    name: 'EXT-X-GAP',
    scope: 'media',
    since: 8,
    summary: 'The next segment is missing and players should skip it. An honest hole in the content, which is worth knowing before a viewer reports it.',
    attributes: [],
  },
  {
    name: 'EXT-X-BITRATE',
    scope: 'media',
    since: 1,
    summary: 'The approximate bitrate, in kbps, of the segments that follow. Some packagers emit it; players may use it to refine their estimate.',
    attributes: [],
  },
  {
    name: 'EXT-X-PART',
    scope: 'media',
    since: 9,
    summary: 'A partial segment, for low latency. Only useful with the EXT-X-SERVER-CONTROL that lets a player block on a reload.',
    attributeList: true,
    attributes: [
      { name: 'URI', summary: 'The partial segment.', required: true },
      { name: 'DURATION', summary: 'Its duration in seconds.', required: true },
      { name: 'INDEPENDENT', summary: 'The part starts with an independent frame, so a player can start on it.', values: YES_NO },
      { name: 'BYTERANGE', summary: 'The range of the resource the part occupies.' },
      { name: 'GAP', summary: 'The part is missing.', values: YES_NO },
    ],
  },
  {
    name: 'EXT-X-PART-INF',
    scope: 'media',
    since: 9,
    summary: 'Declares the target duration of the partial segments in the playlist.',
    attributeList: true,
    attributes: [{ name: 'PART-TARGET', summary: 'The part duration players should expect.', required: true }],
  },
  {
    name: 'EXT-X-SERVER-CONTROL',
    scope: 'media',
    since: 6,
    summary: 'What the server supports: blocking reloads, how far from the live edge to start, whether playlist deltas are available.',
    attributeList: true,
    attributes: [
      { name: 'CAN-BLOCK-RELOAD', summary: 'The server holds a playlist request until new media exists. Low latency needs it.', values: YES_NO },
      { name: 'HOLD-BACK', summary: 'How far from the live edge a player should start, in seconds. The floor is three target durations.' },
      { name: 'PART-HOLD-BACK', summary: 'The same for partial segments: at least three part durations.' },
      { name: 'CAN-SKIP-UNTIL', summary: 'Playlist deltas are available for clients that already have this much of the playlist.' },
      { name: 'CAN-SKIP-DATERANGES', summary: 'Deltas may also skip EXT-X-DATERANGE tags.', values: YES_NO },
    ],
  },
  {
    name: 'EXT-X-PRELOAD-HINT',
    scope: 'media',
    since: 9,
    summary: 'The resource a low-latency player should request before it exists, so the response starts as soon as the server has bytes.',
    attributeList: true,
    attributes: [
      { name: 'TYPE', summary: 'What is being hinted.', required: true, values: ['PART', 'MAP'] },
      { name: 'URI', summary: 'The resource to request.', required: true },
      { name: 'BYTERANGE-START', summary: 'Where the requested range starts.' },
      { name: 'BYTERANGE-LENGTH', summary: 'How long the requested range is.' },
    ],
  },
  {
    name: 'EXT-X-RENDITION-REPORT',
    scope: 'media',
    since: 9,
    summary: 'How far along the other renditions are, so a player can switch without fetching their playlists first.',
    attributeList: true,
    attributes: [
      { name: 'URI', summary: 'The rendition being reported.', required: true },
      { name: 'LAST-MSN', summary: 'Its last media sequence number.' },
      { name: 'LAST-PART', summary: 'Its last partial segment.' },
    ],
  },
  {
    name: 'EXT-X-SKIP',
    scope: 'media',
    since: 9,
    summary: 'A playlist delta: this many segments the client already has were left out of the response.',
    attributeList: true,
    attributes: [
      { name: 'SKIPPED-SEGMENTS', summary: 'How many segments were omitted.', required: true },
      { name: 'RECENTLY-REMOVED-DATERANGES', summary: 'Ranges removed since the client last asked.' },
    ],
  },
  {
    name: 'EXT-X-MEDIA',
    scope: 'master',
    since: 4,
    summary: 'An alternate rendition — another language, another audio mix, subtitles. Variants point at it by GROUP-ID, and a name that matches nothing means no audio at all.',
    attributeList: true,
    attributes: [
      { name: 'TYPE', summary: 'What kind of rendition it is.', required: true, values: ['AUDIO', 'VIDEO', 'SUBTITLES', 'CLOSED-CAPTIONS'] },
      { name: 'GROUP-ID', summary: 'The group a variant references.', required: true },
      { name: 'NAME', summary: 'What a player shows in its track menu.', required: true },
      { name: 'URI', summary: 'The rendition playlist. Absent for CLOSED-CAPTIONS, which live in the video.' },
      { name: 'LANGUAGE', summary: 'RFC 5646 language tag.' },
      { name: 'ASSOC-LANGUAGE', summary: 'An associated language, for dubbing or transliteration.' },
      { name: 'DEFAULT', summary: 'The rendition a player starts with. Exactly one per group.', values: YES_NO },
      { name: 'AUTOSELECT', summary: 'The player may pick it from the viewer environment.', values: YES_NO },
      { name: 'FORCED', summary: 'Subtitles that must be shown even with subtitles off — burned-in translations of foreign dialogue.', values: YES_NO },
      { name: 'CHANNELS', summary: 'Audio channel count, e.g. "2" or "6".' },
      { name: 'INSTREAM-ID', summary: 'Which caption channel, for CLOSED-CAPTIONS: CC1-CC4 or SERVICE1-63.' },
      { name: 'CHARACTERISTICS', summary: 'Media characteristics, e.g. public.accessibility.describes-video.' },
      { name: 'STABLE-RENDITION-ID', summary: 'An id that survives playlist reloads, for content steering.' },
    ],
  },
  {
    name: 'EXT-X-STREAM-INF',
    scope: 'master',
    since: 1,
    summary: 'One rung of the ladder. The next line is its playlist. BANDWIDTH is the only required attribute and the number ABR ranks rungs on.',
    attributeList: true,
    attributes: [
      { name: 'BANDWIDTH', summary: 'Peak bitrate in bits per second.', required: true },
      { name: 'AVERAGE-BANDWIDTH', summary: 'What the rendition actually costs over its length, as opposed to its peak.' },
      { name: 'CODECS', summary: 'RFC 6381 codec strings. One quoted value with commas inside it.' },
      { name: 'RESOLUTION', summary: 'Frame size, written 1920x1080.' },
      { name: 'FRAME-RATE', summary: 'Frames per second. Apple wants it above 30.' },
      { name: 'HDCP-LEVEL', summary: 'The output protection the rendition requires.', values: ['NONE', 'TYPE-0', 'TYPE-1'] },
      { name: 'AUDIO', summary: 'GROUP-ID of the audio renditions this rung uses.' },
      { name: 'SUBTITLES', summary: 'GROUP-ID of its subtitles.' },
      { name: 'CLOSED-CAPTIONS', summary: 'GROUP-ID of its captions, or NONE.' },
      { name: 'VIDEO', summary: 'GROUP-ID of alternate video renditions.' },
      { name: 'SCORE', summary: 'A preference among rungs of equal quality, for players that support it.' },
      { name: 'PATHWAY-ID', summary: 'Which content-steering pathway the rung belongs to.' },
      { name: 'STABLE-VARIANT-ID', summary: 'An id that survives playlist reloads, for content steering.' },
      { name: 'VIDEO-RANGE', summary: 'The dynamic range of the video.', values: ['SDR', 'HLG', 'PQ'] },
    ],
  },
  {
    name: 'EXT-X-I-FRAME-STREAM-INF',
    scope: 'master',
    since: 4,
    summary: 'An I-frame-only rendition for scrubbing. Its URI is an attribute, not the next line — which is why it is not a rung of the ladder.',
    attributeList: true,
    attributes: [
      { name: 'BANDWIDTH', summary: 'Peak bitrate in bits per second.', required: true },
      { name: 'URI', summary: 'The I-frame playlist.', required: true },
      { name: 'CODECS', summary: 'RFC 6381 codec strings.' },
      { name: 'RESOLUTION', summary: 'Frame size, written 1920x1080.' },
      { name: 'VIDEO-RANGE', summary: 'The dynamic range of the video.', values: ['SDR', 'HLG', 'PQ'] },
    ],
  },
  {
    name: 'EXT-X-IMAGE-STREAM-INF',
    scope: 'master',
    since: 7,
    summary: 'A thumbnail track (Roku-style image playlists), used by players that show a filmstrip while scrubbing.',
    attributeList: true,
    attributes: [
      { name: 'BANDWIDTH', summary: 'Peak bitrate in bits per second.', required: true },
      { name: 'URI', summary: 'The image playlist.', required: true },
      { name: 'RESOLUTION', summary: 'Size of one thumbnail.' },
    ],
  },
  {
    name: 'EXT-X-SESSION-DATA',
    scope: 'master',
    since: 7,
    summary: 'Arbitrary metadata carried in the master playlist, so a player can read it without loading a rendition.',
    attributeList: true,
    attributes: [
      { name: 'DATA-ID', summary: 'Reverse-DNS identifier of the datum.', required: true },
      { name: 'VALUE', summary: 'The value itself.' },
      { name: 'URI', summary: 'A JSON resource holding the value.' },
      { name: 'LANGUAGE', summary: 'RFC 5646 language tag of the value.' },
    ],
  },
  {
    name: 'EXT-X-SESSION-KEY',
    scope: 'master',
    since: 7,
    summary: 'Lets a player fetch the content key while it is still reading the master, instead of stalling on the first segment.',
    attributeList: true,
    attributes: [
      { name: 'METHOD', summary: 'The encryption method. NONE is not allowed here.', required: true, values: ['AES-128', 'SAMPLE-AES'] },
      { name: 'URI', summary: 'Where to fetch the key.', required: true },
      { name: 'IV', summary: 'The initialisation vector, as a hex string.' },
      { name: 'KEYFORMAT', summary: 'How the key is presented.' },
      { name: 'KEYFORMATVERSIONS', summary: 'Which versions of that key format apply.' },
    ],
  },
  {
    name: 'EXT-X-INDEPENDENT-SEGMENTS',
    scope: 'both',
    since: 6,
    summary: 'Every segment starts with an independent frame, so a player can switch rungs at any segment boundary.',
    attributes: [],
  },
  {
    name: 'EXT-X-START',
    scope: 'both',
    since: 6,
    summary: 'Where playback should start: a positive offset from the beginning, or a negative one from the live edge.',
    attributeList: true,
    attributes: [
      { name: 'TIME-OFFSET', summary: 'Seconds from the start, or from the end when negative.', required: true },
      { name: 'PRECISE', summary: 'Start exactly there rather than at the preceding segment boundary.', values: YES_NO },
    ],
  },
  {
    name: 'EXT-X-DEFINE',
    scope: 'both',
    since: 8,
    summary: 'A variable the rest of the playlist can substitute with {$name}, so one template serves several deployments.',
    attributeList: true,
    attributes: [
      { name: 'NAME', summary: 'The variable being defined.' },
      { name: 'VALUE', summary: 'Its value.' },
      { name: 'IMPORT', summary: 'Take the value from the multivariant playlist that referenced this one.' },
      { name: 'QUERYPARAM', summary: 'Take the value from the query parameter of this playlist request.' },
    ],
  },
  {
    name: 'EXT-X-CONTENT-STEERING',
    scope: 'master',
    since: 12,
    summary: 'Points at a steering manifest that tells players which CDN pathway to prefer, and lets it change during playback.',
    attributeList: true,
    attributes: [
      { name: 'SERVER-URI', summary: 'The steering manifest.', required: true },
      { name: 'PATHWAY-ID', summary: 'The pathway to start on.' },
    ],
  },
  {
    name: 'EXT-X-ALLOW-CACHE',
    scope: 'media',
    since: 1,
    summary: 'Removed from the specification in version 7. Players ignore it; caching is a matter for HTTP headers.',
    attributes: [],
  },
];

const BY_NAME = new Map(SPEC_TAGS.map((t) => [t.name, t]));

/** tagSpec looks a tag up, with or without its leading '#'. */
export function tagSpec(name: string): TagSpec | undefined {
  return BY_NAME.get(name.replace(/^#/, '').trim().toUpperCase());
}

/** renderTagHover renders the reference for one tag as markdown. */
export function renderTagHover(name: string): string | undefined {
  const spec = tagSpec(name);
  if (!spec) return undefined;
  const where = spec.scope === 'both' ? 'master and media playlists' : `${spec.scope} playlists`;
  const lines = [`**#${spec.name}** — ${where}, since version ${spec.since}`, '', spec.summary];
  const documented = spec.attributes.filter((a) => a.name);
  if (documented.length > 0) {
    lines.push('', '| Attribute | Meaning |', '|---|---|');
    for (const attr of documented) {
      const values = attr.values ? ` One of ${attr.values.join(', ')}.` : '';
      lines.push(`| \`${attr.name}\`${attr.required ? ' *(required)*' : ''} | ${attr.summary}${values} |`);
    }
  } else if (spec.attributes.length === 1 && spec.attributes[0].values) {
    lines.push('', `Values: ${spec.attributes[0].values.join(', ')}.`);
  }
  return lines.join('\n');
}

/** What completeAt decided the cursor is sitting in. */
export interface Completion {
  kind: 'tag' | 'attribute' | 'value' | 'none';
  items: string[];
}

/**
 * completeAt reads the line up to the cursor and says what belongs there: a tag name
 * at the start of a line, an attribute name inside a tag that takes an attribute
 * list, or the enumerated values of the attribute being written.
 *
 * `kind` is what the playlist is, so a media playlist is not offered EXT-X-STREAM-INF
 * and a master is not offered EXTINF. It works on one line of text because that is
 * all a completion has: the parse of the rest of the document says nothing about a
 * line the user is still typing.
 */
export function completeAt(line: string, character: number, kind: 'master' | 'media' | 'unknown'): Completion {
  const before = line.slice(0, character);
  if (!before.startsWith('#')) return { kind: 'none', items: [] };

  const colon = before.indexOf(':');
  if (colon < 0) {
    const typed = before.slice(1).toUpperCase();
    const items = SPEC_TAGS.filter((t) => t.scope === 'both' || kind === 'unknown' || t.scope === kind)
      .map((t) => t.name)
      .filter((name) => name.startsWith(typed));
    return { kind: 'tag', items };
  }

  const spec = tagSpec(before.slice(1, colon));
  if (!spec || !spec.attributeList) return { kind: 'none', items: [] };

  const attrs = before.slice(colon + 1);
  const current = attrs.slice(attrs.lastIndexOf(',') + 1);
  const equals = current.indexOf('=');
  if (equals >= 0) {
    const attr = spec.attributes.find((a) => a.name === current.slice(0, equals).trim().toUpperCase());
    return { kind: 'value', items: attr?.values ? [...attr.values] : [] };
  }

  // Names already on the line are not offered again: an attribute list may not repeat one.
  const used = new Set(
    attrs
      .split(',')
      .map((piece) => piece.split('=')[0].trim().toUpperCase())
      .filter(Boolean),
  );
  const typed = current.trim().toUpperCase();
  return {
    kind: 'attribute',
    items: spec.attributes
      .filter((a) => a.name && !used.has(a.name))
      .map((a) => a.name)
      .filter((name) => name.startsWith(typed)),
  };
}

/** The parser's tag set, re-exported so a caller needs one import to check both. */
export const SPEC_COVERS_PARSER = KNOWN_TAG_NAMES.every((name) => BY_NAME.has(name));
