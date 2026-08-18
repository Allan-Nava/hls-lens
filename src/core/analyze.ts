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
import { Playlist, Segment, Variant, Tag } from './playlist';
import { attrFloat, attrInt } from './attrs';
import { isPlainHttp, looksLikeFmp4Uri } from './uri';

/** Consecutive rungs closer than this are indistinguishable to ABR. */
const LADDER_MIN_RATIO = 1.5;
/** Consecutive rungs further apart than this leave nothing to fall back to. */
const LADDER_MAX_RATIO = 2.5;
/** A DURATION may disagree with END-DATE minus START-DATE by this much. */
const DATERANGE_TOLERANCE_S = 1;
/** A part may exceed PART-TARGET by this much before it is worth a finding. */
const PART_TARGET_TOLERANCE_S = 0.001;
/** CAN-SKIP-UNTIL has a floor of this many target durations. */
const SKIP_BOUNDARY_TARGETS = 6;
/** How many segments a rendition report may be away from the playlist carrying it. */
const RENDITION_REPORT_SLACK = 1;

/**
 * H.264 levels: the frame size in macroblocks and the macroblock rate each one
 * allows (ITU-T H.264 table A-1). The key is level_idc as it appears in the last
 * two hex digits of an avc1 codec string.
 */
const AVC_LEVELS: Record<number, { name: string; maxFrameMbs: number; maxMbsPerSecond: number }> = {
  10: { name: '1.0', maxFrameMbs: 99, maxMbsPerSecond: 1485 },
  11: { name: '1.1', maxFrameMbs: 396, maxMbsPerSecond: 3000 },
  12: { name: '1.2', maxFrameMbs: 396, maxMbsPerSecond: 6000 },
  13: { name: '1.3', maxFrameMbs: 396, maxMbsPerSecond: 11880 },
  20: { name: '2.0', maxFrameMbs: 396, maxMbsPerSecond: 11880 },
  21: { name: '2.1', maxFrameMbs: 792, maxMbsPerSecond: 19800 },
  22: { name: '2.2', maxFrameMbs: 1620, maxMbsPerSecond: 20250 },
  30: { name: '3.0', maxFrameMbs: 1620, maxMbsPerSecond: 40500 },
  31: { name: '3.1', maxFrameMbs: 3600, maxMbsPerSecond: 108000 },
  32: { name: '3.2', maxFrameMbs: 5120, maxMbsPerSecond: 216000 },
  40: { name: '4.0', maxFrameMbs: 8192, maxMbsPerSecond: 245760 },
  41: { name: '4.1', maxFrameMbs: 8192, maxMbsPerSecond: 245760 },
  42: { name: '4.2', maxFrameMbs: 8704, maxMbsPerSecond: 522240 },
  50: { name: '5.0', maxFrameMbs: 22080, maxMbsPerSecond: 589824 },
  51: { name: '5.1', maxFrameMbs: 36864, maxMbsPerSecond: 983040 },
  52: { name: '5.2', maxFrameMbs: 36864, maxMbsPerSecond: 2073600 },
  60: { name: '6.0', maxFrameMbs: 139264, maxMbsPerSecond: 4177920 },
  61: { name: '6.1', maxFrameMbs: 139264, maxMbsPerSecond: 8355840 },
  62: { name: '6.2', maxFrameMbs: 139264, maxMbsPerSecond: 16711680 },
};

/**
 * avcLevelOf decodes the level from an RFC 6381 avc1/avc3 string: `avc1.PPCCLL`,
 * where LL is level_idc in hex. Level 1b is the exception — level_idc 11 with the
 * constraint_set3 bit set — and anything that is not this shape returns undefined,
 * which the caller reads as "no opinion".
 */
function avcLevelOf(codecs: string[]): { name: string; maxFrameMbs: number; maxMbsPerSecond: number } | undefined {
  for (const codec of codecs) {
    const m = /^avc[13]\.([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(codec.trim());
    if (!m) continue;
    const constraints = parseInt(m[2], 16);
    const levelIdc = parseInt(m[3], 16);
    if (levelIdc === 11 && (constraints & 0x10) !== 0) {
      return { name: '1b', maxFrameMbs: 99, maxMbsPerSecond: 1485 };
    }
    return AVC_LEVELS[levelIdc];
  }
  return undefined;
}

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
  scope: 'syntax' | 'master' | 'media' | 'cross' | 'dash';
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
    id: 'master/codecs-resolution-mismatch',
    severity: 'warning',
    scope: 'master',
    title: 'The CODECS level can carry the declared RESOLUTION and FRAME-RATE',
    rationale:
      'An H.264 level caps the frame size and the macroblock rate. A rung that advertises avc1.4d401e (Main@3.0, 1620 macroblocks) and RESOLUTION=1920x1080 is telling players it cannot decode what it is offering: strict devices — TVs and set-top boxes, rarely the browser you tested in — refuse the rung and fall back, or fail.',
  },
  {
    id: 'master/ladder-spacing',
    severity: 'hint',
    scope: 'master',
    title: 'Consecutive rungs are far enough apart, and not too far',
    rationale:
      'Rungs less than about 1.5x apart in bitrate are indistinguishable to ABR: it pays for a second encode and a second cache entry that no switching decision can use. A gap wider than about 2.5x is the opposite problem — when the connection cannot hold the upper rung there is nothing to fall back to except a much worse picture.',
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
    id: 'media/part-without-part-inf',
    severity: 'error',
    scope: 'media',
    title: 'A playlist that publishes parts declares EXT-X-PART-INF',
    rationale:
      'PART-TARGET is how a player sizes its part requests and its blocking reload. Parts with no target at all leave it guessing on every fetch, which is the opposite of the predictability low latency depends on.',
  },
  {
    id: 'media/part-exceeds-part-target',
    severity: 'error',
    scope: 'media',
    title: 'No part is longer than PART-TARGET',
    rationale:
      'A player sizes its blocking reload on PART-TARGET. A part longer than the target arrives after the player expected the next one, which is a stall exactly at the live edge — where there is no buffer to absorb it.',
  },
  {
    id: 'media/part-target-too-large',
    severity: 'warning',
    scope: 'media',
    title: 'A part is a fraction of a segment',
    rationale:
      'PART-TARGET at or above TARGETDURATION means a part is as long as a segment: the playlist pays the full cost of low latency — more requests, more tags, a blocking reload — and delivers none of the latency it exists for.',
  },
  {
    id: 'media/can-skip-until-too-small',
    severity: 'warning',
    scope: 'media',
    title: 'CAN-SKIP-UNTIL leaves six target durations',
    rationale:
      'The spec puts the floor at six target durations. A boundary below it is one no conforming client is allowed to ask for, so the playlist deltas the server went to the trouble of supporting are never requested.',
  },
  {
    id: 'media/preload-hint',
    severity: 'error',
    scope: 'media',
    title: 'Preload hints are well formed and unique per type',
    rationale:
      'A hint is a request the player makes before the resource exists, and it can only make one per type: a hint with no URI has nothing to request, and two hints of the same type leave the player to guess which one the server will answer.',
  },
  {
    id: 'media/preload-hint-not-preloading',
    severity: 'warning',
    scope: 'media',
    title: 'The preload hint points at what does not exist yet',
    rationale:
      'A hint for a part the playlist already lists is a request the player would have made anyway, and a TYPE=PART hint in a playlist with no parts continues nothing. Both look like low latency in the manifest and cost a round trip in the player.',
  },
  {
    id: 'media/rendition-report',
    severity: 'error',
    scope: 'media',
    title: 'Rendition reports name a rendition and a position',
    rationale:
      'URI and LAST-MSN are what a report is: which rendition, and how far along. Without both a switching player cannot use it and falls back to fetching the other playlist — the round trip the report exists to save.',
  },
  {
    id: 'media/rendition-report-out-of-step',
    severity: 'warning',
    scope: 'media',
    title: 'Rendition reports are level with the playlist that carries them',
    rationale:
      'A report several segments behind this playlist means the rungs are not being published in step, or the report is stale. A player that switches on it asks for a segment that is not there yet, or restarts from one it has already played.',
  },
  {
    id: 'media/rendition-report-missing',
    severity: 'hint',
    scope: 'media',
    title: 'A low-latency playlist reports the other renditions',
    rationale:
      'Without a rendition report, a player switching rungs has to fetch the other playlist before it can request anything from it. That round trip at the live edge is exactly what the low-latency tags were added to remove.',
  },
  {
    id: 'syntax/define-malformed',
    severity: 'error',
    scope: 'syntax',
    title: 'Every EXT-X-DEFINE declares exactly one variable, once',
    rationale:
      'A NAME with no VALUE, two ways of giving the same variable a value, or the same name defined twice all leave a player to choose — and the choice lands in a URI, so the wrong one is a request to the wrong host. IMPORT takes its value from the multivariant playlist, so it has nothing to import in a master.',
  },
  {
    id: 'syntax/undefined-variable',
    severity: 'error',
    scope: 'syntax',
    title: 'Every {$name} is a variable something declares',
    rationale:
      'Substitution is textual and there is no error path: a reference nothing declares stays in the URI exactly as written, braces included, and the player requests it that way. The 404 names a host with a { in it, which is the one clue that this is what happened.',
  },
  {
    id: 'master/session-data',
    severity: 'error',
    scope: 'master',
    title: 'Session data carries one value under an id it does not share',
    rationale:
      'EXT-X-SESSION-DATA exists so a player can read metadata without loading a rendition. With neither VALUE nor URI there is no datum; with both there are two answers; and two entries sharing DATA-ID and LANGUAGE make which one a player reads arbitrary.',
  },
  {
    id: 'master/content-steering',
    severity: 'error',
    scope: 'master',
    title: 'Content steering points somewhere, once, at a pathway that exists',
    rationale:
      'Steering is what moves traffic between CDNs during playback. Without SERVER-URI there is nothing to poll, a second tag makes the pathway a player starts on arbitrary, and a PATHWAY-ID no variant declares steers every player onto a pathway with no renditions in it.',
  },
  {
    id: 'media/start-offset',
    severity: 'warning',
    scope: 'media',
    title: 'EXT-X-START lands inside the playlist',
    rationale:
      'TIME-OFFSET is where playback begins. Past the end of the playlist a player falls back to its own default, so the tag does nothing; and a negative offset inside the three target durations a player buffers puts the start point where there is not yet enough media to play.',
  },
  {
    id: 'cross/session-key-mismatch',
    severity: 'warning',
    scope: 'cross',
    title: 'The session key matches the keys the renditions use',
    rationale:
      'EXT-X-SESSION-KEY exists to let a player fetch the content key while it is still reading the master, instead of stalling on the first segment. A session key whose METHOD or KEYFORMAT no rendition uses is a fetch spent on a key that decrypts nothing — the stall it was meant to remove, plus a request.',
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
  {
    id: 'media/daterange',
    severity: 'warning',
    scope: 'media',
    title: 'EXT-X-DATERANGE ranges are well formed and do not overlap',
    rationale:
      'Ad breaks are described by these ranges, and a player acts on them: a DURATION that disagrees with END-DATE, two ranges of the same CLASS covering the same seconds, or a CUE-IN with nothing to close all end the same way — an ad that does not start, does not end, or is billed and never shown.',
  },
  {
    id: 'media/key-rotation',
    severity: 'hint',
    scope: 'media',
    title: 'A long-running live stream rotates its content key',
    rationale:
      'One key for the whole window means one key for the whole event: a key extracted from a browser once decrypts everything that follows, indefinitely. Rotation puts a bound on what a leak is worth.',
  },
  {
    id: 'media/key-dropped',
    severity: 'warning',
    scope: 'media',
    title: 'Encryption is not switched off part-way through',
    rationale:
      'An EXT-X-KEY:METHOD=NONE after encrypted segments leaves the rest of the playlist in the clear. It is almost always a packager restarting without its key configuration rather than a deliberate decision, and nothing else in the stream complains.',
  },
  {
    id: 'media/iframe-playlist-shape',
    severity: 'warning',
    scope: 'media',
    title: 'An I-frames-only playlist addresses byte ranges',
    rationale:
      'EXT-X-I-FRAMES-ONLY exists so a player can fetch single frames while scrubbing. Segments without EXT-X-BYTERANGE make it download a whole segment per thumbnail, which is the cost trick play was meant to avoid.',
  },
  {
    id: 'cross/version-mismatch',
    severity: 'warning',
    scope: 'cross',
    title: 'Every rendition declares the same EXT-X-VERSION',
    rationale:
      'A player honours the version of the playlist it is reading. One rendition declaring less than the others means the tags the rest of the stream relies on may be ignored on exactly the rung a device happened to pick.',
  },
  {
    id: 'cross/target-duration-mismatch',
    severity: 'warning',
    scope: 'cross',
    title: 'Every rendition declares the same EXT-X-TARGETDURATION',
    rationale:
      'Target duration drives buffering and the reload interval. Renditions that disagree about it are segmented differently, which is the first symptom of two encoders that were not configured from the same source.',
  },
  {
    id: 'cross/playlist-type-mismatch',
    severity: 'error',
    scope: 'cross',
    title: 'The renditions are all live, or all finished',
    rationale:
      'One rendition carrying EXT-X-ENDLIST while the others are still live strands every player that switches to it: it believes the stream ended and stops. It is what a packager leaves behind when one encoder finishes early.',
  },
  {
    id: 'cross/media-sequence-mismatch',
    severity: 'warning',
    scope: 'cross',
    title: 'The live windows start at the same media sequence',
    rationale:
      'Windows that are offset mean a player switching rungs jumps forwards or backwards in time by the difference — visible as a skip or a repeat exactly when the connection got worse.',
  },
  {
    id: 'cross/segment-count-mismatch',
    severity: 'error',
    scope: 'cross',
    title: 'The renditions hold the same number of segments',
    rationale:
      'Renditions of one stream are segmented identically so a player can switch at any boundary. A different count is a different timeline, and switching lands somewhere the player did not intend.',
  },
  {
    id: 'cross/timeline-drift',
    severity: 'error',
    scope: 'cross',
    title: 'Segment boundaries land at the same time in every rendition',
    rationale:
      'Equal segment counts can still hide different boundaries. A player that switches rungs continues at the boundary it knows, so drift shows up as a picture that starts mid-segment or a fraction of a second repeated.',
  },
  {
    id: 'cross/discontinuity-mismatch',
    severity: 'error',
    scope: 'cross',
    title: 'Discontinuities land on the same segment in every rendition',
    rationale:
      'An ad break or an encoder restart that is one segment out on one rung breaks the switch precisely where the stream is already changing — the hardest place to diagnose from a single file.',
  },
  {
    id: 'cross/bitrate-vs-declared',
    severity: 'warning',
    scope: 'cross',
    title: 'BANDWIDTH covers the bitrate the rendition declares',
    rationale:
      'BANDWIDTH is the peak a rendition can reach, and ABR provisions against it. A playlist whose own EXT-X-BITRATE is higher than the master promises makes the player pick a rung the connection cannot carry, and rebuffer.',
  },
  {
    id: 'dash/not-an-mpd',
    severity: 'error',
    scope: 'dash',
    title: 'The file is an MPD',
    rationale:
      'A .mpd whose root is not <MPD> is nearly always an error page or a redirect saved by hand. Saying so once is more use than reporting every attribute it does not have.',
  },
  {
    id: 'dash/malformed-xml',
    severity: 'error',
    scope: 'dash',
    title: 'The manifest is well-formed XML',
    rationale:
      'Players parse an MPD strictly. A document that does not close its elements is not read at all, however good the rest of the packaging is.',
  },
  {
    id: 'dash/missing-presentation-duration',
    severity: 'warning',
    scope: 'dash',
    title: 'A static MPD declares @mediaPresentationDuration',
    rationale:
      'Without it a player cannot know how long the asset is: no seek bar, no end, and no way to tell a truncated manifest from a complete one.',
  },
  {
    id: 'dash/duration-vs-timeline',
    severity: 'warning',
    scope: 'dash',
    title: '@mediaPresentationDuration matches the segment timeline',
    rationale:
      'The declared duration and the segments have to describe the same presentation. Claiming more media than the timeline addresses makes players stall at the end or seek into nothing; claiming less leaves the tail unreachable.',
  },
  {
    id: 'dash/timeline-gap',
    severity: 'error',
    scope: 'dash',
    title: 'SegmentTimeline entries chain without gaps or overlaps',
    rationale:
      'Each <S> starts where the previous one ended unless @t says otherwise. A @t that disagrees is a hole in the presentation — or two segments claiming the same seconds — and it is invisible until you add the durations up.',
  },
  {
    id: 'dash/dynamic-without-utctiming',
    severity: 'warning',
    scope: 'dash',
    title: 'A dynamic MPD carries UTCTiming',
    rationale:
      'A live DASH client computes which segment exists from its own clock and @availabilityStartTime. Without a UTCTiming element to synchronise to, a device whose clock is seconds off requests segments that do not exist yet, and buffers for reasons no server log explains.',
  },
  {
    id: 'dash/adaptationset-not-aligned',
    severity: 'warning',
    scope: 'dash',
    title: 'Adaptation sets with several representations declare @segmentAlignment',
    rationale:
      'A player may only switch representations at aligned boundaries. Without the flag it has to assume it cannot, and the adaptation the ladder was built for does not happen.',
  },
  {
    id: 'dash/missing-bandwidth',
    severity: 'error',
    scope: 'dash',
    title: 'Every representation declares @bandwidth',
    rationale:
      '@bandwidth is required by the schema and is what adaptation ranks representations on. Without it a representation cannot be chosen deliberately.',
  },
  {
    id: 'dash/missing-codecs',
    severity: 'warning',
    scope: 'dash',
    title: 'Representations declare @codecs',
    rationale:
      'Without @codecs — on the representation or inherited from the adaptation set — a player has to fetch media to find out whether it can decode it, which costs startup time and sometimes fails outright.',
  },
  {
    id: 'dash/segment-template-without-number',
    severity: 'error',
    scope: 'dash',
    title: 'A segment template addresses more than one segment',
    rationale:
      'A @media template with neither $Number$ nor $Time$ resolves every segment to the same URL: the player fetches the first segment forever.',
  },
  {
    id: 'dash/segment-template-without-init',
    severity: 'warning',
    scope: 'dash',
    title: 'A segment template names an initialisation segment',
    rationale:
      'Fragmented MP4 needs the initialisation segment to configure the decoder. Without @initialization the first media segment arrives with nothing to decode it.',
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
  { version: 8, feature: 'EXT-X-DEFINE', used: (pl) => pl.defines.length > 0 },
  {
    version: 9,
    feature: 'low-latency partial segments',
    used: (pl) => pl.parts.length > 0 || pl.partTarget !== null || pl.tags.some((t) => t.name === 'EXT-X-SKIP' || t.name === 'EXT-X-PRELOAD-HINT'),
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
  checkDefines(pl, add);

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

  checkSessionData(pl, add);
  checkContentSteering(pl, add);

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

  checkCodecsAgainstPicture(playable, add);
  checkLadderSpacing(withBandwidth, add);
}

/**
 * checkCodecsAgainstPicture compares the declared H.264 level with the picture the
 * variant claims to deliver. Only avc1/avc3 are decoded: for anything else — HEVC,
 * AV1, a codec string that does not parse — the rule has no opinion rather than a
 * guess, because a wrong warning about a working rung costs more than a missing one.
 */
function checkCodecsAgainstPicture(playable: Variant[], add: Add): void {
  for (const v of playable) {
    if (!v.resolution) continue;
    const level = avcLevelOf(v.codecs);
    if (!level) continue;

    const frameMbs = Math.ceil(v.resolution.width / 16) * Math.ceil(v.resolution.height / 16);
    const label = v.uri || `line ${v.line + 1}`;
    if (frameMbs > level.maxFrameMbs) {
      add(
        'master/codecs-resolution-mismatch',
        v.line,
        `the variant "${label}" declares RESOLUTION=${v.resolution.width}x${v.resolution.height} (${frameMbs} macroblocks) but its CODECS says H.264 level ${level.name}, which tops out at ${level.maxFrameMbs}`,
        `raise the level in the CODECS string to what the encoder actually produced, or encode the rung smaller`,
      );
      continue; // the size is already wrong; the rate would only repeat it
    }
    if (v.frameRate !== null && frameMbs * v.frameRate > level.maxMbsPerSecond) {
      add(
        'master/codecs-resolution-mismatch',
        v.line,
        `the variant "${label}" declares ${v.resolution.width}x${v.resolution.height} at ${v.frameRate}fps (${Math.round(frameMbs * v.frameRate)} macroblocks/s) but H.264 level ${level.name} allows ${level.maxMbsPerSecond}`,
        'raise the level in the CODECS string, or lower the frame rate of the rung',
      );
    }
  }
}

/** checkLadderSpacing reports rungs ABR cannot distinguish, and gaps it cannot bridge. */
function checkLadderSpacing(withBandwidth: Variant[], add: Add): void {
  const rungs = [...withBandwidth].sort((a, b) => a.bandwidth! - b.bandwidth!);
  for (let i = 1; i < rungs.length; i++) {
    const lower = rungs[i - 1].bandwidth!;
    const upper = rungs[i].bandwidth!;
    if (lower <= 0) continue;
    const ratio = upper / lower;
    if (ratio < LADDER_MIN_RATIO) {
      add(
        'master/ladder-spacing',
        rungs[i].line,
        `this rung is only ${ratio.toFixed(2)}x the bitrate of the one below it (${lower} → ${upper}): ABR cannot tell them apart`,
        `space the rungs at least ${LADDER_MIN_RATIO}x apart, or drop one of them`,
      );
    } else if (ratio > LADDER_MAX_RATIO) {
      add(
        'master/ladder-spacing',
        rungs[i].line,
        `this rung is ${ratio.toFixed(2)}x the bitrate of the one below it (${lower} → ${upper}): there is nothing to fall back to in between`,
        `add a rung between them, or keep consecutive rungs under ${LADDER_MAX_RATIO}x`,
      );
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

  checkDateRanges(pl, add);
  checkKeyLifecycle(pl, add, isLive);
  if (pl.iframesOnly) {
    const whole = pl.segments.find((s) => s.byterange === null);
    if (whole) {
      add(
        'media/iframe-playlist-shape',
        whole.uriLine,
        `this EXT-X-I-FRAMES-ONLY playlist addresses whole segments (${whole.uri}) instead of byte ranges`,
        'point the segments at byte ranges of the media file with EXT-X-BYTERANGE, so scrubbing fetches frames and not segments',
      );
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

  if (pl.parts.length > 0 || pl.partTarget !== null) {
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

  checkLowLatency(pl, add);
  checkStart(pl, add, isLive);

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

/**
 * The low-latency half of a media playlist: the partial segments, the preload hint
 * and the rendition reports.
 *
 * All of it is about a player that has to act on the playlist *before* the media
 * exists — so a declaration that does not hold costs a request that cannot be
 * cancelled, or a switch that lands nowhere. Whether the part is really 500ms of
 * video is segcheck's question, not this one's.
 */
function checkLowLatency(pl: Playlist, add: Add): void {
  const lowLatency = pl.parts.length > 0 || pl.partTarget !== null;

  if (pl.parts.length > 0 && pl.partTarget === null) {
    add(
      'media/part-without-part-inf',
      pl.parts[0].line,
      'the playlist publishes EXT-X-PART with no EXT-X-PART-INF: nothing tells a player how long a part is meant to be',
      'declare #EXT-X-PART-INF:PART-TARGET=<the part duration>',
    );
  }

  if (pl.partTarget !== null) {
    for (const part of pl.parts) {
      if (part.duration === null || part.duration <= pl.partTarget + PART_TARGET_TOLERANCE_S) continue;
      add(
        'media/part-exceeds-part-target',
        part.line,
        `this part is ${part.duration}s, longer than the PART-TARGET of ${pl.partTarget}s the playlist declares`,
        'shorten the part, or raise PART-TARGET to the longest part the packager emits',
      );
    }
    if (pl.targetDuration !== null && pl.partTarget >= pl.targetDuration) {
      add(
        'media/part-target-too-large',
        pl.partInfLine ?? 0,
        `PART-TARGET is ${pl.partTarget}s against a target duration of ${pl.targetDuration}s: a part is as long as a segment`,
        'a part is a fraction of a segment — a target of a quarter to a tenth of the segment is the usual shape',
      );
    }
  }

  if (pl.serverControl && pl.targetDuration !== null) {
    const canSkip = attrFloat(pl.serverControl, 'CAN-SKIP-UNTIL');
    const floor = SKIP_BOUNDARY_TARGETS * pl.targetDuration;
    if (canSkip !== null && canSkip < floor) {
      add(
        'media/can-skip-until-too-small',
        pl.serverControlLine ?? 0,
        `CAN-SKIP-UNTIL is ${canSkip}s, under the six target durations (${floor}s) the spec requires`,
        `raise CAN-SKIP-UNTIL to at least ${floor}: a boundary no client may ask for is a delta nothing uses`,
      );
    }
  }

  // What the playlist already publishes: a hint for one of these is a request the
  // player could have made from the playlist it is holding.
  const published = new Set<string>();
  for (const part of pl.parts) if (part.uri) published.add(part.uri);
  for (const segment of pl.segments) published.add(segment.uri);

  const hintTypes = new Map<string, number>();
  for (const hint of pl.preloadHints) {
    const type = (hint.attrs.get('TYPE') ?? '').toUpperCase();
    const uri = hint.attrs.get('URI') ?? '';
    if (!type || !uri) {
      add(
        'media/preload-hint',
        hint.line,
        `this EXT-X-PRELOAD-HINT declares no ${!type ? 'TYPE' : 'URI'}`,
        'both TYPE and URI are required: without them there is nothing to request',
      );
      continue;
    }
    const first = hintTypes.get(type);
    if (first !== undefined) {
      add(
        'media/preload-hint',
        hint.line,
        `a second EXT-X-PRELOAD-HINT of TYPE=${type}; the first is on line ${first + 1}`,
        'the spec allows one hint per type — a player cannot know which of two to block on',
      );
    } else {
      hintTypes.set(type, hint.line);
    }

    if (published.has(uri)) {
      add(
        'media/preload-hint-not-preloading',
        hint.line,
        `the hint points at "${uri}", which this playlist already publishes`,
        'hint the resource that does not exist yet: a hint for something published is a request the player would have made anyway',
      );
    } else if (type === 'PART' && pl.parts.length === 0) {
      add(
        'media/preload-hint-not-preloading',
        hint.line,
        'a TYPE=PART hint in a playlist that publishes no EXT-X-PART',
        'publish the parts, or drop the hint: a player with no parts has nothing to continue from',
      );
    }
  }

  // The last media sequence number this playlist itself holds — what a report about
  // another rendition is expected to be level with.
  const lastMsn = pl.mediaSequence !== null && pl.segments.length > 0 ? pl.mediaSequence + pl.segments.length - 1 : null;
  for (const report of pl.renditionReports) {
    const uri = report.attrs.get('URI') ?? '';
    const msn = attrInt(report.attrs, 'LAST-MSN');
    if (!uri || msn === null) {
      add(
        'media/rendition-report',
        report.line,
        `this EXT-X-RENDITION-REPORT declares no ${!uri ? 'URI' : 'LAST-MSN'}`,
        'a report needs both: the rendition it is about, and how far along it is',
      );
      continue;
    }
    if (lastMsn !== null && Math.abs(msn - lastMsn) > RENDITION_REPORT_SLACK) {
      add(
        'media/rendition-report-out-of-step',
        report.line,
        `the report for "${uri}" says LAST-MSN=${msn} while this playlist is at ${lastMsn}: ${Math.abs(msn - lastMsn)} segments apart`,
        'the renditions are not being published in step, or the report is stale — either way a player switching on it lands in the wrong place',
      );
    }
  }

  if (lowLatency && pl.renditionReports.length === 0 && !pl.hasEndList) {
    add(
      'media/rendition-report-missing',
      pl.partInfLine ?? pl.serverControlLine ?? 0,
      'this low-latency playlist carries no EXT-X-RENDITION-REPORT',
      'report the other renditions: without it a player that switches has to fetch their playlists first, which is the round trip low latency exists to remove',
    );
  }
}

/**
 * checkDefines reads the variable declarations and the references to them.
 *
 * Substitution is textual and has no error path: whatever is not declared is
 * requested with the braces still in it, so both halves of this — a declaration that
 * declares nothing, and a reference to nothing — end as a URL nobody meant to fetch.
 */
function checkDefines(pl: Playlist, add: Add): void {
  const declared = new Map<string, number>();
  for (const tag of pl.defines) {
    const name = tag.attrs.get('NAME');
    const value = tag.attrs.get('VALUE');
    const imported = tag.attrs.get('IMPORT');
    const queryParam = tag.attrs.get('QUERYPARAM');
    const has = (attr: string | undefined): boolean => attr !== undefined;

    // Exactly one of: NAME with VALUE, IMPORT, QUERYPARAM.
    const legal =
      (has(name) && has(value) && !has(imported) && !has(queryParam)) ||
      (has(imported) && !has(name) && !has(value) && !has(queryParam)) ||
      (has(queryParam) && !has(name) && !has(value) && !has(imported));
    if (!legal) {
      const written = [has(name) ? 'NAME' : '', has(value) ? 'VALUE' : '', has(imported) ? 'IMPORT' : '', has(queryParam) ? 'QUERYPARAM' : '']
        .filter(Boolean)
        .join(', ');
      add(
        'syntax/define-malformed',
        tag.line,
        written === ''
          ? 'this EXT-X-DEFINE declares nothing: it needs NAME with VALUE, or IMPORT, or QUERYPARAM'
          : `this EXT-X-DEFINE declares ${written}: it needs NAME with VALUE, or IMPORT, or QUERYPARAM, and only one of the three`,
        'one variable, one source for its value',
      );
    }

    if (has(imported) && (pl.kind === 'master' || pl.kind === 'mixed')) {
      add(
        'syntax/define-malformed',
        tag.line,
        `IMPORT="${imported}" in a master playlist: IMPORT takes the value from the master that referenced this playlist, and a master has none`,
        'declare it with NAME and VALUE here, and IMPORT it in the renditions',
      );
    }

    const variable = name ?? imported ?? queryParam;
    if (variable === undefined) continue;
    const first = declared.get(variable);
    if (first !== undefined) {
      add(
        'syntax/define-malformed',
        tag.line,
        `"${variable}" is already defined on line ${first + 1}: which value applies is the player's guess`,
        'define each variable once',
      );
    } else {
      declared.set(variable, tag.line);
    }
  }

  const reported = new Set<string>();
  for (const ref of pl.variableRefs) {
    if (pl.variables.has(ref.name)) continue;
    const key = `${ref.name}@${ref.line}`;
    if (reported.has(key)) continue;
    reported.add(key);
    add(
      'syntax/undefined-variable',
      ref.line,
      `{$${ref.name}} is used here and no EXT-X-DEFINE declares "${ref.name}": the braces stay in the URI a player requests`,
      `add #EXT-X-DEFINE:NAME="${ref.name}",VALUE="…" above this line, or IMPORT it from the master`,
    );
  }
}

/** checkSessionData: one datum per entry, one entry per id and language. */
function checkSessionData(pl: Playlist, add: Add): void {
  const seen = new Map<string, number>();
  for (const tag of pl.tags.filter((t) => t.name === 'EXT-X-SESSION-DATA')) {
    const id = tag.attrs.get('DATA-ID') ?? '';
    const language = tag.attrs.get('LANGUAGE') ?? '';
    const value = tag.attrs.get('VALUE');
    const uri = tag.attrs.get('URI');
    const label = id ? `"${id}"` : 'this EXT-X-SESSION-DATA';

    if (!id) {
      add('master/session-data', tag.line, 'this EXT-X-SESSION-DATA declares no DATA-ID, which the spec requires', 'add DATA-ID as a reverse-DNS identifier');
    }
    if ((value === undefined) === (uri === undefined)) {
      add(
        'master/session-data',
        tag.line,
        value === undefined ? `${label} declares neither VALUE nor URI: there is no datum` : `${label} declares both VALUE and URI: a player has two answers to one question`,
        'give exactly one of VALUE and URI',
      );
    }

    const key = `${id}\u0000${language}`;
    const first = seen.get(key);
    if (first !== undefined) {
      add(
        'master/session-data',
        tag.line,
        `${label}${language ? ` in ${language}` : ''} is already declared on line ${first + 1}`,
        'LANGUAGE is what lets the same DATA-ID appear twice; without it, once',
      );
    } else {
      seen.set(key, tag.line);
    }
  }
}

/** checkContentSteering: one steering server, and a pathway that has renditions. */
function checkContentSteering(pl: Playlist, add: Add): void {
  const steering = pl.tags.filter((t) => t.name === 'EXT-X-CONTENT-STEERING');
  if (steering.length === 0) return;

  for (const extra of steering.slice(1)) {
    add(
      'master/content-steering',
      extra.line,
      `a second EXT-X-CONTENT-STEERING; the first is on line ${steering[0].line + 1}`,
      'the spec allows one per playlist: with two, which pathway a player starts on is arbitrary',
    );
  }

  const first = steering[0];
  if (!first.attrs.get('SERVER-URI')) {
    add('master/content-steering', first.line, 'this EXT-X-CONTENT-STEERING declares no SERVER-URI: there is no steering manifest to poll', 'add SERVER-URI');
  }

  const pathway = first.attrs.get('PATHWAY-ID');
  const pathways = new Set(pl.variants.map((v) => v.attrs.get('PATHWAY-ID')).filter((p): p is string => p !== undefined));
  if (pathway !== undefined && pathways.size > 0 && !pathways.has(pathway)) {
    add(
      'master/content-steering',
      first.line,
      `PATHWAY-ID="${pathway}" is the pathway to start on and no variant belongs to it (the master declares ${[...pathways].map((p) => `"${p}"`).join(', ')})`,
      'start on a pathway that has renditions, or tag the variants with this one',
    );
  }
}

/** checkStart: where playback begins, against how much playlist there is. */
function checkStart(pl: Playlist, add: Add, isLive: boolean): void {
  for (const tag of pl.tags.filter((t) => t.name === 'EXT-X-START')) {
    const offset = attrFloat(tag.attrs, 'TIME-OFFSET');
    if (offset === null) {
      add('media/start-offset', tag.line, 'this EXT-X-START declares no TIME-OFFSET, the one attribute it requires', 'add TIME-OFFSET in seconds, negative to measure from the live edge');
      continue;
    }
    if (pl.totalDuration > 0 && Math.abs(offset) > pl.totalDuration) {
      add(
        'media/start-offset',
        tag.line,
        `TIME-OFFSET is ${offset}s and the playlist holds ${pl.totalDuration}s: the start point is outside it`,
        'players fall back to their own default, so the tag does nothing at all',
      );
      continue;
    }
    if (isLive && offset < 0 && pl.targetDuration !== null && Math.abs(offset) < 3 * pl.targetDuration) {
      add(
        'media/start-offset',
        tag.line,
        `TIME-OFFSET is ${offset}s, inside the three target durations (${3 * pl.targetDuration}s) a player buffers before it starts`,
        'start further back from the live edge: there is not enough media between that point and the edge to play',
      );
    }
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

/**
 * checkDateRanges validates the EXT-X-DATERANGE tags that describe ad breaks and
 * other timed metadata: a range with no START-DATE, a DURATION that disagrees with
 * END-DATE, two ranges of the same CLASS covering the same seconds, and a CUE-IN
 * with nothing open to close.
 */
function checkDateRanges(pl: Playlist, add: Add): void {
  const ranges = pl.tags.filter((t) => t.name === 'EXT-X-DATERANGE');
  if (ranges.length === 0) return;

  interface Range {
    tag: Tag;
    id: string;
    cls: string;
    start: number;
    end: number | null;
  }
  const parsed: Range[] = [];

  for (const tag of ranges) {
    const id = tag.attrs.get('ID') ?? '';
    const startRaw = tag.attrs.get('START-DATE') ?? '';
    const start = Date.parse(startRaw);
    if (!startRaw || Number.isNaN(start)) {
      add(
        'media/daterange',
        tag.line,
        `the range ${id ? `"${id}"` : 'on this line'} has no usable START-DATE${startRaw ? ` ("${startRaw}")` : ''}, which the spec requires`,
        'add START-DATE as an ISO-8601 timestamp',
      );
      continue;
    }

    const endRaw = tag.attrs.get('END-DATE');
    const end = endRaw ? Date.parse(endRaw) : NaN;
    const duration = attrFloat(tag.attrs, 'DURATION');
    if (endRaw && !Number.isNaN(end) && duration !== null) {
      const implied = (end - start) / 1000;
      if (Math.abs(implied - duration) > DATERANGE_TOLERANCE_S) {
        add(
          'media/daterange',
          tag.line,
          `the range ${id ? `"${id}"` : 'on this line'} declares DURATION=${duration} but END-DATE is ${implied}s after START-DATE`,
          'make DURATION and END-DATE agree; players trust whichever one they read first',
        );
      }
    }

    const explicitEnd = endRaw && !Number.isNaN(end) ? end : null;
    parsed.push({
      tag,
      id,
      cls: tag.attrs.get('CLASS') ?? '',
      start,
      end: explicitEnd ?? (duration !== null ? start + duration * 1000 : null),
    });
  }

  // Overlap is only meaningful inside one CLASS: two different kinds of range are
  // supposed to coexist, two ad breaks are not.
  const byClass = new Map<string, Range[]>();
  for (const r of parsed) {
    byClass.set(r.cls, [...(byClass.get(r.cls) ?? []), r]);
  }
  for (const [, group] of byClass) {
    const sorted = [...group].sort((a, b) => a.start - b.start || a.tag.line - b.tag.line);
    for (let i = 1; i < sorted.length; i++) {
      const previous = sorted[i - 1];
      const current = sorted[i];
      if (previous.end !== null && current.start < previous.end) {
        add(
          'media/daterange',
          current.tag.line,
          `this range ${current.id ? `("${current.id}") ` : ''}starts before the previous one ${previous.id ? `("${previous.id}") ` : ''}ends: the two overlap`,
          'a player in the overlap has to choose one; make the ranges consecutive',
        );
      }
    }
  }

  // SCTE-35 in/out pairing, in the order the tags appear.
  let open = 0;
  for (const tag of ranges) {
    const cue = (tag.attrs.get('CUE') ?? '').toUpperCase();
    if (tag.attrs.has('SCTE35-OUT') || cue.includes('OUT')) open++;
    if (tag.attrs.has('SCTE35-IN') || cue.includes('IN')) {
      if (open === 0) {
        add(
          'media/daterange',
          tag.line,
          `this range closes an ad break (SCTE35-IN) that nothing in the playlist opened`,
          'either the matching SCTE35-OUT range slid out of the window, or the packager emitted the pair out of order',
        );
      } else {
        open--;
      }
    }
  }
}

/**
 * checkKeyLifecycle looks at the EXT-X-KEY tags as a sequence rather than one at a
 * time: a live window covered by a single key, and encryption switched off part-way
 * through.
 */
function checkKeyLifecycle(pl: Playlist, add: Add, isLive: boolean): void {
  const encrypting = pl.keys.filter((k) => (k.attrs.get('METHOD') ?? 'NONE').toUpperCase() !== 'NONE');
  if (encrypting.length === 0) return;

  // METHOD=NONE after encrypted content: everything from that line on is in the clear.
  const firstEncrypted = encrypting[0];
  for (const key of pl.keys) {
    if (key.line <= firstEncrypted.line) continue;
    if ((key.attrs.get('METHOD') ?? '').toUpperCase() !== 'NONE') continue;
    const encryptedSegments = pl.segments.some((s) => s.uriLine > firstEncrypted.line && s.uriLine < key.line);
    if (!encryptedSegments) continue;
    add(
      'media/key-dropped',
      key.line,
      'EXT-X-KEY:METHOD=NONE switches encryption off part-way through: every segment below this line is in the clear',
      'if this is not deliberate, the packager lost its key configuration mid-stream',
    );
    break; // one report: the rest of the playlist is the same finding
  }

  // A live window one key covers. Only for a playlist that has been running (a
  // non-zero media sequence): the first window of a stream has nothing to rotate yet.
  const distinctKeys = new Set(encrypting.map((k) => `${k.attrs.get('METHOD')}|${k.attrs.get('URI') ?? ''}|${k.attrs.get('IV') ?? ''}`));
  if (isLive && distinctKeys.size === 1 && (pl.mediaSequence ?? 0) > 0 && pl.segments.length >= 5) {
    add(
      'media/key-rotation',
      firstEncrypted.line,
      `the whole live window is encrypted with one key (${pl.segments.length} segments, media sequence ${pl.mediaSequence}) and no rotation appears in it`,
      'rotate the content key periodically: a key pulled out of a player once decrypts everything that follows it',
    );
  }
}
