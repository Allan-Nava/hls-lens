// Tests for the pure core (src/core/**): the m3u8 parser, the analysis rules, the
// ladder model, URI resolution, the segcheck bridge and the manifest fetcher.
//
// Nothing here touches the network or a real CDN: the fetcher is tested against a
// throwaway http server on a random local port, and the segcheck bridge is tested
// on the JSON shape the binary emits, never by spawning it.
import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { AddressInfo } from 'net';

import { parseAttributeList, attrInt, attrFloat, attrResolution, attrList, attrBool } from '../src/core/attrs';
import { parsePlaylist, looksLikePlaylist, KNOWN_TAG_NAMES, Playlist } from '../src/core/playlist';
import { tagSpec, renderTagHover, SPEC_TAGS, completeAt } from '../src/core/spec';
import { quickFixesFor } from '../src/core/fixes';
import { analyzeAcross, LoadedRendition } from '../src/core/crosscheck';
import { diffPlaylists, describeChange, watchIntervalMs } from '../src/core/watch';
import { parseXml, findAll, attr } from '../src/core/xml';
import { parseIsoDuration, analyzeMpd } from '../src/core/dash';
import { buildMpdTree, mpdSummary } from '../src/core/mpdtree';
import { frontMatter, renderMarkdown, renderPage, pageTitle } from '../src/core/markdown';
import { buildTimeline, niceTicks, renderTimelineHtml } from '../src/core/timeline';
import { isManifestPath, summariseWorkspace, renderWorkspaceReport } from '../src/core/workspace';
import { renderFindingsMarkdown, renderFindingsJson } from '../src/core/report';
import { analyze, RULES, Finding, Severity, applySeverityOverrides } from '../src/core/analyze';
import { buildLadder, renditionRows, ladderSummary, formatBandwidth, formatResolution, lowLatencyRows } from '../src/core/ladder';
import { resolveUri, baseOf, isRemote, isPlainHttp, looksLikePlaylistUri } from '../src/core/uri';
import { buildSegcheckArgs, parseSegcheckResult, segcheckToFindings, segcheckSummary } from '../src/core/segcheck';
import { fetchText } from '../src/core/fetch';
import { drawIcon, encodePng, decodePng, comparePixels } from '../src/core/png';
import {
  parseBacklog,
  duplicateIds,
  sectionState,
  backlogStats,
  progressBar,
  renderRoadmap,
  markerOf,
  idFromBody,
  issueTitle,
  issueBody,
  orphanMilestones,
} from '../src/core/backlog';

let failures = 0;

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok   ${name}`))
    .catch((err) => {
      failures++;
      console.error(`FAIL ${name}\n     ${err}`);
    });
}

function fixture(name: string): string {
  return fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', name), 'utf8');
}

/** ids of the findings a manifest produces, for compact assertions. */
function ruleIds(findings: Finding[]): string[] {
  return findings.map((f) => f.rule);
}

function severityOf(findings: Finding[], rule: string): Severity | undefined {
  return findings.find((f) => f.rule === rule)?.severity;
}

/**
 * A low-latency media playlist whose header is correct — the hold-backs clear their
 * floors and the part target is an eighth of the segment — so a test only has to
 * write the lines it is actually about.
 */
function llPlaylist(...body: string[]): string {
  return (
    '#EXTM3U\n#EXT-X-VERSION:9\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:10\n' +
    '#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,HOLD-BACK=12.000,PART-HOLD-BACK=1.500\n' +
    '#EXT-X-PART-INF:PART-TARGET=0.500\n#EXT-X-MAP:URI="init.mp4"\n' +
    `${body.join('\n')}\n`
  );
}

/** The findings of one rule, for the assertions that care where it landed. */
function findingsOf(text: string, rule: string): Finding[] {
  return analyze(parsePlaylist(text)).filter((f) => f.rule === rule);
}

async function main(): Promise<void> {
  // ---------------------------------------------------------------- attributes
  await test('parseAttributeList keeps commas inside quoted values', () => {
    const attrs = parseAttributeList('BANDWIDTH=2400000,CODECS="avc1.4d401f,mp4a.40.2",RESOLUTION=1280x720');
    assert.strictEqual(attrs.get('BANDWIDTH'), '2400000');
    assert.strictEqual(attrs.get('CODECS'), 'avc1.4d401f,mp4a.40.2');
    assert.strictEqual(attrs.get('RESOLUTION'), '1280x720');
    assert.strictEqual(attrs.size, 3);
  });

  await test('parseAttributeList tolerates spacing and empty input', () => {
    const attrs = parseAttributeList('TYPE=AUDIO, GROUP-ID="a b" ,DEFAULT=YES');
    assert.strictEqual(attrs.get('GROUP-ID'), 'a b');
    assert.strictEqual(attrs.get('DEFAULT'), 'YES');
    assert.strictEqual(parseAttributeList('').size, 0);
  });

  await test('attribute accessors coerce the HLS value types', () => {
    const attrs = parseAttributeList('BANDWIDTH=2400000,FRAME-RATE=29.970,RESOLUTION=1920x1080,CODECS="a,b",DEFAULT=YES,IV=0x00ff');
    assert.strictEqual(attrInt(attrs, 'BANDWIDTH'), 2400000);
    assert.strictEqual(attrFloat(attrs, 'FRAME-RATE'), 29.97);
    assert.deepStrictEqual(attrResolution(attrs, 'RESOLUTION'), { width: 1920, height: 1080 });
    assert.deepStrictEqual(attrList(attrs, 'CODECS'), ['a', 'b']);
    assert.strictEqual(attrBool(attrs, 'DEFAULT'), true);
    assert.strictEqual(attrBool(attrs, 'MISSING'), false);
    assert.strictEqual(attrInt(attrs, 'MISSING'), null);
    assert.strictEqual(attrInt(attrs, 'IV'), null, 'a hex value is not a decimal integer');
  });

  // -------------------------------------------------------------------- parser
  await test('parsePlaylist reads a master playlist', () => {
    const pl = parsePlaylist(fixture('master-clean.m3u8'));
    assert.strictEqual(pl.kind, 'master');
    assert.strictEqual(pl.version, 7);
    assert.strictEqual(pl.independentSegments, true);
    assert.strictEqual(pl.variants.length, 5, 'four variants plus the I-frame stream');

    const v = pl.variants.find((x) => x.uri === 'video/1080p/index.m3u8');
    assert.ok(v, 'the 1080p variant is parsed');
    assert.strictEqual(v!.bandwidth, 6100000);
    assert.strictEqual(v!.averageBandwidth, 5600000);
    assert.deepStrictEqual(v!.resolution, { width: 1920, height: 1080 });
    assert.deepStrictEqual(v!.codecs, ['avc1.64002a', 'mp4a.40.2']);
    assert.strictEqual(v!.frameRate, 50);
    assert.strictEqual(v!.audio, 'aac-128');
    assert.strictEqual(v!.iframeOnly, false);

    const iframe = pl.variants.find((x) => x.iframeOnly);
    assert.ok(iframe, 'the I-frame stream is a variant flagged as such');
    assert.strictEqual(iframe!.uri, 'video/360p/iframe.m3u8', 'its URI comes from the URI attribute, not the next line');

    assert.strictEqual(pl.renditions.length, 3);
    const audio = pl.renditions.filter((r) => r.type === 'AUDIO');
    assert.strictEqual(audio.length, 2);
    assert.strictEqual(audio[0].isDefault, true);
    assert.strictEqual(audio[1].isDefault, false);
    assert.strictEqual(audio[0].channels, '2');
  });

  await test('parsePlaylist reports 0-based line numbers, which is what the editor wants', () => {
    const pl = parsePlaylist('#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-STREAM-INF:BANDWIDTH=1\na.m3u8\n');
    assert.strictEqual(pl.variants[0].line, 2, 'the STREAM-INF tag is on line index 2');
    assert.strictEqual(pl.variants[0].uriLine, 3, 'its URI is on the next line');
  });

  await test('parsePlaylist reads a media playlist', () => {
    const pl = parsePlaylist(fixture('media-vod-clean.m3u8'));
    assert.strictEqual(pl.kind, 'media');
    assert.strictEqual(pl.targetDuration, 6);
    assert.strictEqual(pl.playlistType, 'VOD');
    assert.strictEqual(pl.hasEndList, true);
    assert.strictEqual(pl.mediaSequence, 0);
    assert.strictEqual(pl.maps.length, 1);
    assert.strictEqual(pl.segments.length, 5);
    assert.strictEqual(pl.segments[0].duration, 6);
    assert.strictEqual(pl.segments[0].uri, 'seg-00001.m4s');
    assert.strictEqual(pl.segments[0].programDateTime, '2026-08-17T10:00:00.000Z');
    assert.strictEqual(pl.segments[1].programDateTime, null, 'PDT applies to the segment it precedes only');
    assert.strictEqual(pl.segments[4].duration, 5.76);
    assert.strictEqual(pl.totalDuration, 29.76);
  });

  await test('parsePlaylist tracks discontinuity, gap and byterange per segment', () => {
    const pl = parsePlaylist(
      '#EXTM3U\n#EXT-X-TARGETDURATION:4\n' +
        '#EXTINF:4.000,\n#EXT-X-BYTERANGE:75232@0\na.ts\n' +
        '#EXT-X-DISCONTINUITY\n#EXTINF:4.000,\nb.ts\n' +
        '#EXT-X-GAP\n#EXTINF:4.000,\nc.ts\n#EXT-X-ENDLIST\n',
    );
    assert.strictEqual(pl.segments.length, 3);
    assert.strictEqual(pl.segments[0].byterange, '75232@0');
    assert.strictEqual(pl.segments[1].discontinuity, true);
    assert.strictEqual(pl.segments[0].discontinuity, false);
    assert.strictEqual(pl.segments[2].gap, true);
  });

  await test('parsePlaylist flags a missing #EXTM3U, a BOM and an unknown tag', () => {
    const noHeader = parsePlaylist('#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n');
    assert.strictEqual(noHeader.startsWithExtM3U, false);
    const bom = parsePlaylist('﻿#EXTM3U\n#EXT-X-TARGETDURATION:6\n');
    assert.strictEqual(bom.hasBom, true);
    assert.strictEqual(bom.startsWithExtM3U, true, 'the BOM is stripped, the header is still recognised');
    const typo = parsePlaylist('#EXTM3U\n#EXT-X-TARGETDURATON:6\n');
    assert.deepStrictEqual(
      typo.unknownTags.map((t) => t.name),
      ['EXT-X-TARGETDURATON'],
    );
  });

  await test('parsePlaylist survives CRLF line endings and blank lines', () => {
    const pl = parsePlaylist('#EXTM3U\r\n#EXT-X-TARGETDURATION:6\r\n\r\n#EXTINF:6.000,\r\na.ts\r\n#EXT-X-ENDLIST\r\n');
    assert.strictEqual(pl.targetDuration, 6);
    assert.strictEqual(pl.segments.length, 1);
    assert.strictEqual(pl.segments[0].uri, 'a.ts', 'no trailing carriage return in the URI');
  });

  await test('looksLikePlaylist recognises a playlist by its first tag', () => {
    assert.strictEqual(looksLikePlaylist('#EXTM3U\n#EXT-X-VERSION:3\n'), true);
    assert.strictEqual(looksLikePlaylist('﻿#EXTM3U\n'), true);
    assert.strictEqual(looksLikePlaylist('<?xml version="1.0"?><MPD/>'), false);
    assert.strictEqual(looksLikePlaylist(''), false);
  });

  // ------------------------------------------------------------------ analysis
  await test('a clean master playlist reports nothing above a hint', () => {
    const findings = analyze(parsePlaylist(fixture('master-clean.m3u8')));
    const loud = findings.filter((f) => f.severity !== 'hint');
    assert.deepStrictEqual(ruleIds(loud), [], `unexpected findings: ${JSON.stringify(loud, null, 2)}`);
  });

  await test('a clean VOD playlist reports nothing above a hint', () => {
    const findings = analyze(parsePlaylist(fixture('media-vod-clean.m3u8')));
    const loud = findings.filter((f) => f.severity !== 'hint');
    assert.deepStrictEqual(ruleIds(loud), [], `unexpected findings: ${JSON.stringify(loud, null, 2)}`);
  });

  await test('the broken master playlist is caught rule by rule', () => {
    const pl = parsePlaylist(fixture('master-broken.m3u8'));
    const findings = analyze(pl);
    const ids = ruleIds(findings);
    for (const expected of [
      'master/missing-bandwidth',
      'master/missing-resolution',
      'master/missing-codecs',
      'master/duplicate-bandwidth',
      'master/undefined-group',
      'master/group-multiple-defaults',
      'master/plaintext-uri',
      'master/no-iframe-stream',
    ]) {
      assert.ok(ids.includes(expected), `${expected} should fire, got ${JSON.stringify(ids)}`);
    }
    assert.strictEqual(severityOf(findings, 'master/missing-bandwidth'), 'error');
    assert.strictEqual(severityOf(findings, 'master/missing-resolution'), 'warning');
    assert.strictEqual(severityOf(findings, 'master/undefined-group'), 'error');
    assert.strictEqual(severityOf(findings, 'master/no-iframe-stream'), 'hint');

    // The finding must point at the line the operator has to edit.
    const undefinedGroup = findings.find((f) => f.rule === 'master/undefined-group');
    assert.strictEqual(pl.lines[undefinedGroup!.line].includes('AUDIO="stereo"'), true);
  });

  await test('the broken media playlist is caught rule by rule', () => {
    const pl = parsePlaylist(fixture('media-live-broken.m3u8'));
    const findings = analyze(pl);
    const ids = ruleIds(findings);
    for (const expected of [
      'media/extinf-exceeds-target',
      'media/missing-endlist',
      'media/key-over-http',
      'media/pdt-not-monotonic',
      'media/discontinuity-without-sequence',
      'syntax/version-too-low',
    ]) {
      assert.ok(ids.includes(expected), `${expected} should fire, got ${JSON.stringify(ids)}`);
    }
    const overLong = findings.find((f) => f.rule === 'media/extinf-exceeds-target');
    assert.ok(pl.lines[overLong!.line].startsWith('#EXTINF:8.500'), 'the finding points at the offending EXTINF');
    assert.ok(
      findings.find((f) => f.rule === 'media/key-over-http')!.message.includes('http://'),
      'the message names the scheme that is the problem',
    );
  });

  await test('fMP4 segments without EXT-X-MAP are an error', () => {
    const withoutMap = analyze(
      parsePlaylist('#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.000,\na.m4s\n#EXT-X-ENDLIST\n'),
    );
    assert.ok(ruleIds(withoutMap).includes('media/missing-map'));
    const withMap = analyze(
      parsePlaylist('#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:6\n#EXT-X-MAP:URI="i.mp4"\n#EXTINF:6.000,\na.m4s\n#EXT-X-ENDLIST\n'),
    );
    assert.ok(!ruleIds(withMap).includes('media/missing-map'));
    // Transport stream segments need no init segment.
    const ts = analyze(parsePlaylist('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.000,\na.ts\n#EXT-X-ENDLIST\n'));
    assert.ok(!ruleIds(ts).includes('media/missing-map'));
  });

  await test('the version rule knows which tag needs which version', () => {
    const cases: Array<{ playlist: string; fires: boolean; why: string }> = [
      { playlist: '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MAP:URI="i.mp4"\n#EXTINF:6.000,\na.m4s\n#EXT-X-ENDLIST\n', fires: true, why: 'EXT-X-MAP needs 6' },
      { playlist: '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:6\n#EXT-X-MAP:URI="i.mp4"\n#EXTINF:6.000,\na.m4s\n#EXT-X-ENDLIST\n', fires: false, why: 'version 6 is enough for EXT-X-MAP' },
      { playlist: '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.000,\n#EXT-X-BYTERANGE:1@0\na.ts\n#EXT-X-ENDLIST\n', fires: true, why: 'EXT-X-BYTERANGE needs 4' },
      { playlist: '#EXTM3U\n#EXT-X-VERSION:2\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.000,\na.ts\n#EXT-X-ENDLIST\n', fires: true, why: 'a float EXTINF needs 3' },
      { playlist: '#EXTM3U\n#EXT-X-VERSION:2\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\na.ts\n#EXT-X-ENDLIST\n', fires: false, why: 'an integer EXTINF is fine at 2' },
    ];
    for (const c of cases) {
      const fired = ruleIds(analyze(parsePlaylist(c.playlist))).includes('syntax/version-too-low');
      assert.strictEqual(fired, c.fires, c.why);
    }
  });

  await test('a manifest that is both master and media is rejected outright', () => {
    const findings = analyze(
      parsePlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\na.m3u8\n#EXTINF:6.000,\nb.ts\n'),
    );
    assert.ok(ruleIds(findings).includes('syntax/mixed-playlist'));
  });

  await test('a missing #EXTM3U and a leading BOM are reported', () => {
    assert.ok(ruleIds(analyze(parsePlaylist('#EXT-X-TARGETDURATION:6\n'))).includes('syntax/missing-extm3u'));
    assert.ok(ruleIds(analyze(parsePlaylist('﻿#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.000,\na.ts\n#EXT-X-ENDLIST\n'))).includes('syntax/leading-bom'));
  });

  await test('an EXTINF with no URI after it is reported', () => {
    const findings = analyze(parsePlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.000,\n#EXT-X-ENDLIST\n'));
    assert.ok(ruleIds(findings).includes('media/missing-uri'));
  });

  await test('program date time drift is measured against the EXTINF durations', () => {
    // Two 6s segments between two PDTs 30s apart: 18s of drift.
    const drifting =
      '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n' +
      '#EXT-X-PROGRAM-DATE-TIME:2026-08-17T10:00:00.000Z\n#EXTINF:6.000,\na.ts\n#EXTINF:6.000,\nb.ts\n' +
      '#EXT-X-PROGRAM-DATE-TIME:2026-08-17T10:00:30.000Z\n#EXTINF:6.000,\nc.ts\n#EXT-X-ENDLIST\n';
    assert.ok(ruleIds(analyze(parsePlaylist(drifting))).includes('media/pdt-drift'));

    const consistent =
      '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n' +
      '#EXT-X-PROGRAM-DATE-TIME:2026-08-17T10:00:00.000Z\n#EXTINF:6.000,\na.ts\n#EXTINF:6.000,\nb.ts\n' +
      '#EXT-X-PROGRAM-DATE-TIME:2026-08-17T10:00:12.000Z\n#EXTINF:6.000,\nc.ts\n#EXT-X-ENDLIST\n';
    assert.ok(!ruleIds(analyze(parsePlaylist(consistent))).includes('media/pdt-drift'));

    // The tolerance is the caller's: a 400ms step is fine by default, not at 100ms.
    const small =
      '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n' +
      '#EXT-X-PROGRAM-DATE-TIME:2026-08-17T10:00:00.000Z\n#EXTINF:6.000,\na.ts\n' +
      '#EXT-X-PROGRAM-DATE-TIME:2026-08-17T10:00:06.400Z\n#EXTINF:6.000,\nb.ts\n#EXT-X-ENDLIST\n';
    assert.ok(!ruleIds(analyze(parsePlaylist(small))).includes('media/pdt-drift'));
    assert.ok(ruleIds(analyze(parsePlaylist(small), { pdtDriftToleranceMs: 100 })).includes('media/pdt-drift'));
  });

  await test('an overstated target duration is reported', () => {
    const overstated = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:2.000,\na.ts\n#EXTINF:2.000,\nb.ts\n#EXT-X-ENDLIST\n';
    assert.ok(ruleIds(analyze(parsePlaylist(overstated))).includes('media/target-duration-overstated'));
    const honest = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.000,\na.ts\n#EXT-X-ENDLIST\n';
    assert.ok(!ruleIds(analyze(parsePlaylist(honest))).includes('media/target-duration-overstated'));
  });

  await test('low-latency parts need the server control tags that make them usable', () => {
    const parts =
      '#EXTM3U\n#EXT-X-VERSION:9\n#EXT-X-TARGETDURATION:6\n#EXT-X-PART-INF:PART-TARGET=1.000\n' +
      '#EXT-X-PART:DURATION=1.000,URI="a.1.m4s"\n#EXTINF:6.000,\na.m4s\n';
    const ids = ruleIds(analyze(parsePlaylist(parts)));
    assert.ok(ids.includes('media/part-without-server-control'), `got ${JSON.stringify(ids)}`);

    const declared =
      '#EXTM3U\n#EXT-X-VERSION:9\n#EXT-X-TARGETDURATION:6\n' +
      '#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=3.000,HOLD-BACK=18.000\n' +
      '#EXT-X-PART-INF:PART-TARGET=1.000\n#EXT-X-MAP:URI="i.mp4"\n' +
      '#EXT-X-PART:DURATION=1.000,URI="a.1.m4s"\n#EXTINF:6.000,\na.m4s\n';
    assert.ok(!ruleIds(analyze(parsePlaylist(declared))).includes('media/part-without-server-control'));
  });

  await test('a hold back under three target durations is reported', () => {
    const short =
      '#EXTM3U\n#EXT-X-VERSION:9\n#EXT-X-TARGETDURATION:6\n#EXT-X-SERVER-CONTROL:HOLD-BACK=6.000\n' +
      '#EXTINF:6.000,\na.ts\n';
    assert.ok(ruleIds(analyze(parsePlaylist(short))).includes('media/holdback-too-small'));
  });

  await test('the parser keeps the parts, the preload hints and the rendition reports', () => {
    const pl = parsePlaylist(
      llPlaylist(
        '#EXT-X-PART:DURATION=0.500,URI="s10.0.m4s",INDEPENDENT=YES',
        '#EXT-X-PART:DURATION=0.500,URI="s10.1.m4s"',
        '#EXTINF:4.000,',
        's10.m4s',
        '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="s11.0.m4s"',
        '#EXT-X-RENDITION-REPORT:URI="../720p/live.m3u8",LAST-MSN=10,LAST-PART=1',
      ),
    );
    assert.strictEqual(pl.parts.length, 2);
    assert.strictEqual(pl.parts[0].uri, 's10.0.m4s');
    assert.strictEqual(pl.parts[0].duration, 0.5);
    assert.strictEqual(pl.parts[0].independent, true);
    assert.strictEqual(pl.parts[1].independent, false);
    // The line index is the part's own tag: a finding about a part has to point at it.
    assert.ok(pl.lines[pl.parts[1].line].includes('s10.1.m4s'));
    assert.ok(pl.partInfLine !== null && pl.lines[pl.partInfLine].startsWith('#EXT-X-PART-INF'));
    assert.strictEqual(pl.preloadHints.length, 1);
    assert.strictEqual(pl.renditionReports.length, 1);
  });

  await test('a part longer than PART-TARGET is reported, on its own line', () => {
    const overlong = llPlaylist(
      '#EXT-X-PART:DURATION=0.500,URI="s10.0.m4s"',
      '#EXT-X-PART:DURATION=0.900,URI="s10.1.m4s"',
      '#EXTINF:4.000,',
      's10.m4s',
    );
    const found = findingsOf(overlong, 'media/part-exceeds-part-target');
    assert.strictEqual(found.length, 1);
    assert.ok(parsePlaylist(overlong).lines[found[0].line].includes('s10.1.m4s'));

    // A part exactly at the target is legal, and so is the short last part of a segment.
    const legal = llPlaylist(
      '#EXT-X-PART:DURATION=0.500,URI="s10.0.m4s"',
      '#EXT-X-PART:DURATION=0.100,URI="s10.1.m4s"',
      '#EXTINF:4.000,',
      's10.m4s',
    );
    assert.strictEqual(findingsOf(legal, 'media/part-exceeds-part-target').length, 0);
  });

  await test('parts without EXT-X-PART-INF are reported', () => {
    const noInf =
      '#EXTM3U\n#EXT-X-VERSION:9\n#EXT-X-TARGETDURATION:4\n' +
      '#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=1.500\n' +
      '#EXT-X-PART:DURATION=0.500,URI="s10.0.m4s"\n#EXTINF:4.000,\ns10.m4s\n';
    assert.ok(ruleIds(analyze(parsePlaylist(noInf))).includes('media/part-without-part-inf'));

    const withInf = llPlaylist('#EXT-X-PART:DURATION=0.500,URI="s10.0.m4s"', '#EXTINF:4.000,', 's10.m4s');
    assert.ok(!ruleIds(analyze(parsePlaylist(withInf))).includes('media/part-without-part-inf'));
  });

  await test('a part target as long as the segments is reported', () => {
    const whole =
      '#EXTM3U\n#EXT-X-VERSION:9\n#EXT-X-TARGETDURATION:4\n' +
      '#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=12.000\n' +
      '#EXT-X-PART-INF:PART-TARGET=4.000\n#EXT-X-PART:DURATION=4.000,URI="s10.0.m4s"\n#EXTINF:4.000,\ns10.m4s\n';
    assert.ok(ruleIds(analyze(parsePlaylist(whole))).includes('media/part-target-too-large'));

    const eighth = llPlaylist('#EXT-X-PART:DURATION=0.500,URI="s10.0.m4s"', '#EXTINF:4.000,', 's10.m4s');
    assert.ok(!ruleIds(analyze(parsePlaylist(eighth))).includes('media/part-target-too-large'));
  });

  await test('a skip boundary under six target durations is reported', () => {
    const header = (canSkipUntil: string): string =>
      '#EXTM3U\n#EXT-X-VERSION:9\n#EXT-X-TARGETDURATION:4\n' +
      `#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,HOLD-BACK=12.000,CAN-SKIP-UNTIL=${canSkipUntil}\n` +
      '#EXTINF:4.000,\ns10.m4s\n';
    assert.ok(ruleIds(analyze(parsePlaylist(header('12.000')))).includes('media/can-skip-until-too-small'));
    assert.ok(!ruleIds(analyze(parsePlaylist(header('24.000')))).includes('media/can-skip-until-too-small'));
  });

  await test('preload hints are checked for shape and for usefulness', () => {
    const segment = ['#EXT-X-PART:DURATION=0.500,URI="s10.0.m4s"', '#EXTINF:4.000,', 's10.m4s'];

    // The spec allows one hint per TYPE; two is a player guessing which to fetch.
    const twice = llPlaylist(...segment, '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="s11.0.m4s"', '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="s11.1.m4s"');
    assert.ok(ruleIds(analyze(parsePlaylist(twice))).includes('media/preload-hint'));

    const noUri = llPlaylist(...segment, '#EXT-X-PRELOAD-HINT:TYPE=PART');
    assert.ok(ruleIds(analyze(parsePlaylist(noUri))).includes('media/preload-hint'));

    // Hinting a part the playlist already publishes is a wasted request, not a preload.
    const published = llPlaylist(...segment, '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="s10.0.m4s"');
    assert.ok(ruleIds(analyze(parsePlaylist(published))).includes('media/preload-hint-not-preloading'));

    const noParts =
      '#EXTM3U\n#EXT-X-VERSION:9\n#EXT-X-TARGETDURATION:4\n#EXT-X-PRELOAD-HINT:TYPE=PART,URI="s11.0.m4s"\n#EXTINF:4.000,\ns10.m4s\n';
    assert.ok(ruleIds(analyze(parsePlaylist(noParts))).includes('media/preload-hint-not-preloading'));

    const good = llPlaylist(...segment, '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="s11.0.m4s"', '#EXT-X-RENDITION-REPORT:URI="../720p/live.m3u8",LAST-MSN=10');
    const ids = ruleIds(analyze(parsePlaylist(good)));
    assert.ok(!ids.includes('media/preload-hint'), `got ${JSON.stringify(ids)}`);
    assert.ok(!ids.includes('media/preload-hint-not-preloading'));
  });

  await test('rendition reports are checked against the playlist that carries them', () => {
    const segment = ['#EXT-X-PART:DURATION=0.500,URI="s10.0.m4s"', '#EXTINF:4.000,', 's10.m4s'];
    const hint = '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="s11.0.m4s"';

    const noMsn = llPlaylist(...segment, hint, '#EXT-X-RENDITION-REPORT:URI="../720p/live.m3u8"');
    assert.ok(ruleIds(analyze(parsePlaylist(noMsn))).includes('media/rendition-report'));

    const noUri = llPlaylist(...segment, hint, '#EXT-X-RENDITION-REPORT:LAST-MSN=10');
    assert.ok(ruleIds(analyze(parsePlaylist(noUri))).includes('media/rendition-report'));

    // This playlist's own last media sequence is 10: a report six segments behind
    // means the two rungs are not keeping up with each other.
    const behind = llPlaylist(...segment, hint, '#EXT-X-RENDITION-REPORT:URI="../720p/live.m3u8",LAST-MSN=4');
    assert.ok(ruleIds(analyze(parsePlaylist(behind))).includes('media/rendition-report-out-of-step'));

    // One segment out is how a live packager normally looks mid-publish.
    const alongside = llPlaylist(...segment, hint, '#EXT-X-RENDITION-REPORT:URI="../720p/live.m3u8",LAST-MSN=9');
    assert.ok(!ruleIds(analyze(parsePlaylist(alongside))).includes('media/rendition-report-out-of-step'));

    const none = llPlaylist(...segment, hint);
    assert.ok(ruleIds(analyze(parsePlaylist(none))).includes('media/rendition-report-missing'));
    assert.ok(!ruleIds(analyze(parsePlaylist(alongside))).includes('media/rendition-report-missing'));

    // A playlist with no parts is not low latency and owes no report.
    const plain = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.000,\ns10.m4s\n';
    assert.ok(!ruleIds(analyze(parsePlaylist(plain))).includes('media/rendition-report-missing'));
  });

  await test('the low-latency fixture lights up the five findings it was written for', () => {
    const ids = ruleIds(analyze(parsePlaylist(fixture('media-ll-broken.m3u8'))));
    for (const rule of [
      'media/part-exceeds-part-target',
      'media/can-skip-until-too-small',
      'media/preload-hint',
      'media/preload-hint-not-preloading',
      'media/rendition-report-out-of-step',
    ]) {
      assert.ok(ids.includes(rule), `${rule} missing from ${JSON.stringify(ids)}`);
    }
  });

  await test('gap segments and a short live window are reported', () => {
    const gap = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-GAP\n#EXTINF:6.000,\na.ts\n#EXTINF:6.000,\nb.ts\n#EXTINF:6.000,\nc.ts\n#EXTINF:6.000,\nd.ts\n';
    const ids = ruleIds(analyze(parsePlaylist(gap)));
    assert.ok(ids.includes('media/gap-segments'));
    const shortWindow = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.000,\na.ts\n';
    assert.ok(ruleIds(analyze(parsePlaylist(shortWindow))).includes('media/short-live-window'));
    // A VOD playlist has no live window to be short.
    const vod = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.000,\na.ts\n#EXT-X-ENDLIST\n';
    assert.ok(!ruleIds(analyze(parsePlaylist(vod))).includes('media/short-live-window'));
  });

  await test('findings are ordered by severity and then by line', () => {
    const findings = analyze(parsePlaylist(fixture('master-broken.m3u8')));
    const rank: Record<Severity, number> = { error: 0, warning: 1, hint: 2 };
    for (let i = 1; i < findings.length; i++) {
      const prev = findings[i - 1];
      const cur = findings[i];
      assert.ok(
        rank[prev.severity] < rank[cur.severity] || (prev.severity === cur.severity && prev.line <= cur.line),
        `findings out of order at ${i}: ${prev.rule} (${prev.severity}, line ${prev.line}) before ${cur.rule} (${cur.severity}, line ${cur.line})`,
      );
    }
  });

  await test('every finding a rule emits is documented in the catalogue', () => {
    const documented = new Set(RULES.map((r) => r.id));
    const seen = new Set<string>();
    for (const name of ['master-clean.m3u8', 'master-broken.m3u8', 'media-vod-clean.m3u8', 'media-live-broken.m3u8']) {
      for (const f of analyze(parsePlaylist(fixture(name)))) {
        seen.add(f.rule);
        assert.ok(documented.has(f.rule), `${f.rule} is emitted but not in RULES`);
        assert.ok(f.message.trim().length > 0, `${f.rule} has an empty message`);
        assert.ok(f.line >= 0, `${f.rule} has a negative line`);
      }
    }
    assert.ok(seen.size >= 12, `the fixtures should exercise most of the catalogue, got ${seen.size}`);
  });

  await test('the rule catalogue has stable, namespaced ids and a rationale', () => {
    const ids = new Set<string>();
    for (const r of RULES) {
      assert.ok(!ids.has(r.id), `duplicate rule id ${r.id}`);
      ids.add(r.id);
      assert.match(r.id, /^(syntax|master|media|cross|dash)\/[a-z0-9-]+$/, `${r.id} is not a namespaced kebab-case id`);
      assert.ok(r.title.trim().length > 0, `${r.id} has no title`);
      assert.ok(r.rationale.split(/\s+/).length >= 8, `${r.id} needs a rationale that explains the risk`);
      assert.ok(['error', 'warning', 'hint'].includes(r.severity), `${r.id} has severity ${r.severity}`);
    }
    assert.ok(RULES.length >= 25, `only ${RULES.length} rules in the catalogue`);
  });

  await test('rules can be skipped by id or by category', () => {
    const all = analyze(parsePlaylist(fixture('master-broken.m3u8')));
    const withoutOne = analyze(parsePlaylist(fixture('master-broken.m3u8')), { skip: ['master/missing-codecs'] });
    assert.ok(ruleIds(all).includes('master/missing-codecs'));
    assert.ok(!ruleIds(withoutOne).includes('master/missing-codecs'));
    const withoutCategory = analyze(parsePlaylist(fixture('master-broken.m3u8')), { skip: ['master'] });
    assert.deepStrictEqual(
      ruleIds(withoutCategory).filter((id) => id.startsWith('master/')),
      [],
    );
  });

  // -------------------------------------------------------------------- ladder
  await test('buildLadder models the ABR ladder in ascending bitrate', () => {
    const rows = buildLadder(parsePlaylist(fixture('master-clean.m3u8')));
    assert.strictEqual(rows.length, 5);
    const video = rows.filter((r) => !r.iframeOnly);
    assert.deepStrictEqual(
      video.map((r) => r.bandwidthBps),
      [880000, 1650000, 3300000, 6100000],
    );
    assert.strictEqual(video[3].label, '1080p');
    assert.ok(video[3].description.includes('6.10 Mbps'));
    assert.ok(video[3].tooltip.includes('avc1.64002a'));
    assert.strictEqual(video[3].uri, 'video/1080p/index.m3u8');
    assert.strictEqual(rows[rows.length - 1].iframeOnly, true, 'the I-frame stream sorts last');
  });

  await test('buildLadder labels a variant with no resolution by its bitrate', () => {
    const rows = buildLadder(parsePlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2"\naudio.m3u8\n'));
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].label, '128 kbps');
  });

  await test('renditionRows groups the alternate audio and subtitle tracks', () => {
    const rows = renditionRows(parsePlaylist(fixture('master-clean.m3u8')));
    const labels = rows.map((r) => r.label);
    assert.ok(labels.some((l) => l.includes('English')));
    const it = rows.find((r) => r.label.includes('Italiano'));
    assert.ok(it, 'the Italian audio rendition is listed');
    assert.strictEqual(it!.uri, 'audio/it/128k.m3u8');
    const def = rows.find((r) => r.label.includes('English') && r.description.includes('AUDIO'));
    assert.ok(def!.description.includes('default'), 'the default rendition is marked');
  });

  await test('ladderSummary states the ladder in one line', () => {
    const summary = ladderSummary(parsePlaylist(fixture('master-clean.m3u8')));
    assert.ok(summary.includes('4 variants'), summary);
    assert.ok(summary.includes('360p'), summary);
    assert.ok(summary.includes('1080p'), summary);
    const media = ladderSummary(parsePlaylist(fixture('media-vod-clean.m3u8')));
    assert.ok(media.includes('5 segments'), media);
    assert.ok(media.includes('VOD'), media);
  });

  await test('formatting helpers read like the admin console, not like bytes', () => {
    assert.strictEqual(formatBandwidth(6100000), '6.10 Mbps');
    assert.strictEqual(formatBandwidth(128000), '128 kbps');
    assert.strictEqual(formatBandwidth(null), 'no BANDWIDTH');
    assert.strictEqual(formatResolution({ width: 1920, height: 1080 }), '1920×1080');
    assert.strictEqual(formatResolution(null), '');
  });

  // ----------------------------------------------------------------------- URI
  await test('resolveUri resolves a child playlist against its parent', () => {
    assert.strictEqual(resolveUri('https://cdn.example/hls/master.m3u8', '720p/index.m3u8'), 'https://cdn.example/hls/720p/index.m3u8');
    assert.strictEqual(resolveUri('https://cdn.example/hls/master.m3u8', '/other/index.m3u8'), 'https://cdn.example/other/index.m3u8');
    assert.strictEqual(resolveUri('https://cdn.example/hls/master.m3u8', 'https://other.example/a.m3u8'), 'https://other.example/a.m3u8');
    assert.strictEqual(resolveUri('https://cdn.example/hls/master.m3u8?token=abc', 'a.m3u8'), 'https://cdn.example/hls/a.m3u8');
    // A local manifest resolves against its directory, keeping platform paths.
    assert.strictEqual(resolveUri('/streams/master.m3u8', '720p/index.m3u8'), '/streams/720p/index.m3u8');
  });

  await test('baseOf, isRemote, isPlainHttp and looksLikePlaylistUri classify what we fetch', () => {
    assert.strictEqual(baseOf('https://cdn.example/hls/master.m3u8'), 'https://cdn.example/hls/');
    assert.strictEqual(isRemote('https://cdn.example/a.m3u8'), true);
    assert.strictEqual(isRemote('/tmp/a.m3u8'), false);
    assert.strictEqual(isPlainHttp('http://cdn.example/a.m3u8'), true);
    assert.strictEqual(isPlainHttp('http://localhost:8080/a.m3u8'), false, 'loopback http is how everyone tests locally');
    assert.strictEqual(isPlainHttp('https://cdn.example/a.m3u8'), false);
    assert.strictEqual(looksLikePlaylistUri('720p/index.m3u8'), true);
    assert.strictEqual(looksLikePlaylistUri('seg-00001.ts'), false);
    assert.strictEqual(looksLikePlaylistUri('index.m3u8?token=x'), true);
  });

  // ------------------------------------------------------------------ segcheck
  await test('buildSegcheckArgs builds the invocation the binary documents', () => {
    assert.deepStrictEqual(buildSegcheckArgs('https://cdn.example/master.m3u8', {}), [
      'check',
      'https://cdn.example/master.m3u8',
      '--output',
      'json',
    ]);
    const full = buildSegcheckArgs('https://cdn.example/master.m3u8', {
      segments: 12,
      renditions: 2,
      from: 'edge',
      insecure: true,
      headers: { Authorization: 'Bearer x' },
    });
    assert.ok(full.includes('--segments') && full[full.indexOf('--segments') + 1] === '12');
    assert.ok(full.includes('--from') && full[full.indexOf('--from') + 1] === 'edge');
    assert.ok(full.includes('--insecure'));
    assert.ok(full.includes('--header') && full[full.indexOf('--header') + 1] === 'Authorization: Bearer x');
    // Defaults are not spelled out: the binary owns them.
    assert.ok(!buildSegcheckArgs('u', { from: 'auto' }).includes('--from'));
  });

  await test('parseSegcheckResult reads the JSON contract of segcheck', () => {
    const stdout = JSON.stringify({
      source: 'https://cdn.example/master.m3u8',
      worst: 'BAD',
      summary: { OK: 17, WARN: 1, BAD: 3, ERROR: 0 },
      segments: 18,
      bytes: 25690112,
      started: '2026-08-17T10:00:00Z',
      duration_seconds: 4.1,
      findings: [
        { check: 'continuity', target: '1080p seg 412', status: 'BAD', message: 'gap of +512ms', hint: 'expect a stall' },
        { check: 'bitrate', target: '720p seg 38', status: 'WARN', message: 'peaks at 3.10 Mbps', value: 3.1, unit: 'Mbps' },
        { check: 'alignment', target: 'ladder', status: 'OK', message: 'renditions aligned' },
      ],
    });
    const res = parseSegcheckResult(stdout);
    assert.strictEqual(res.worst, 'BAD');
    assert.strictEqual(res.segments, 18);
    assert.strictEqual(res.findings.length, 3);
    assert.strictEqual(res.findings[0].check, 'continuity');

    const summary = segcheckSummary(res);
    assert.ok(summary.includes('3 BAD'), summary);
    assert.ok(summary.includes('18 segments'), summary);

    const findings = segcheckToFindings(res);
    assert.strictEqual(findings.length, 2, 'OK findings are not diagnostics');
    assert.strictEqual(findings[0].severity, 'error');
    assert.strictEqual(findings[1].severity, 'warning');
    assert.ok(findings[0].rule.startsWith('segcheck/'), findings[0].rule);
    assert.ok(findings[0].message.includes('1080p seg 412'), 'the target is in the message: there is no line to anchor it to');
    assert.strictEqual(findings[0].line, 0, 'segment findings anchor at the top of the manifest');
  });

  await test('parseSegcheckResult rejects output that is not its JSON', () => {
    assert.throws(() => parseSegcheckResult('segcheck: unknown flag --nope'), /segcheck/i);
    assert.throws(() => parseSegcheckResult('{"unrelated":true}'), /findings/i);
  });

  // --------------------------------------------------------------------- fetch
  await test('fetchText reads a manifest over http, follows a redirect and sends headers', async () => {
    let seenAuth = '';
    const server = http.createServer((req, res) => {
      if (req.url === '/redirect.m3u8') {
        res.writeHead(302, { Location: '/master.m3u8' });
        res.end();
        return;
      }
      if (req.url === '/master.m3u8') {
        seenAuth = String(req.headers.authorization ?? '');
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        res.end('#EXTM3U\n#EXT-X-VERSION:7\n');
        return;
      }
      if (req.url === '/big.m3u8') {
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        res.end('#EXTM3U\n' + 'x'.repeat(5000));
        return;
      }
      res.writeHead(404);
      res.end('nope');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    try {
      const direct = await fetchText(`${base}/master.m3u8`, { headers: { Authorization: 'Bearer t' } });
      assert.ok(direct.text.startsWith('#EXTM3U'));
      assert.strictEqual(seenAuth, 'Bearer t');
      assert.strictEqual(direct.finalUrl, `${base}/master.m3u8`);

      const redirected = await fetchText(`${base}/redirect.m3u8`);
      assert.ok(redirected.text.startsWith('#EXTM3U'));
      assert.strictEqual(redirected.finalUrl, `${base}/master.m3u8`, 'the final URL is what child URIs resolve against');

      await assert.rejects(fetchText(`${base}/missing.m3u8`), /404/);
      await assert.rejects(fetchText(`${base}/big.m3u8`, { maxBytes: 1000 }), /too large|1000/i);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // ------------------------------------------------------------- ladder quality
  await test('master/codecs-resolution-mismatch catches a level that cannot carry the picture', () => {
    // avc1.4d401e is Main@3.0: 1620 macroblocks per frame, 40500 per second.
    // 1080p is 8160 macroblocks, so the rung promises a picture its own codec
    // string says it cannot decode.
    const pl = parsePlaylist(
      [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=6100000,RESOLUTION=1920x1080,FRAME-RATE=50.000,CODECS="avc1.4d401e,mp4a.40.2"',
        'high.m3u8',
        // avc1.4d401f is Main@3.1: exactly 3600 macroblocks and 108000 per second,
        // which is 720p50 to the boundary and must not fire.
        '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,FRAME-RATE=30.000,CODECS="avc1.4d401f,mp4a.40.2"',
        'mid.m3u8',
      ].join('\n'),
    );
    const found = analyze(pl).filter((f) => f.rule === 'master/codecs-resolution-mismatch');
    assert.strictEqual(found.length, 1, 'only the 1080p rung is impossible');
    assert.strictEqual(found[0].line, 1);
    assert.match(found[0].message, /3\.0/, 'the message names the level it decoded');
    assert.strictEqual(found[0].severity, 'warning');
  });

  await test('master/codecs-resolution-mismatch separates the frame rate from the frame size', () => {
    // 720p fits Main@3.0 by size (3600 > 1620? no — 3600 macroblocks exceeds it).
    // Use 480p, which fits 3.0 by size but not at 60fps: 1200 MBs * 60 = 72000 > 40500.
    const pl = parsePlaylist(
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=854x480,FRAME-RATE=60.000,CODECS="avc1.4d401e"\na.m3u8\n',
    );
    const found = analyze(pl).filter((f) => f.rule === 'master/codecs-resolution-mismatch');
    assert.strictEqual(found.length, 1);
    assert.match(found[0].message, /60/, 'the frame rate is what breaks it');

    const slower = parsePlaylist(
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=854x480,FRAME-RATE=25.000,CODECS="avc1.4d401e"\na.m3u8\n',
    );
    assert.deepStrictEqual(
      analyze(slower).filter((f) => f.rule === 'master/codecs-resolution-mismatch'),
      [],
      'the same rung at 25fps is legal',
    );
  });

  await test('master/codecs-resolution-mismatch stays quiet on codecs it cannot decode itself', () => {
    // Never invent a finding: HEVC and an unparseable string mean "no opinion".
    for (const codecs of ['hvc1.2.4.L120.90', 'avc1', 'avc1.xxxxxx', 'mp4a.40.2']) {
      const pl = parsePlaylist(
        `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=6100000,RESOLUTION=1920x1080,CODECS="${codecs}"\na.m3u8\n`,
      );
      assert.deepStrictEqual(
        analyze(pl).filter((f) => f.rule === 'master/codecs-resolution-mismatch'),
        [],
        `${codecs} produces no finding`,
      );
    }
  });

  await test('master/ladder-spacing reports rungs too close together and gaps too wide', () => {
    const pl = parsePlaylist(
      [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e"',
        'a.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=854x480,CODECS="avc1.4d401e"', // 1.25x: indistinguishable
        'b.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=3200000,RESOLUTION=1280x720,CODECS="avc1.4d401f"', // 3.2x: nothing between
        'c.m3u8',
      ].join('\n'),
    );
    const found = analyze(pl).filter((f) => f.rule === 'master/ladder-spacing');
    assert.strictEqual(found.length, 2);
    assert.strictEqual(found[0].line, 3, 'the close rung is reported on its own line');
    assert.match(found[0].message, /1\.25/);
    assert.strictEqual(found[1].line, 5);
    assert.match(found[1].message, /3\.2/);
    assert.strictEqual(found[0].severity, 'hint', 'ladder shape is advice, not a broken stream');
  });

  await test('master/ladder-spacing accepts a well-spaced ladder and ignores I-frame streams', () => {
    const pl = parsePlaylist(
      [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e"',
        'a.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=1600000,RESOLUTION=854x480,CODECS="avc1.4d401e"',
        'b.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=3200000,RESOLUTION=1280x720,CODECS="avc1.4d401f"',
        'c.m3u8',
        '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=94000,URI="iframe.m3u8"',
      ].join('\n'),
    );
    assert.deepStrictEqual(analyze(pl).filter((f) => f.rule === 'master/ladder-spacing'), []);
  });

  // --------------------------------------------------------------- ad breaks etc
  await test('media/daterange catches a duration that disagrees with END-DATE', () => {
    const pl = parsePlaylist(
      [
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:6',
        '#EXT-X-DATERANGE:ID="ad-1",START-DATE="2026-08-17T10:00:00.000Z",END-DATE="2026-08-17T10:00:30.000Z",DURATION=15.0',
        '#EXTINF:6.000,',
        'a.ts',
        '#EXT-X-ENDLIST',
      ].join('\n'),
    );
    const found = analyze(pl).filter((f) => f.rule === 'media/daterange');
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].line, 2);
    assert.match(found[0].message, /15|30/, 'the message carries both numbers');
  });

  await test('media/daterange catches overlapping ranges and a CUE-IN with no CUE-OUT', () => {
    const overlapping = parsePlaylist(
      [
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:6',
        '#EXT-X-DATERANGE:ID="ad-1",CLASS="ads",START-DATE="2026-08-17T10:00:00.000Z",DURATION=30.0',
        '#EXT-X-DATERANGE:ID="ad-2",CLASS="ads",START-DATE="2026-08-17T10:00:20.000Z",DURATION=30.0',
        '#EXTINF:6.000,',
        'a.ts',
        '#EXT-X-ENDLIST',
      ].join('\n'),
    );
    const overlap = analyze(overlapping).filter((f) => f.rule === 'media/daterange');
    assert.strictEqual(overlap.length, 1);
    assert.strictEqual(overlap[0].line, 3, 'reported on the range that starts inside the previous one');
    assert.match(overlap[0].message, /overlap/i);

    const cueIn = parsePlaylist(
      [
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:6',
        '#EXT-X-DATERANGE:ID="ad-2",START-DATE="2026-08-17T10:00:30.000Z",SCTE35-IN=0xFC30',
        '#EXTINF:6.000,',
        'a.ts',
        '#EXT-X-ENDLIST',
      ].join('\n'),
    );
    const dangling = analyze(cueIn).filter((f) => f.rule === 'media/daterange');
    assert.strictEqual(dangling.length, 1);
    assert.match(dangling[0].message, /SCTE35-IN|CUE-IN/i);
  });

  await test('media/daterange accepts a well-formed ad break', () => {
    const pl = parsePlaylist(
      [
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:6',
        '#EXT-X-DATERANGE:ID="ad-1",CLASS="ads",START-DATE="2026-08-17T10:00:00.000Z",END-DATE="2026-08-17T10:00:30.000Z",DURATION=30.0,SCTE35-OUT=0xFC30',
        '#EXT-X-DATERANGE:ID="ad-1-end",CLASS="ads",START-DATE="2026-08-17T10:00:30.000Z",SCTE35-IN=0xFC30',
        '#EXTINF:6.000,',
        'a.ts',
        '#EXT-X-ENDLIST',
      ].join('\n'),
    );
    assert.deepStrictEqual(analyze(pl).filter((f) => f.rule === 'media/daterange'), []);
  });

  // ---------------------------------------------------------------- keys, again
  await test('media/key-rotation fires on a live window a single key covers, and not on VOD', () => {
    const live = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:6',
      '#EXT-X-MEDIA-SEQUENCE:1200',
      '#EXT-X-KEY:METHOD=AES-128,URI="https://k.example/key?rot=1"',
    ];
    for (let i = 0; i < 10; i++) live.push('#EXTINF:6.000,', `seg-${i}.ts`);
    const found = analyze(parsePlaylist(live.join('\n'))).filter((f) => f.rule === 'media/key-rotation');
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].severity, 'hint');

    const vod = [...live, '#EXT-X-ENDLIST'].join('\n');
    assert.deepStrictEqual(
      analyze(parsePlaylist(vod)).filter((f) => f.rule === 'media/key-rotation'),
      [],
      'a finished VOD asset has nothing to rotate',
    );

    const rotating = [...live];
    rotating.splice(12, 0, '#EXT-X-KEY:METHOD=AES-128,URI="https://k.example/key?rot=2"');
    assert.deepStrictEqual(
      analyze(parsePlaylist(rotating.join('\n'))).filter((f) => f.rule === 'media/key-rotation'),
      [],
      'a second key URI in the window is rotation',
    );
  });

  await test('media/key-dropped catches METHOD=NONE after encrypted segments', () => {
    const pl = parsePlaylist(
      [
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:6',
        '#EXT-X-KEY:METHOD=AES-128,URI="https://k.example/key"',
        '#EXTINF:6.000,',
        'a.ts',
        '#EXT-X-KEY:METHOD=NONE',
        '#EXTINF:6.000,',
        'b.ts',
        '#EXT-X-ENDLIST',
      ].join('\n'),
    );
    const found = analyze(pl).filter((f) => f.rule === 'media/key-dropped');
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].line, 5, 'the METHOD=NONE line is the one to look at');
    assert.strictEqual(found[0].severity, 'warning');

    const neverEncrypted = parsePlaylist(
      '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:6.000,\na.ts\n#EXT-X-ENDLIST\n',
    );
    assert.deepStrictEqual(
      analyze(neverEncrypted).filter((f) => f.rule === 'media/key-dropped'),
      [],
      'METHOD=NONE on a playlist that was never encrypted is just clear content',
    );
  });

  await test('media/iframe-playlist-shape wants byte ranges in an I-frames-only playlist', () => {
    const whole = parsePlaylist(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:4',
        '#EXT-X-TARGETDURATION:6',
        '#EXT-X-I-FRAMES-ONLY',
        '#EXTINF:6.000,',
        'iframe-1.ts',
        '#EXT-X-ENDLIST',
      ].join('\n'),
    );
    const found = analyze(whole).filter((f) => f.rule === 'media/iframe-playlist-shape');
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].line, 5);

    const ranged = parsePlaylist(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:4',
        '#EXT-X-TARGETDURATION:6',
        '#EXT-X-I-FRAMES-ONLY',
        '#EXTINF:6.000,',
        '#EXT-X-BYTERANGE:12345@0',
        'video.ts',
        '#EXT-X-ENDLIST',
      ].join('\n'),
    );
    assert.deepStrictEqual(analyze(ranged).filter((f) => f.rule === 'media/iframe-playlist-shape'), []);

    const ordinary = parsePlaylist(fixture('media-vod-clean.m3u8'));
    assert.deepStrictEqual(
      analyze(ordinary).filter((f) => f.rule === 'media/iframe-playlist-shape'),
      [],
      'a normal media playlist is not an I-frame playlist',
    );
  });

  // ------------------------------------------------------------------- markdown
  await test('frontMatter takes the title off the top of a document', () => {
    const page = frontMatter('---\ntitle: Usage\n---\n\n# Usage\n\nBody.\n');
    assert.strictEqual(page.title, 'Usage');
    assert.strictEqual(page.body.trimStart().startsWith('# Usage'), true, 'the front matter is removed from the body');
    const bare = frontMatter('# Rules\n\nBody.\n');
    assert.strictEqual(bare.title, undefined);
    assert.strictEqual(bare.body, '# Rules\n\nBody.\n');
  });

  await test('renderMarkdown renders the constructs the docs actually use', () => {
    const html = renderMarkdown(
      [
        '# Title',
        '',
        'A paragraph with `code`, **bold**, *italic* and a [link](RULES.md).',
        '',
        '## Section',
        '',
        '- one',
        '- two',
        '',
        '| Rule | Severity |',
        '|---|---|',
        '| `media/gap` | warning |',
        '',
        '```bash',
        'npm run docs',
        '```',
      ].join('\n'),
    );
    assert.match(html, /<h1 id="title">Title<\/h1>/);
    assert.match(html, /<h2 id="section">Section<\/h2>/, 'headings carry an anchor id');
    assert.match(html, /<code>code<\/code>/);
    assert.match(html, /<strong>bold<\/strong>/);
    assert.match(html, /<em>italic<\/em>/);
    assert.match(html, /<a href="RULES\.html">link<\/a>/, 'links between documents point at the built pages');
    assert.match(html, /<ul>\s*<li>one<\/li>\s*<li>two<\/li>\s*<\/ul>/);
    assert.match(html, /<table>[\s\S]*<th>Rule<\/th>[\s\S]*<td><code>media\/gap<\/code><\/td>[\s\S]*<\/table>/);
    assert.match(html, /<pre><code class="language-bash">npm run docs\n<\/code><\/pre>/);
  });

  await test('renderMarkdown escapes what would otherwise be markup', () => {
    const html = renderMarkdown('A <script>alert(1)</script> and 5 < 6 & 7 > 6.\n\n```\n<MPD type="static"/>\n```\n');
    assert.ok(!html.includes('<script>'), 'no raw script tag survives');
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /5 &lt; 6 &amp; 7 &gt; 6/);
    assert.match(html, /&lt;MPD type="static"\/&gt;/, 'a code block is escaped too');
  });

  await test('renderMarkdown keeps inline code literal', () => {
    // The rule ids and tag names in these docs are full of characters that would
    // otherwise be read as emphasis or markup.
    const html = renderMarkdown('Use `#EXT-X-MAP:URI="init.mp4"` and `$Number$` and `a*b*c`.\n');
    assert.match(html, /<code>#EXT-X-MAP:URI="init\.mp4"<\/code>/);
    assert.match(html, /<code>\$Number\$<\/code>/);
    assert.match(html, /<code>a\*b\*c<\/code>/, 'asterisks inside code are not emphasis');
  });

  await test('renderMarkdown does not mistake a number in the prose for a code span', () => {
    // The code spans are lifted out and put back by index; a placeholder that can
    // occur in ordinary text would swallow it. These documents are full of numbers.
    const html = renderMarkdown('The ladder has 4 rungs and `EXT-X-VERSION` is 7, so 0 problems.\n');
    assert.match(html, /The ladder has 4 rungs and <code>EXT-X-VERSION<\/code> is 7, so 0 problems\./);
    assert.ok(!html.includes('undefined'));
  });

  await test('pageTitle falls back to the first heading of a generated document', () => {
    // docs/RULES.md and docs/ROADMAP.md are generated and carry no front matter; a
    // browser tab reading "HLS Lens" for every page is no navigation at all.
    assert.strictEqual(pageTitle(frontMatter('---\ntitle: Usage\n---\n\n# Something else\n')), 'Usage', 'front matter wins');
    assert.strictEqual(pageTitle(frontMatter('<!-- generated -->\n\n# Rules\n\nBody.\n')), 'Rules');
    assert.strictEqual(pageTitle(frontMatter('Body with no heading.\n')), undefined);
  });

  await test('renderPage wraps the body in a self-contained document', () => {
    const html = renderPage({ title: 'Usage', body: renderMarkdown('# Usage\n') }, 'USAGE.md');
    assert.match(html, /^<!doctype html>/i);
    assert.match(html, /<title>Usage · HLS Lens<\/title>/);
    // The landing page is already called HLS Lens: "HLS Lens · HLS Lens" is a tab
    // title nobody would write by hand.
    const landing = renderPage({ title: 'HLS Lens', body: '' }, 'index.md');
    assert.match(landing, /<title>HLS Lens<\/title>/);
    assert.match(html, /<style>/, 'the CSS is inline: the site is files, not a build system');
    assert.ok(!/<script/i.test(html), 'and there is no script at all');
    assert.match(html, /href="index\.html"/, 'every page carries the nav');
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(html), 'no date stamp: the output has to be reproducible');
  });

  await test('the real documents render without losing their headings', () => {
    for (const name of ['index.md', 'USAGE.md', 'RULES.md', 'ROADMAP.md']) {
      const source = fs.readFileSync(path.join(__dirname, '..', 'docs', name), 'utf8');
      const page = frontMatter(source);
      const html = renderMarkdown(page.body);
      const headings = (source.match(/^#{1,3} /gm) ?? []).length;
      const rendered = (html.match(/<h[1-3] /g) ?? []).length;
      assert.strictEqual(rendered, headings, `${name}: every heading survives`);
      assert.ok(!html.includes(' '));
    }
  });

  // ------------------------------------------------------------------- xml, mpd
  await test('parseXml reads elements, attributes and nesting with line numbers', () => {
    const { root } = parseXml(
      [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<!-- a comment -->',
        '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT30S">',
        '  <Period id="p0">',
        "    <AdaptationSet mimeType='video/mp4' segmentAlignment='true'>",
        '      <Representation id="v0" bandwidth="2400000" width="1280" height="720"/>',
        '    </AdaptationSet>',
        '  </Period>',
        '</MPD>',
      ].join('\n'),
    );
    assert.ok(root, 'the document parses');
    assert.strictEqual(root!.name, 'MPD');
    assert.strictEqual(root!.line, 2, '0-based, like everything else in the core');
    assert.strictEqual(root!.attrs.get('type'), 'static');

    const period = root!.children[0];
    assert.strictEqual(period.name, 'Period');
    assert.strictEqual(period.line, 3);
    const set = period.children[0];
    assert.strictEqual(set.attrs.get('mimeType'), 'video/mp4', 'single quotes are quotes too');
    const rep = set.children[0];
    assert.strictEqual(rep.name, 'Representation');
    assert.strictEqual(rep.children.length, 0, 'a self-closing element has no children');
    assert.strictEqual(rep.attrs.get('bandwidth'), '2400000');
  });

  await test('parseXml survives a document that is not well formed', () => {
    const unclosed = parseXml('<MPD>\n  <Period>\n</MPD>\n');
    assert.ok(unclosed.errors.length > 0, 'it says what is wrong');
    assert.ok(unclosed.root, 'and still returns what it could read');
    assert.strictEqual(parseXml('not xml at all').root, null);
    assert.doesNotThrow(() => parseXml('<a attr="unterminated>'));
  });

  await test('findAll walks the whole tree, attr reads one value', () => {
    const { root } = parseXml(
      '<MPD>\n<Period>\n<AdaptationSet>\n<Representation id="a"/>\n<Representation id="b"/>\n</AdaptationSet>\n</Period>\n<Period>\n<AdaptationSet>\n<Representation id="c"/>\n</AdaptationSet>\n</Period>\n</MPD>\n',
    );
    const reps = findAll(root!, 'Representation');
    assert.deepStrictEqual(reps.map((r) => attr(r, 'id')), ['a', 'b', 'c']);
    assert.strictEqual(attr(reps[0], 'missing'), undefined);
  });

  await test('parseIsoDuration reads the durations DASH writes', () => {
    assert.strictEqual(parseIsoDuration('PT30S'), 30);
    assert.strictEqual(parseIsoDuration('PT1M30.5S'), 90.5);
    assert.strictEqual(parseIsoDuration('PT2H3M4S'), 7384);
    assert.strictEqual(parseIsoDuration('P1DT1S'), 86401);
    assert.strictEqual(parseIsoDuration('PT0S'), 0);
    assert.strictEqual(parseIsoDuration('30'), null, 'a bare number is not an ISO duration');
    assert.strictEqual(parseIsoDuration(undefined), null);
  });

  // ------------------------------------------------------------------ dash rules
  const mpd = (body: string, attrs = 'type="static" mediaPresentationDuration="PT12S"'): string =>
    `<?xml version="1.0"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" ${attrs}>\n${body}\n</MPD>\n`;
  const mpdBody = (segments: string): string =>
    `  <Period id="p0">\n    <AdaptationSet mimeType="video/mp4" segmentAlignment="true">\n      <SegmentTemplate media="$RepresentationID$-$Number$.m4s" initialization="$RepresentationID$-init.mp4" timescale="1000" startNumber="1">\n        <SegmentTimeline>\n${segments}\n        </SegmentTimeline>\n      </SegmentTemplate>\n      <Representation id="v0" bandwidth="2400000" codecs="avc1.4d401f" width="1280" height="720"/>\n    </AdaptationSet>\n  </Period>`;

  await test('a well-formed MPD reports nothing', () => {
    const text = mpd(mpdBody('          <S t="0" d="4000" r="2"/>'));
    assert.deepStrictEqual(analyzeMpd(text), []);
  });

  await test('dash/timeline-gap catches segments that do not chain', () => {
    // 0-4000, then 8000: the second S starts a full segment after the first ends.
    const text = mpd(mpdBody('          <S t="0" d="4000"/>\n          <S t="8000" d="4000"/>'), 'type="static" mediaPresentationDuration="PT12S"');
    const found = analyzeMpd(text).filter((f) => f.rule === 'dash/timeline-gap');
    assert.strictEqual(found.length, 1);
    assert.match(found[0].message, /4000|4s|gap/i);
    assert.ok(found[0].line > 0, 'it points at the S element');
  });

  await test('dash/duration-vs-timeline catches a presentation duration the segments do not fill', () => {
    // Timeline covers 12s, the MPD claims 30.
    const text = mpd(mpdBody('          <S t="0" d="4000" r="2"/>'), 'type="static" mediaPresentationDuration="PT30S"');
    const found = analyzeMpd(text).filter((f) => f.rule === 'dash/duration-vs-timeline');
    assert.strictEqual(found.length, 1);
    assert.match(found[0].message, /30|12/);
  });

  await test('dash/dynamic-without-utctiming catches a live MPD with no clock to sync to', () => {
    const live = mpd(mpdBody('          <S t="0" d="4000" r="2"/>'), 'type="dynamic" availabilityStartTime="2026-08-17T10:00:00Z" minimumUpdatePeriod="PT4S"');
    const found = analyzeMpd(live).filter((f) => f.rule === 'dash/dynamic-without-utctiming');
    assert.strictEqual(found.length, 1);

    const withClock = live.replace('</MPD>', '  <UTCTiming schemeIdUri="urn:mpeg:dash:utc:http-iso:2014" value="https://time.akamai.com/?iso"/>\n</MPD>');
    assert.deepStrictEqual(analyzeMpd(withClock).filter((f) => f.rule === 'dash/dynamic-without-utctiming'), []);
  });

  await test('dash/adaptationset-not-aligned and the representation basics', () => {
    const unaligned = mpd(
      '  <Period id="p0">\n    <AdaptationSet mimeType="video/mp4">\n      <Representation id="v0" bandwidth="2400000"/>\n      <Representation id="v1"/>\n    </AdaptationSet>\n  </Period>',
    );
    const ids = analyzeMpd(unaligned).map((f) => f.rule);
    assert.ok(ids.includes('dash/adaptationset-not-aligned'), 'two representations and no segmentAlignment');
    assert.ok(ids.includes('dash/missing-bandwidth'), 'a representation with no bandwidth cannot be ranked');
    assert.ok(ids.includes('dash/missing-codecs'));

    const single = mpd('  <Period id="p0">\n    <AdaptationSet mimeType="video/mp4">\n      <Representation id="v0" bandwidth="2400000" codecs="avc1.4d401f"/>\n    </AdaptationSet>\n  </Period>');
    assert.deepStrictEqual(
      analyzeMpd(single).filter((f) => f.rule === 'dash/adaptationset-not-aligned'),
      [],
      'one representation has nothing to be aligned with',
    );
  });

  await test('dash/segment-template-without-number catches a template that cannot address a segment', () => {
    const text = mpd(
      '  <Period id="p0">\n    <AdaptationSet mimeType="video/mp4" segmentAlignment="true">\n      <SegmentTemplate media="chunk.m4s" initialization="init.mp4"/>\n      <Representation id="v0" bandwidth="2400000" codecs="avc1.4d401f"/>\n    </AdaptationSet>\n  </Period>',
    );
    const found = analyzeMpd(text).filter((f) => f.rule === 'dash/segment-template-without-number');
    assert.strictEqual(found.length, 1);
  });

  await test('analyzeMpd reports a document that is not an MPD instead of guessing', () => {
    const found = analyzeMpd('<html><body>404 not found</body></html>');
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].rule, 'dash/not-an-mpd');
    assert.strictEqual(found[0].severity, 'error');
  });

  await test('the broken MPD fixture is caught rule by rule', () => {
    const found = analyzeMpd(fixture('dash-broken.mpd'));
    const ids = new Set(found.map((f) => f.rule));
    for (const expected of [
      'dash/timeline-gap',
      'dash/duration-vs-timeline',
      'dash/dynamic-without-utctiming',
      'dash/adaptationset-not-aligned',
      'dash/missing-bandwidth',
      'dash/missing-codecs',
      'dash/segment-template-without-number',
      'dash/segment-template-without-init',
    ]) {
      assert.ok(ids.has(expected), `${expected} fires on the fixture`);
    }
    assert.ok(
      found.every((f) => f.line > 0 && f.line < fixture('dash-broken.mpd').split('\n').length),
      'every finding points at a line of the file',
    );
  });

  await test('every dash finding is documented in the catalogue', () => {
    const documented = new Set(RULES.map((r) => r.id));
    const emitted = [
      ...analyzeMpd(mpd(mpdBody('          <S t="0" d="4000"/>\n          <S t="8000" d="4000"/>'), 'type="dynamic" availabilityStartTime="2026-08-17T10:00:00Z"')),
      ...analyzeMpd('<html/>'),
    ];
    assert.ok(emitted.length >= 3);
    for (const finding of emitted) {
      assert.ok(documented.has(finding.rule), `${finding.rule} is documented`);
      assert.ok(finding.rule.startsWith('dash/'), `${finding.rule} is in the dash category`);
    }
  });

  // ---------------------------------------------------------------- live watch
  const window = (first: number, count: number, extra: { endlist?: boolean; discontinuityAt?: number } = {}): string => {
    const out = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:6', `#EXT-X-MEDIA-SEQUENCE:${first}`];
    for (let i = 0; i < count; i++) {
      if (extra.discontinuityAt === first + i) out.push('#EXT-X-DISCONTINUITY');
      out.push('#EXTINF:6.000,', `seg-${first + i}.ts`);
    }
    if (extra.endlist) out.push('#EXT-X-ENDLIST');
    return out.join('\n');
  };

  await test('diffPlaylists reports the segments a live window gained and dropped', () => {
    const before = parsePlaylist(window(100, 3));
    const after = parsePlaylist(window(101, 3));
    const change = diffPlaylists(before, after);
    assert.deepStrictEqual(change.added.map((s) => s.uri), ['seg-103.ts']);
    assert.strictEqual(change.droppedFromFront, 1);
    assert.strictEqual(change.mediaSequenceAdvance, 1);
    assert.strictEqual(change.stalled, false);
    assert.strictEqual(change.endedNow, false);
  });

  await test('diffPlaylists calls an unchanged window stalled', () => {
    const same = window(100, 3);
    const change = diffPlaylists(parsePlaylist(same), parsePlaylist(same));
    assert.strictEqual(change.stalled, true, 'a live playlist that did not move is the thing to report');
    assert.deepStrictEqual(change.added, []);
    assert.strictEqual(change.droppedFromFront, 0);
  });

  await test('diffPlaylists sees an EVENT window that only grows', () => {
    const change = diffPlaylists(parsePlaylist(window(0, 3)), parsePlaylist(window(0, 5)));
    assert.strictEqual(change.droppedFromFront, 0, 'nothing slid off the front');
    assert.strictEqual(change.added.length, 2);
    assert.strictEqual(change.stalled, false);
  });

  await test('diffPlaylists notices the stream ending and a discontinuity arriving', () => {
    const ended = diffPlaylists(parsePlaylist(window(100, 3)), parsePlaylist(window(100, 3, { endlist: true })));
    assert.strictEqual(ended.endedNow, true);
    assert.strictEqual(ended.stalled, false, 'an ENDLIST is a change, not a stall');

    const broke = diffPlaylists(parsePlaylist(window(100, 3)), parsePlaylist(window(101, 3, { discontinuityAt: 103 })));
    assert.deepStrictEqual(broke.discontinuities, ['seg-103.ts'], 'the new segment carries a discontinuity');
  });

  await test('describeChange says what happened in one line', () => {
    const moved = describeChange(diffPlaylists(parsePlaylist(window(100, 3)), parsePlaylist(window(101, 3))));
    assert.match(moved, /1 new segment/);
    assert.match(moved, /seg-103\.ts/);

    const stalled = describeChange(diffPlaylists(parsePlaylist(window(100, 3)), parsePlaylist(window(100, 3))));
    assert.match(stalled, /did not move|unchanged|stalled/i);

    const ended = describeChange(diffPlaylists(parsePlaylist(window(100, 3)), parsePlaylist(window(100, 3, { endlist: true }))));
    assert.match(ended, /ENDLIST|ended/i);
  });

  await test('watchIntervalMs follows the target duration, within sane bounds', () => {
    assert.strictEqual(watchIntervalMs(parsePlaylist(window(100, 3)), 0), 6000, 'a 6s target duration polls every 6s');
    assert.strictEqual(watchIntervalMs(parsePlaylist(window(100, 3)), 15), 15000, 'an explicit interval wins');
    assert.strictEqual(watchIntervalMs(parsePlaylist('#EXTM3U\n'), 0), 6000, 'no target duration falls back to 6s');
    assert.strictEqual(watchIntervalMs(parsePlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:1\n'), 0), 2000, 'and never hammers the CDN faster than 2s');
  });

  // ------------------------------------------------------------- cross-playlist
  /** A rendition as the cross-check sees it: the master's line, and the loaded playlist. */
  const rendition = (uri: string, line: number, text: string): LoadedRendition => ({
    uri,
    line,
    bandwidth: null,
    playlist: parsePlaylist(text),
  });
  const timeline = (durations: number[], extra: { version?: number; endlist?: boolean; sequence?: number; discontinuityAt?: number } = {}): string => {
    const out = ['#EXTM3U', `#EXT-X-VERSION:${extra.version ?? 7}`, '#EXT-X-TARGETDURATION:6'];
    if (extra.sequence !== undefined) out.push(`#EXT-X-MEDIA-SEQUENCE:${extra.sequence}`);
    durations.forEach((d, i) => {
      if (extra.discontinuityAt === i) out.push('#EXT-X-DISCONTINUITY');
      out.push(`#EXTINF:${d.toFixed(3)},`, `seg-${i}.ts`);
    });
    if (extra.endlist ?? true) out.push('#EXT-X-ENDLIST');
    return out.join('\n');
  };

  await test('analyzeAcross says nothing when the renditions share a timeline', () => {
    const found = analyzeAcross([
      rendition('360p.m3u8', 3, timeline([6, 6, 6])),
      rendition('720p.m3u8', 5, timeline([6, 6, 6])),
      rendition('1080p.m3u8', 7, timeline([6, 6, 6])),
    ]);
    assert.deepStrictEqual(found, []);
  });

  await test('analyzeAcross catches a rendition with a different EXT-X-VERSION', () => {
    const found = analyzeAcross([
      rendition('360p.m3u8', 3, timeline([6, 6, 6])),
      rendition('720p.m3u8', 5, timeline([6, 6, 6], { version: 3 })),
    ]);
    const versions = found.filter((f) => f.rule === 'cross/version-mismatch');
    assert.strictEqual(versions.length, 1);
    assert.strictEqual(versions[0].line, 5, 'reported on the variant line of the master');
    assert.match(versions[0].message, /720p\.m3u8/);
    assert.match(versions[0].message, /3/);
  });

  await test('analyzeAcross catches renditions that do not have the same segments', () => {
    const shorter = analyzeAcross([
      rendition('360p.m3u8', 3, timeline([6, 6, 6])),
      rendition('720p.m3u8', 5, timeline([6, 6])),
    ]).filter((f) => f.rule === 'cross/segment-count-mismatch');
    assert.strictEqual(shorter.length, 1);
    assert.match(shorter[0].message, /3|2/);

    // Same count and same total, boundaries in different places: a player switching
    // rungs mid-stream lands in the middle of a segment.
    const drifting = analyzeAcross([
      rendition('360p.m3u8', 3, timeline([6, 6, 6])),
      rendition('720p.m3u8', 5, timeline([6, 5, 7])),
    ]).filter((f) => f.rule === 'cross/timeline-drift');
    assert.strictEqual(drifting.length, 1);
    assert.strictEqual(drifting[0].line, 5);

    const rounding = analyzeAcross([
      rendition('360p.m3u8', 3, timeline([6, 6, 6])),
      rendition('720p.m3u8', 5, timeline([6.001, 5.999, 6])),
    ]).filter((f) => f.rule === 'cross/timeline-drift');
    assert.deepStrictEqual(rounding, [], 'a millisecond of encoder rounding is not drift');
  });

  await test('analyzeAcross catches discontinuities that do not line up', () => {
    const found = analyzeAcross([
      rendition('360p.m3u8', 3, timeline([6, 6, 6], { discontinuityAt: 1 })),
      rendition('720p.m3u8', 5, timeline([6, 6, 6], { discontinuityAt: 2 })),
    ]).filter((f) => f.rule === 'cross/discontinuity-mismatch');
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].severity, 'error', 'an ad break in the wrong place per rung is a broken switch');
  });

  await test('analyzeAcross catches live windows that are not aligned', () => {
    const live = (sequence: number): string => timeline([6, 6, 6], { endlist: false, sequence });
    const found = analyzeAcross([rendition('360p.m3u8', 3, live(100)), rendition('720p.m3u8', 5, live(97))]);
    assert.strictEqual(found.filter((f) => f.rule === 'cross/media-sequence-mismatch').length, 1);

    const mixed = analyzeAcross([
      rendition('360p.m3u8', 3, timeline([6, 6, 6])),
      rendition('720p.m3u8', 5, timeline([6, 6, 6], { endlist: false })),
    ]).filter((f) => f.rule === 'cross/playlist-type-mismatch');
    assert.strictEqual(mixed.length, 1, 'one rung finished and one still live is not one stream');
  });

  await test('analyzeAcross compares EXT-X-BITRATE with the BANDWIDTH the master declares', () => {
    const withBitrate = [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-TARGETDURATION:6',
      '#EXT-X-BITRATE:5200', // kbps, well over the 2.4 Mbps the master promises
      '#EXTINF:6.000,',
      'a.ts',
      '#EXT-X-ENDLIST',
    ].join('\n');
    const loaded: LoadedRendition = { uri: '720p.m3u8', line: 5, bandwidth: 2400000, playlist: parsePlaylist(withBitrate) };
    const found = analyzeAcross([loaded]).filter((f) => f.rule === 'cross/bitrate-vs-declared');
    assert.strictEqual(found.length, 1);
    assert.match(found[0].message, /5200|5\.2|2400000|2\.4/);

    const honest: LoadedRendition = { ...loaded, bandwidth: 6000000 };
    assert.deepStrictEqual(
      analyzeAcross([honest]).filter((f) => f.rule === 'cross/bitrate-vs-declared'),
      [],
      'a BANDWIDTH above the declared peak is what the spec asks for',
    );
  });

  await test('analyzeAcross needs more than one rendition for the comparisons', () => {
    const alone = analyzeAcross([rendition('360p.m3u8', 3, timeline([6, 6, 6]))]);
    assert.deepStrictEqual(alone, [], 'nothing to compare a single rendition against');
    assert.deepStrictEqual(analyzeAcross([]), []);
  });

  await test('every cross rule is in the catalogue, like the single-file ones', () => {
    const documented = new Set(RULES.map((r) => r.id));
    const emitted = analyzeAcross([
      rendition('360p.m3u8', 3, timeline([6, 6, 6], { discontinuityAt: 1 })),
      rendition('720p.m3u8', 5, timeline([6, 5], { version: 3, endlist: false, sequence: 4, discontinuityAt: 0 })),
    ]);
    // Version, live-vs-finished and segment count; the boundary comparisons need an
    // equal count and are skipped here, which is the point of asserting on the ids.
    assert.ok(emitted.length >= 3, 'this pair diverges in several ways');
    for (const finding of emitted) {
      assert.ok(documented.has(finding.rule), `${finding.rule} is documented`);
      assert.ok(finding.rule.startsWith('cross/'), `${finding.rule} is in the cross category`);
    }
  });

  // ------------------------------------------------------------------ spec docs
  await test('tagSpec describes a tag, its version and where it belongs', () => {
    const target = tagSpec('EXT-X-TARGETDURATION');
    assert.ok(target, 'a tag every media playlist has is described');
    assert.strictEqual(target!.since, 1);
    assert.strictEqual(target!.scope, 'media');
    assert.ok(target!.summary.length > 20, 'the summary says something, not just the tag name');

    const map = tagSpec('EXT-X-MAP');
    assert.strictEqual(map!.since, 5);
    assert.ok(map!.attributes.some((a) => a.name === 'URI' && a.required));
    assert.ok(map!.attributes.some((a) => a.name === 'BYTERANGE'));

    const media = tagSpec('EXT-X-MEDIA')!;
    const type = media.attributes.find((a) => a.name === 'TYPE')!;
    assert.deepStrictEqual(type.values, ['AUDIO', 'VIDEO', 'SUBTITLES', 'CLOSED-CAPTIONS']);

    assert.strictEqual(tagSpec('EXT-X-TARGETDURATON'), undefined, 'a typo has no spec');
    assert.strictEqual(tagSpec('#EXT-X-VERSION'), tagSpec('EXT-X-VERSION'), 'the leading # is optional');
  });

  await test('every tag the parser knows is documented, and every documented tag is known', () => {
    // The hover is only useful if it covers what the parser recognises; a tag in one
    // list and not the other is how a hover silently goes missing.
    const documented = new Set(SPEC_TAGS.map((t) => t.name));
    const parsed = parsePlaylist('#EXTM3U\n');
    assert.ok(parsed.startsWithExtM3U);
    for (const name of KNOWN_TAG_NAMES) {
      assert.ok(documented.has(name), `${name} has a spec entry`);
    }
    for (const spec of SPEC_TAGS) {
      assert.ok(KNOWN_TAG_NAMES.includes(spec.name), `${spec.name} is a tag the parser knows`);
      assert.ok(spec.summary.trim().length > 0, `${spec.name} has a summary`);
    }
  });

  await test('renderTagHover reads like the spec, in markdown', () => {
    const md = renderTagHover('EXT-X-KEY')!;
    assert.match(md, /EXT-X-KEY/);
    assert.match(md, /version 1|since/i, 'the required version is in there');
    assert.match(md, /METHOD/, 'the attributes are listed');
    assert.match(md, /AES-128/, 'with their enumerated values');
    assert.strictEqual(renderTagHover('EXT-X-NOPE'), undefined);
  });

  // ---------------------------------------------------------------- completions
  await test('completeAt offers tags at the start of a line', () => {
    const at = completeAt('#EXT-X-T', 8, 'media');
    assert.strictEqual(at.kind, 'tag');
    assert.ok(at.items.includes('EXT-X-TARGETDURATION'));
    assert.ok(!at.items.includes('EXT-X-STREAM-INF'), 'a media playlist is not offered master tags');
    assert.ok(
      completeAt('#', 1, 'master').items.includes('EXT-X-STREAM-INF'),
      'and a master playlist is offered its own',
    );
  });

  await test('completeAt offers attributes inside a tag that takes them', () => {
    const line = '#EXT-X-MEDIA:TYPE=AUDIO,';
    const at = completeAt(line, line.length, 'master');
    assert.strictEqual(at.kind, 'attribute');
    assert.ok(at.items.includes('GROUP-ID'));
    assert.ok(!at.items.includes('TYPE'), 'an attribute already on the line is not offered twice');
  });

  await test('completeAt offers the enumerated values after an =', () => {
    const line = '#EXT-X-MEDIA:TYPE=';
    const at = completeAt(line, line.length, 'master');
    assert.strictEqual(at.kind, 'value');
    assert.deepStrictEqual(at.items, ['AUDIO', 'VIDEO', 'SUBTITLES', 'CLOSED-CAPTIONS']);
    assert.deepStrictEqual(completeAt('#EXT-X-MEDIA:DEFAULT=', 21, 'master').items, ['YES', 'NO']);
    assert.deepStrictEqual(completeAt('#EXT-X-MEDIA:NAME=', 18, 'master').items, [], 'a free-text attribute has no list');
  });

  await test('completeAt keeps quiet where a completion would be noise', () => {
    assert.deepStrictEqual(completeAt('segment-00042.ts', 16, 'media').items, [], 'a URI line is not a tag');
    assert.strictEqual(completeAt('#EXT-X-ENDLIST', 14, 'media').kind, 'tag');
    assert.deepStrictEqual(completeAt('#EXT-X-TARGETDURATION:', 22, 'media').items, [], 'a value-only tag has no attribute list');
  });

  // ----------------------------------------------------------------- quick fixes
  await test('quickFixesFor bumps EXT-X-VERSION to what the playlist needs', () => {
    const pl = parsePlaylist('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6.000,\na.m4s\n#EXT-X-ENDLIST\n');
    const finding = analyze(pl).find((f) => f.rule === 'syntax/version-too-low')!;
    assert.ok(finding, 'the fixture needs the fix');
    const [fix] = quickFixesFor(pl, finding);
    assert.ok(fix, 'the rule has a fix');
    assert.match(fix.title, /EXT-X-VERSION/);
    assert.deepStrictEqual(fix.edit, { kind: 'replace', line: 1, text: '#EXT-X-VERSION:6' });
  });

  await test('quickFixesFor appends a missing EXT-X-ENDLIST at the end', () => {
    const pl = parsePlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:6.000,\na.ts\n');
    const finding = analyze(pl).find((f) => f.rule === 'media/missing-endlist')!;
    const [fix] = quickFixesFor(pl, finding);
    assert.deepStrictEqual(fix.edit, { kind: 'insertAfter', line: 4, text: '#EXT-X-ENDLIST' });
  });

  await test('quickFixesFor raises EXT-X-TARGETDURATION to the longest segment', () => {
    const pl = parsePlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:8.500,\na.ts\n#EXT-X-ENDLIST\n');
    const finding = analyze(pl).find((f) => f.rule === 'media/extinf-exceeds-target')!;
    const [fix] = quickFixesFor(pl, finding);
    assert.deepStrictEqual(fix.edit, { kind: 'replace', line: 1, text: '#EXT-X-TARGETDURATION:9' });
  });

  await test('quickFixesFor offers nothing for a finding no edit can settle', () => {
    const pl = parsePlaylist(fixture('master-broken.m3u8'));
    const judgement = analyze(pl).find((f) => f.rule === 'master/missing-codecs')!;
    assert.deepStrictEqual(quickFixesFor(pl, judgement), [], 'only the mechanical findings get a fix');
  });

  // ----------------------------------------------------------------------- icon
  await test('drawIcon is deterministic and draws the mark it claims', () => {
    const first = drawIcon();
    const second = drawIcon();
    assert.strictEqual(first.size, 128, 'the Marketplace size');
    assert.strictEqual(first.rgba.length, 128 * 128 * 4, 'RGBA, one byte per channel');
    assert.ok(Buffer.from(first.rgba).equals(Buffer.from(second.rgba)), 'same pixels every run');

    const at = (x: number, y: number) => Array.from(first.rgba.subarray((y * 128 + x) * 4, (y * 128 + x) * 4 + 4));
    assert.deepStrictEqual(at(64, 4), [11, 18, 32, 255], 'the #0B1220 background, away from the corner radius');
    assert.deepStrictEqual(at(0, 0), [0, 0, 0, 0], 'the rounded corner is transparent, not black');
    // The tallest rung stands at design x=83..97, y=20..104 in a 128px icon.
    assert.deepStrictEqual(at(90, 95), [16, 185, 129, 255], 'the tallest rung is the full-strength green');
    assert.deepStrictEqual(at(26, 95), [45, 212, 191, 255], 'the lowest rung is the dimmer teal');
    assert.deepStrictEqual(at(90, 49), [239, 68, 68, 255], 'the defect mark is red');
  });

  await test('the lens holds a play triangle, the video the ladder is made of', () => {
    const { rgba } = drawIcon();
    const at = (x: number, y: number) => Array.from(rgba.subarray((y * 128 + x) * 4, (y * 128 + x) * 4 + 4));
    // The triangle spans design (34,34)-(34,58)-(58,46), inside the lens ring.
    assert.deepStrictEqual(at(42, 46), [226, 232, 240, 255], 'the play mark is the lens colour');
    assert.deepStrictEqual(at(52, 46), [226, 232, 240, 255], 'and it reaches towards the apex');
    assert.deepStrictEqual(at(44, 56), [11, 18, 32, 255], 'below the triangle the lens still shows the ink through');
    assert.deepStrictEqual(at(61, 46), [11, 18, 32, 255], 'the apex stops short of the ring');
  });

  await test('encodePng and decodePng round-trip the pixels', () => {
    const { size, rgba } = drawIcon();
    const png = encodePng(rgba, size, size);
    assert.ok(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'PNG signature');
    const decoded = decodePng(png);
    assert.strictEqual(decoded.width, size);
    assert.strictEqual(decoded.height, size);
    assert.ok(decoded.rgba.equals(Buffer.from(rgba)), 'what comes back out is what went in');
  });

  await test('decodePng rejects a file this generator did not write', () => {
    assert.throws(() => decodePng(Buffer.from('not a png at all')), /not a PNG/i);
    const { size, rgba } = drawIcon();
    const truncated = encodePng(rgba, size, size).subarray(0, 20);
    assert.throws(() => decodePng(truncated), /IHDR|raw size|inflate|IDAT/i);
  });

  await test('comparePixels finds an altered pixel and ignores the compression', () => {
    const { size, rgba } = drawIcon();
    // The same image compressed differently is the CI failure this replaced: a
    // different zlib emits a different byte stream for identical pixels.
    const strong = encodePng(rgba, size, size, 9);
    const weak = encodePng(rgba, size, size, 1);
    assert.ok(!strong.equals(weak), 'the two encodings really do differ byte for byte');
    assert.strictEqual(comparePixels(decodePng(weak).rgba, rgba), null, 'but the pixels are the same');

    const altered = Buffer.from(rgba);
    altered[(64 * size + 64) * 4] ^= 0xff;
    const diff = comparePixels(decodePng(encodePng(altered, size, size)).rgba, rgba);
    assert.deepStrictEqual(diff, { differing: 1, firstPixel: 64 * size + 64 });
  });

  // ------------------------------------------------------------------ timeline
  await test('buildTimeline lays the segments end to end and keeps their marks', () => {
    const text =
      '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n' +
      '#EXTINF:6.000,\na.ts\n' +
      '#EXT-X-DISCONTINUITY\n#EXTINF:4.000,\nb.ts\n' +
      '#EXT-X-GAP\n#EXTINF:6.000,\nc.ts\n#EXT-X-ENDLIST\n';
    const model = buildTimeline([{ label: '1080p', playlist: parsePlaylist(text) }]);
    assert.strictEqual(model.rows.length, 1);
    const spans = model.rows[0].spans;
    assert.deepStrictEqual(
      spans.map((s) => s.start),
      [0, 6, 10],
    );
    assert.deepStrictEqual(
      spans.map((s) => s.duration),
      [6, 4, 6],
    );
    assert.strictEqual(spans[1].discontinuity, true);
    assert.strictEqual(spans[2].gap, true);
    assert.strictEqual(model.duration, 16);
    // The line is the EXTINF's own, so clicking a bar can reveal it in the editor.
    assert.ok(parsePlaylist(text).lines[spans[1].line].startsWith('#EXTINF:4.000'));
  });

  await test('an ad break is marked on the segments its DATERANGE covers', () => {
    const withPdt =
      '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n' +
      '#EXT-X-PROGRAM-DATE-TIME:2026-08-18T10:00:00.000Z\n' +
      '#EXT-X-DATERANGE:ID="ad1",CLASS="com.example.ad",START-DATE="2026-08-18T10:00:06.000Z",DURATION=6.0,SCTE35-OUT=0xFC\n' +
      '#EXTINF:6.000,\na.ts\n#EXTINF:6.000,\nb.ts\n#EXTINF:6.000,\nc.ts\n#EXT-X-ENDLIST\n';
    const marked = buildTimeline([{ label: '720p', playlist: parsePlaylist(withPdt) }]).rows[0].spans;
    assert.deepStrictEqual(
      marked.map((s) => s.ad),
      [false, true, false],
    );

    // Without a wall clock there is nothing to anchor the range to, so nothing is
    // marked: a guessed ad break is worse than none.
    const noPdt = withPdt
      .split('\n')
      .filter((l) => !l.startsWith('#EXT-X-PROGRAM-DATE-TIME'))
      .join('\n');
    const unmarked = buildTimeline([{ label: '720p', playlist: parsePlaylist(noPdt) }]).rows[0].spans;
    assert.deepStrictEqual(
      unmarked.map((s) => s.ad),
      [false, false, false],
    );
  });

  await test('rows that do not share their boundaries are reported as misaligned', () => {
    const even = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.000,\na.ts\n#EXTINF:6.000,\nb.ts\n#EXT-X-ENDLIST\n';
    const odd = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:5.000,\na.ts\n#EXTINF:7.000,\nb.ts\n#EXT-X-ENDLIST\n';
    const together = buildTimeline([
      { label: '1080p', playlist: parsePlaylist(even) },
      { label: '720p', playlist: parsePlaylist(odd) },
    ]);
    assert.deepStrictEqual(together.misaligned, [5, 6]);
    assert.ok(!together.rows[0].aligned);
    assert.ok(!together.rows[1].aligned);

    const same = buildTimeline([
      { label: '1080p', playlist: parsePlaylist(even) },
      { label: '720p', playlist: parsePlaylist(even) },
    ]);
    assert.deepStrictEqual(same.misaligned, []);
    assert.ok(same.rows.every((r) => r.aligned));

    // One rendition has nothing to be out of step with.
    assert.ok(buildTimeline([{ label: 'only', playlist: parsePlaylist(odd) }]).rows[0].aligned);
  });

  await test('only the rendition that drifts is called out of step', () => {
    const even = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.000,\na.ts\n#EXTINF:6.000,\nb.ts\n#EXT-X-ENDLIST\n';
    const odd = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:5.000,\na.ts\n#EXTINF:7.000,\nb.ts\n#EXT-X-ENDLIST\n';
    const model = buildTimeline([
      { label: '1080p', playlist: parsePlaylist(even) },
      { label: '720p', playlist: parsePlaylist(even) },
      { label: '360p', playlist: parsePlaylist(odd) },
    ]);
    // Two rungs agree on the boundary at 6s and one puts it at 5s: it is that one
    // that is wrong, and saying "all three are out of step" would hide it.
    assert.deepStrictEqual(
      model.rows.map((r) => r.aligned),
      [true, true, false],
    );
  });

  await test('the axis ticks are round numbers a person can read', () => {
    assert.deepStrictEqual(niceTicks(60), [0, 10, 20, 30, 40, 50, 60]);
    assert.deepStrictEqual(niceTicks(3), [0, 1, 2, 3]);
    assert.ok(niceTicks(3600).every((t) => t % 600 === 0));
    assert.deepStrictEqual(niceTicks(0), [0]);
  });

  await test('the timeline renders as one self-contained page', () => {
    const text = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.000,\na&b.ts\n#EXT-X-ENDLIST\n';
    const model = buildTimeline([{ label: '1080p "high"', playlist: parsePlaylist(text) }]);
    const html = renderTimelineHtml(model, { title: 'live.m3u8', nonce: 'n0nce' });
    assert.ok(html.startsWith('<!doctype html>'));
    assert.ok(html.includes('1080p &quot;high&quot;'), 'the label is escaped');
    assert.ok(html.includes('a&amp;b.ts'), 'the segment URI is escaped');
    assert.ok(html.includes('data-line="2"'), 'the bar carries the line to reveal');
    assert.ok(html.includes('nonce="n0nce"'), 'the script is nonced');
    // Nothing is fetched: a webview that reaches the network is a webview that
    // leaks which manifests were opened.
    assert.ok(!/(src|href)="https?:/.test(html), 'no external resource');
    assert.strictEqual(html, renderTimelineHtml(model, { title: 'live.m3u8', nonce: 'n0nce' }));
  });

  // ------------------------------------------------------- severity, more fixes
  await test('a rule can be re-graded by id, by category, or switched off', () => {
    const findings: Finding[] = [
      { rule: 'master/missing-bandwidth', severity: 'error', line: 5, message: 'a' },
      { rule: 'master/ladder-spacing', severity: 'hint', line: 2, message: 'b' },
      { rule: 'media/gap-segments', severity: 'warning', line: 9, message: 'c' },
    ];

    const graded = applySeverityOverrides(findings, { 'master/ladder-spacing': 'error' });
    assert.strictEqual(severityOf(graded, 'master/ladder-spacing'), 'error');
    // Re-graded findings are re-sorted: the panel is ordered worst first, and a rule
    // promoted to error that stayed at the bottom would be worse than not promoting it.
    assert.deepStrictEqual(
      graded.map((f) => f.rule),
      ['master/ladder-spacing', 'master/missing-bandwidth', 'media/gap-segments'],
    );

    const byCategory = applySeverityOverrides(findings, { master: 'hint' });
    assert.strictEqual(severityOf(byCategory, 'master/missing-bandwidth'), 'hint');
    assert.strictEqual(severityOf(byCategory, 'media/gap-segments'), 'warning');

    // The more specific setting wins, whichever order they are written in.
    const both = applySeverityOverrides(findings, { master: 'hint', 'master/missing-bandwidth': 'error' });
    assert.strictEqual(severityOf(both, 'master/missing-bandwidth'), 'error');
    assert.strictEqual(severityOf(both, 'master/ladder-spacing'), 'hint');

    const off = applySeverityOverrides(findings, { 'media/gap-segments': 'off' });
    assert.deepStrictEqual(ruleIds(off), ['master/missing-bandwidth', 'master/ladder-spacing']);

    // A value that is not a severity is a typo in a settings file. Dropping the rule
    // or guessing at the intent would both hide it; leaving it alone does not.
    const typo = applySeverityOverrides(findings, { 'master/missing-bandwidth': 'errror' });
    assert.strictEqual(severityOf(typo, 'master/missing-bandwidth'), 'error');
    assert.strictEqual(typo.length, 3);
  });

  await test('a misspelled tag is offered the tag it was meant to be', () => {
    const text = '#EXTM3U\n#EXT-X-TARGETDURATON:6\n#EXTINF:6.000,\na.ts\n#EXT-X-ENDLIST\n';
    const pl = parsePlaylist(text);
    const finding = analyze(pl).find((f) => f.rule === 'syntax/unknown-tag');
    assert.ok(finding, 'the misspelling is reported');
    const fixes = quickFixesFor(pl, finding!);
    assert.strictEqual(fixes.length, 1);
    assert.ok(fixes[0].title.includes('EXT-X-TARGETDURATION'), fixes[0].title);
    // The value after the colon is the author's, and is kept.
    assert.deepStrictEqual(fixes[0].edit, { kind: 'replace', line: 1, text: '#EXT-X-TARGETDURATION:6' });

    // Nothing close enough is nothing to offer: a guess here rewrites a line the
    // author may have meant, and the tag may be from a spec this parser predates.
    const alien = parsePlaylist('#EXTM3U\n#EXT-X-CUSTOM-VENDOR-THING:1\n#EXT-X-ENDLIST\n');
    const unknown = analyze(alien).find((f) => f.rule === 'syntax/unknown-tag');
    assert.deepStrictEqual(quickFixesFor(alien, unknown!), []);
  });

  await test('the contradictory rendition flags have a fix each', () => {
    const master = (media: string): string =>
      `#EXTM3U\n#EXT-X-VERSION:7\n${media}\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360,CODECS="avc1.4d401e",AUDIO="a"\nv.m3u8\n`;

    const contradiction = master('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",DEFAULT=YES,AUTOSELECT=NO,URI="a.m3u8"');
    const pl = parsePlaylist(contradiction);
    const defaulted = analyze(pl).find((f) => f.rule === 'master/rendition-default-not-autoselect');
    const fix = quickFixesFor(pl, defaulted!)[0];
    assert.ok(fix.edit.kind === 'replace' && fix.edit.text.includes('AUTOSELECT=YES'), JSON.stringify(fix));
    assert.ok(fix.edit.kind === 'replace' && !fix.edit.text.includes('AUTOSELECT=NO'));

    const forced = master('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",DEFAULT=YES,AUTOSELECT=YES,FORCED=YES,URI="a.m3u8"');
    const forcedPl = parsePlaylist(forced);
    const flagged = analyze(forcedPl).find((f) => f.rule === 'master/rendition-forced');
    const dropped = quickFixesFor(forcedPl, flagged!)[0];
    assert.ok(dropped.edit.kind === 'replace' && !dropped.edit.text.includes('FORCED'), JSON.stringify(dropped));
    // Dropping an attribute must not leave a stray comma behind.
    assert.ok(dropped.edit.kind === 'replace' && !/,\s*,/.test(dropped.edit.text));
    assert.ok(dropped.edit.kind === 'replace' && dropped.edit.text.includes('AUTOSELECT=YES,URI="a.m3u8"'));
  });

  // ------------------------------------------------------------------ mpd tree
  const MPD_TREE = [
    '<?xml version="1.0"?>',
    '<MPD type="static" mediaPresentationDuration="PT10M30S">',
    '  <Period id="main" start="PT0S">',
    '    <AdaptationSet id="1" contentType="video" segmentAlignment="true">',
    '      <Representation id="1080p" bandwidth="6100000" width="1920" height="1080" codecs="avc1.640028"/>',
    '      <Representation id="720p" bandwidth="3300000" width="1280" height="720" codecs="avc1.4d4028"/>',
    '    </AdaptationSet>',
    '    <AdaptationSet id="2" contentType="audio" lang="en">',
    '      <Representation id="audio-en" bandwidth="128000" codecs="mp4a.40.2"/>',
    '    </AdaptationSet>',
    '  </Period>',
    '</MPD>',
  ].join('\n');

  await test('the MPD tree nests representations under their adaptation set and period', () => {
    const rows = buildMpdTree(MPD_TREE);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].kind, 'period');
    assert.ok(rows[0].label.includes('main'), rows[0].label);
    assert.deepStrictEqual(
      rows[0].children.map((set) => set.label),
      ['video', 'audio'],
    );
    const video = rows[0].children[0];
    assert.deepStrictEqual(
      video.children.map((rep) => rep.label),
      ['1080p', '720p'],
    );
    // Every row points at the line that declares it, so clicking one reveals it.
    assert.ok(MPD_TREE.split('\n')[video.children[1].line].includes('id="720p"'));
    assert.ok(MPD_TREE.split('\n')[rows[0].line].includes('<Period'));
  });

  await test('an MPD row describes what a person is looking for', () => {
    const rows = buildMpdTree(MPD_TREE);
    const [video, audio] = rows[0].children;
    assert.ok(video.children[0].description.includes('1920x1080'), video.children[0].description);
    assert.ok(video.children[0].description.includes('6.10 Mbps'), video.children[0].description);
    assert.ok(video.description.includes('2 representations'), video.description);
    assert.ok(audio.description.includes('en'), audio.description);
    // The codecs belong in the tooltip, not in a row that has to stay readable.
    assert.ok(video.children[0].tooltip.includes('avc1.640028'));
  });

  await test('the MPD summary says what the manifest is', () => {
    const summary = mpdSummary(MPD_TREE);
    assert.ok(summary.includes('static'), summary);
    assert.ok(summary.includes('10:30'), summary);
    assert.ok(summary.includes('3 representations'), summary);

    // A live manifest has no duration to state, and says so by not stating one.
    const live = MPD_TREE.replace('type="static" mediaPresentationDuration="PT10M30S"', 'type="dynamic"');
    assert.ok(mpdSummary(live).includes('dynamic'), mpdSummary(live));
    assert.ok(!mpdSummary(live).includes('10:30'));
  });

  await test('a file that is not an MPD has no tree and says so', () => {
    assert.deepStrictEqual(buildMpdTree('<html><body>404</body></html>'), []);
    assert.strictEqual(mpdSummary('<html><body>404</body></html>'), 'not a DASH manifest');
  });

  // -------------------------------------------------------- low latency in the tree
  await test('the low-latency vocabulary has rows of its own', () => {
    const text = llPlaylist(
      '#EXT-X-PART:DURATION=0.500,URI="s10.0.m4s",INDEPENDENT=YES',
      '#EXT-X-PART:DURATION=0.500,URI="s10.1.m4s",GAP=YES',
      '#EXTINF:4.000,',
      's10.m4s',
      '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="s11.0.m4s"',
      '#EXT-X-RENDITION-REPORT:URI="../720p/live.m3u8",LAST-MSN=10,LAST-PART=1',
    );
    const pl = parsePlaylist(text);
    const rows = lowLatencyRows(pl);
    assert.deepStrictEqual(
      rows.map((r) => r.kind),
      ['server-control', 'part', 'part', 'preload-hint', 'rendition-report'],
    );

    // The server control row is the one that says whether the parts buy anything.
    assert.ok(rows[0].description.includes('blocking reload'), rows[0].description);
    assert.ok(rows[0].description.includes('part target 0.5s'), rows[0].description);

    assert.strictEqual(rows[1].label, 's10.0.m4s');
    assert.ok(rows[1].description.includes('0.5s'), rows[1].description);
    assert.ok(rows[1].description.includes('independent'), rows[1].description);
    assert.ok(rows[2].description.includes('GAP'), rows[2].description);
    assert.ok(pl.lines[rows[2].line].includes('s10.1.m4s'));

    assert.ok(rows[3].label.includes('s11.0.m4s'), rows[3].label);
    assert.ok(rows[4].description.includes('10'), rows[4].description);
  });

  await test('a playlist with no parts has no low-latency rows at all', () => {
    const plain = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.000,\na.ts\n#EXT-X-ENDLIST\n';
    assert.deepStrictEqual(lowLatencyRows(parsePlaylist(plain)), []);
  });

  await test('the parts listed are capped, and the cap is stated', () => {
    const parts = Array.from({ length: 60 }, (_unused, i) => `#EXT-X-PART:DURATION=0.500,URI="s10.${i}.m4s"`);
    const rows = lowLatencyRows(parsePlaylist(llPlaylist(...parts, '#EXTINF:4.000,', 's10.m4s')), { maxParts: 5 });
    assert.strictEqual(rows.filter((r) => r.kind === 'part').length, 5);
    const note = rows.find((r) => r.kind === 'note');
    assert.ok(note && note.label.includes('55 more'), JSON.stringify(note));
  });

  // -------------------------------------------------------------------- report
  const REPORT_ENTRIES = [
    {
      path: 'live/master.m3u8',
      findings: [
        { rule: 'master/missing-bandwidth', severity: 'error' as Severity, line: 4, message: 'the variant "a|b.m3u8" declares no BANDWIDTH', hint: 'add BANDWIDTH' },
        { rule: 'master/ladder-spacing', severity: 'hint' as Severity, line: 9, message: 'rungs are 1.1x apart' },
      ],
    },
    { path: 'live/audio.m3u8', findings: [] },
  ];

  await test('the markdown report survives a message with a pipe in it', () => {
    const markdown = renderFindingsMarkdown(REPORT_ENTRIES, { title: 'nightly' });
    assert.ok(markdown.startsWith('# nightly'), markdown.slice(0, 40));
    assert.ok(markdown.includes('2 manifests checked'), markdown);
    // A URI with a pipe in it would otherwise split the row into two columns.
    assert.ok(markdown.includes('a\\|b.m3u8'), markdown);
    assert.ok(markdown.includes('| 5 |'), 'lines are 1-based outside the editor');
    assert.ok(markdown.includes('master/ladder-spacing'));
    assert.strictEqual(markdown, renderFindingsMarkdown(REPORT_ENTRIES, { title: 'nightly' }));
  });

  await test('the JSON report is a stable, pinned shape', () => {
    const parsed = JSON.parse(renderFindingsJson(REPORT_ENTRIES));
    assert.strictEqual(parsed.tool, 'hls-lens');
    assert.strictEqual(parsed.schema, 1);
    assert.deepStrictEqual(parsed.summary, { files: 2, clean: 1, errors: 1, warnings: 0, hints: 1 });
    assert.strictEqual(parsed.files.length, 1, 'a clean manifest carries no findings to report');
    assert.strictEqual(parsed.files[0].path, 'live/master.m3u8');
    // 0-based lines are an editor detail; everything that reads this counts from 1.
    assert.strictEqual(parsed.files[0].findings[0].line, 5);
    assert.strictEqual(parsed.files[0].findings[0].hint, 'add BANDWIDTH');
    assert.ok(!('hint' in parsed.files[0].findings[1]), 'a finding with no hint carries no empty one');
  });

  await test('a report with nothing in it says so rather than printing an empty table', () => {
    const markdown = renderFindingsMarkdown([{ path: 'a.m3u8', findings: [] }], { title: 'clean' });
    assert.ok(/nothing to report/i.test(markdown), markdown);
    assert.ok(!markdown.includes('|'), 'no table for no rows');
  });

  // ----------------------------------------------------------------- workspace
  await test('a manifest is recognised by its extension, and nothing else is', () => {
    for (const path of ['live/master.m3u8', 'a.M3U8', 'old/playlist.m3u', 'dash/stream.mpd', 'DASH/STREAM.MPD']) {
      assert.ok(isManifestPath(path), path);
    }
    for (const path of ['notes.txt', 'seg-00001.ts', 'video.mp4', 'm3u8', 'a.m3u8.bak']) {
      assert.ok(!isManifestPath(path), path);
    }
  });

  await test('the workspace summary counts by severity and ranks the worst first', () => {
    const finding = (rule: string, severity: Severity): Finding => ({ rule, severity, line: 0, message: rule });
    const entries = [
      { path: 'b.m3u8', findings: [finding('x', 'warning'), finding('y', 'hint')] },
      { path: 'a.m3u8', findings: [] },
      { path: 'c.m3u8', findings: [finding('x', 'error'), finding('y', 'warning')] },
      // Same shape as b.m3u8: the tie breaks on the path, so the report is stable.
      { path: 'a2.m3u8', findings: [finding('x', 'warning'), finding('y', 'hint')] },
    ];
    const summary = summariseWorkspace(entries);
    assert.strictEqual(summary.files, 4);
    assert.strictEqual(summary.clean, 1);
    assert.deepStrictEqual(summary.counts, { errors: 1, warnings: 3, hints: 2 });
    assert.deepStrictEqual(
      summary.ranked.map((e) => e.path),
      ['c.m3u8', 'a2.m3u8', 'b.m3u8'],
    );
  });

  await test('the workspace report says what it left out', () => {
    const finding = (severity: Severity): Finding => ({ rule: 'r', severity, line: 0, message: 'm' });
    const entries = Array.from({ length: 5 }, (_unused, i) => ({
      path: `f${i}.m3u8`,
      findings: [finding('error')],
    }));
    const lines = renderWorkspaceReport(summariseWorkspace(entries), { limit: 2 });
    assert.ok(lines[0].includes('5 manifests'), lines[0]);
    assert.strictEqual(lines.filter((l) => l.includes('.m3u8')).length, 2);
    // A cap that is not stated reads as "this is everything".
    assert.ok(lines.some((l) => l.includes('3 more')), JSON.stringify(lines));
    assert.deepStrictEqual(lines, renderWorkspaceReport(summariseWorkspace(entries), { limit: 2 }));
  });

  await test('a clean workspace says so in one line', () => {
    const lines = renderWorkspaceReport(summariseWorkspace([{ path: 'a.m3u8', findings: [] }]));
    assert.strictEqual(lines.length, 1);
    assert.ok(lines[0].includes('1 manifest'), lines[0]);
    assert.ok(!lines[0].includes('manifests'), 'one manifest is not plural');
  });

  // ---------------------------------------------------------- rendition groups
  /** A master with the given EXT-X-MEDIA lines and one variant that uses group "a". */
  function masterWith(media: string, streamInf = ',AUDIO="a"'): string {
    return (
      `#EXTM3U\n#EXT-X-VERSION:7\n${media}\n` +
      `#EXT-X-STREAM-INF:BANDWIDTH=1000000,AVERAGE-BANDWIDTH=900000,RESOLUTION=640x360,CODECS="avc1.4d401e"${streamInf}\nv.m3u8\n`
    );
  }

  await test('a rendition says what it is, in which group, under a name', () => {
    for (const media of [
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a"',
      '#EXT-X-MEDIA:TYPE=AUDIO,NAME="English"',
      '#EXT-X-MEDIA:GROUP-ID="a",NAME="English"',
      '#EXT-X-MEDIA:TYPE=SUPERTITLES,GROUP-ID="a",NAME="English"',
    ]) {
      assert.ok(ruleIds(analyze(parsePlaylist(masterWith(media)))).includes('master/rendition-missing-attributes'), media);
    }
    const complete = '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",DEFAULT=YES,AUTOSELECT=YES,URI="a.m3u8"';
    assert.ok(!ruleIds(analyze(parsePlaylist(masterWith(complete)))).includes('master/rendition-missing-attributes'));
  });

  await test('subtitles carry a URI, closed captions carry an INSTREAM-ID instead', () => {
    const subs = (extra: string): string =>
      masterWith(`#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="English",DEFAULT=YES,AUTOSELECT=YES${extra}`, ',SUBTITLES="s"');
    assert.ok(ruleIds(analyze(parsePlaylist(subs('')))).includes('master/rendition-uri'));
    assert.ok(!ruleIds(analyze(parsePlaylist(subs(',URI="s.m3u8"')))).includes('master/rendition-uri'));

    const cc = (extra: string): string =>
      masterWith(`#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="cc",NAME="English",DEFAULT=YES,AUTOSELECT=YES${extra}`, ',CLOSED-CAPTIONS="cc"');
    // Captions are carried in the video stream: there is nothing to fetch, and the
    // INSTREAM-ID is what says where in the stream they are.
    assert.ok(ruleIds(analyze(parsePlaylist(cc('')))).includes('master/rendition-uri'));
    assert.ok(ruleIds(analyze(parsePlaylist(cc(',INSTREAM-ID="CC1",URI="cc.m3u8"')))).includes('master/rendition-uri'));
    assert.ok(!ruleIds(analyze(parsePlaylist(cc(',INSTREAM-ID="CC1"')))).includes('master/rendition-uri'));
  });

  await test('FORCED belongs to subtitles, and a default is autoselectable', () => {
    const forcedAudio = '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",DEFAULT=YES,AUTOSELECT=YES,FORCED=YES,URI="a.m3u8"';
    assert.ok(ruleIds(analyze(parsePlaylist(masterWith(forcedAudio)))).includes('master/rendition-forced'));
    const forcedSubs = '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="Forced",DEFAULT=YES,AUTOSELECT=YES,FORCED=YES,URI="s.m3u8"';
    assert.ok(!ruleIds(analyze(parsePlaylist(masterWith(forcedSubs, ',SUBTITLES="s"')))).includes('master/rendition-forced'));

    const contradiction = '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",DEFAULT=YES,AUTOSELECT=NO,URI="a.m3u8"';
    assert.ok(ruleIds(analyze(parsePlaylist(masterWith(contradiction)))).includes('master/rendition-default-not-autoselect'));
    // AUTOSELECT left out is not the same as AUTOSELECT=NO: only the explicit "no"
    // contradicts the default, and only that is reported.
    const silent = '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",DEFAULT=YES,URI="a.m3u8"';
    assert.ok(!ruleIds(analyze(parsePlaylist(masterWith(silent)))).includes('master/rendition-default-not-autoselect'));
  });

  await test('two renditions of one group do not share a name', () => {
    const twice =
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="en.m3u8"\n' +
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",LANGUAGE="en-GB",DEFAULT=NO,AUTOSELECT=YES,URI="gb.m3u8"';
    assert.ok(ruleIds(analyze(parsePlaylist(masterWith(twice)))).includes('master/rendition-duplicate-name'));

    // The same name in two different groups is two ladders, not a duplicate.
    const apart =
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",DEFAULT=YES,AUTOSELECT=YES,URI="en.m3u8"\n' +
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="English",DEFAULT=YES,AUTOSELECT=YES,URI="en-subs.m3u8"';
    assert.ok(!ruleIds(analyze(parsePlaylist(masterWith(apart, ',AUDIO="a",SUBTITLES="s"')))).includes('master/rendition-duplicate-name'));
  });

  await test('an audio group whose renditions differ in channel count is reported', () => {
    const mixed =
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Stereo",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="2.m3u8"\n' +
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Surround",DEFAULT=NO,AUTOSELECT=YES,CHANNELS="6",URI="6.m3u8"';
    assert.ok(ruleIds(analyze(parsePlaylist(masterWith(mixed)))).includes('master/audio-group-mixed-channels'));

    const even =
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="en.m3u8"\n' +
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Italiano",DEFAULT=NO,AUTOSELECT=YES,CHANNELS="2",URI="it.m3u8"';
    assert.ok(!ruleIds(analyze(parsePlaylist(masterWith(even)))).includes('master/audio-group-mixed-channels'));
  });

  await test('a rendition group nothing references is reported', () => {
    const orphan =
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",DEFAULT=YES,AUTOSELECT=YES,URI="a.m3u8"\n' +
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="English",DEFAULT=YES,AUTOSELECT=YES,URI="s.m3u8"';
    const found = findingsOf(masterWith(orphan), 'master/unused-group');
    assert.strictEqual(found.length, 1);
    assert.ok(parsePlaylist(masterWith(orphan)).lines[found[0].line].includes('TYPE=SUBTITLES'));
    assert.strictEqual(findingsOf(masterWith(orphan, ',AUDIO="a",SUBTITLES="s"'), 'master/unused-group').length, 0);
  });

  await test('the variants agree on which groups they use', () => {
    const media = '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",DEFAULT=YES,AUTOSELECT=YES,URI="a.m3u8"';
    const two = (first: string, second: string): string =>
      `#EXTM3U\n#EXT-X-VERSION:7\n${media}\n` +
      `#EXT-X-STREAM-INF:BANDWIDTH=1000000,AVERAGE-BANDWIDTH=900000,RESOLUTION=640x360,CODECS="avc1.4d401e"${first}\na.m3u8\n` +
      `#EXT-X-STREAM-INF:BANDWIDTH=2500000,AVERAGE-BANDWIDTH=2200000,RESOLUTION=1280x720,CODECS="avc1.4d401f"${second}\nb.m3u8\n`;
    assert.ok(ruleIds(analyze(parsePlaylist(two(',AUDIO="a"', '')))).includes('master/inconsistent-groups'));
    assert.ok(!ruleIds(analyze(parsePlaylist(two(',AUDIO="a"', ',AUDIO="a"')))).includes('master/inconsistent-groups'));
  });

  // ----------------------------------------------------------------- variables
  await test('the parser substitutes the variables the playlist defines', () => {
    const text =
      '#EXTM3U\n#EXT-X-VERSION:8\n#EXT-X-DEFINE:NAME="host",VALUE="cdn.example.com"\n#EXT-X-TARGETDURATION:6\n' +
      '#EXT-X-MAP:URI="https://{$host}/init.mp4"\n#EXTINF:6.000,\nhttps://{$host}/a.ts\n#EXT-X-ENDLIST\n';
    const pl = parsePlaylist(text);
    assert.strictEqual(pl.variables.get('host'), 'cdn.example.com');
    assert.strictEqual(pl.segments[0].uri, 'https://cdn.example.com/a.ts');
    assert.strictEqual(pl.maps[0].attrs.get('URI'), 'https://cdn.example.com/init.mp4');
    // Every reference is kept with its line, so a finding can point at the one that
    // is wrong rather than at the tag that should have defined it.
    assert.deepStrictEqual(
      pl.variableRefs.map((r) => r.name),
      ['host', 'host'],
    );
    assert.ok(pl.lines[pl.variableRefs[1].line].includes('{$host}'));
  });

  await test('a variable nothing defines is reported where it is used', () => {
    const undefinedVar =
      '#EXTM3U\n#EXT-X-VERSION:8\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.000,\nhttps://{$host}/a.ts\n#EXT-X-ENDLIST\n';
    const found = findingsOf(undefinedVar, 'syntax/undefined-variable');
    assert.strictEqual(found.length, 1);
    assert.ok(parsePlaylist(undefinedVar).lines[found[0].line].includes('{$host}'));
    // The URI keeps the braces: nothing was substituted, and that is what is requested.
    assert.strictEqual(parsePlaylist(undefinedVar).segments[0].uri, 'https://{$host}/a.ts');

    // IMPORT and QUERYPARAM define the name too, even though the value arrives later.
    for (const define of ['#EXT-X-DEFINE:IMPORT="host"', '#EXT-X-DEFINE:QUERYPARAM="host"']) {
      const declared =
        `#EXTM3U\n#EXT-X-VERSION:8\n${define}\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.000,\nhttps://{$host}/a.ts\n#EXT-X-ENDLIST\n`;
      assert.strictEqual(findingsOf(declared, 'syntax/undefined-variable').length, 0, define);
    }
  });

  await test('an EXT-X-DEFINE that defines nothing usable is reported', () => {
    const media = (define: string): string =>
      `#EXTM3U\n#EXT-X-VERSION:8\n${define}\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.000,\na.ts\n#EXT-X-ENDLIST\n`;

    // A NAME with no VALUE defines nothing; NAME+VALUE and IMPORT together are two
    // answers to the same question.
    assert.ok(ruleIds(analyze(parsePlaylist(media('#EXT-X-DEFINE:NAME="a"')))).includes('syntax/define-malformed'));
    assert.ok(ruleIds(analyze(parsePlaylist(media('#EXT-X-DEFINE:NAME="a",VALUE="1",IMPORT="a"')))).includes('syntax/define-malformed'));
    assert.ok(!ruleIds(analyze(parsePlaylist(media('#EXT-X-DEFINE:NAME="a",VALUE="1"')))).includes('syntax/define-malformed'));

    // The same name twice: which value applies is the player's guess.
    const twice = media('#EXT-X-DEFINE:NAME="a",VALUE="1"\n#EXT-X-DEFINE:NAME="a",VALUE="2"');
    assert.ok(ruleIds(analyze(parsePlaylist(twice))).includes('syntax/define-malformed'));

    // IMPORT takes the value from the master, so a master has nothing to import from.
    const master =
      '#EXTM3U\n#EXT-X-VERSION:8\n#EXT-X-DEFINE:IMPORT="host"\n' +
      '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360,CODECS="avc1.4d401e"\nv.m3u8\n';
    assert.ok(ruleIds(analyze(parsePlaylist(master))).includes('syntax/define-malformed'));
  });

  await test('session data carries exactly one value, under an id it does not share', () => {
    const master = (data: string): string =>
      `#EXTM3U\n#EXT-X-VERSION:7\n${data}\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360,CODECS="avc1.4d401e"\nv.m3u8\n`;

    assert.ok(ruleIds(analyze(parsePlaylist(master('#EXT-X-SESSION-DATA:DATA-ID="com.example.title"')))).includes('master/session-data'));
    assert.ok(
      ruleIds(analyze(parsePlaylist(master('#EXT-X-SESSION-DATA:DATA-ID="com.example.title",VALUE="a",URI="a.json"')))).includes('master/session-data'),
    );
    const duplicate =
      '#EXT-X-SESSION-DATA:DATA-ID="com.example.title",VALUE="a",LANGUAGE="en"\n' +
      '#EXT-X-SESSION-DATA:DATA-ID="com.example.title",VALUE="b",LANGUAGE="en"';
    assert.ok(ruleIds(analyze(parsePlaylist(master(duplicate)))).includes('master/session-data'));

    // The same id in two languages is the point of LANGUAGE, not a duplicate.
    const translated =
      '#EXT-X-SESSION-DATA:DATA-ID="com.example.title",VALUE="a",LANGUAGE="en"\n' +
      '#EXT-X-SESSION-DATA:DATA-ID="com.example.title",VALUE="b",LANGUAGE="it"';
    assert.ok(!ruleIds(analyze(parsePlaylist(master(translated)))).includes('master/session-data'));
  });

  await test('content steering points somewhere, once, at a pathway that exists', () => {
    const master = (steering: string, pathway = ''): string =>
      `#EXTM3U\n#EXT-X-VERSION:12\n${steering}\n` +
      `#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360,CODECS="avc1.4d401e"${pathway}\nv.m3u8\n`;

    assert.ok(ruleIds(analyze(parsePlaylist(master('#EXT-X-CONTENT-STEERING:PATHWAY-ID="cdn-a"')))).includes('master/content-steering'));
    const twice = '#EXT-X-CONTENT-STEERING:SERVER-URI="steer.json"\n#EXT-X-CONTENT-STEERING:SERVER-URI="other.json"';
    assert.ok(ruleIds(analyze(parsePlaylist(master(twice)))).includes('master/content-steering'));

    // A pathway no variant belongs to is a player steered nowhere.
    const orphan = master('#EXT-X-CONTENT-STEERING:SERVER-URI="steer.json",PATHWAY-ID="cdn-b"', ',PATHWAY-ID="cdn-a"');
    assert.ok(ruleIds(analyze(parsePlaylist(orphan))).includes('master/content-steering'));

    const fine = master('#EXT-X-CONTENT-STEERING:SERVER-URI="steer.json",PATHWAY-ID="cdn-a"', ',PATHWAY-ID="cdn-a"');
    assert.ok(!ruleIds(analyze(parsePlaylist(fine))).includes('master/content-steering'));
  });

  await test('EXT-X-START has to land inside the playlist', () => {
    const vod = (start: string): string =>
      `#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:6\n${start}\n#EXTINF:6.000,\na.ts\n#EXTINF:6.000,\nb.ts\n#EXT-X-ENDLIST\n`;
    assert.ok(ruleIds(analyze(parsePlaylist(vod('#EXT-X-START:TIME-OFFSET=30')))).includes('media/start-offset'));
    assert.ok(ruleIds(analyze(parsePlaylist(vod('#EXT-X-START:PRECISE=YES')))).includes('media/start-offset'));
    assert.ok(!ruleIds(analyze(parsePlaylist(vod('#EXT-X-START:TIME-OFFSET=5')))).includes('media/start-offset'));

    // A negative offset is measured from the live edge, and starting inside the three
    // target durations a player buffers means starting with nothing to play.
    const live = (start: string): string =>
      `#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:6\n${start}\n` +
      '#EXTINF:6.000,\na.ts\n#EXTINF:6.000,\nb.ts\n#EXTINF:6.000,\nc.ts\n#EXTINF:6.000,\nd.ts\n#EXTINF:6.000,\ne.ts\n';
    assert.ok(ruleIds(analyze(parsePlaylist(live('#EXT-X-START:TIME-OFFSET=-5')))).includes('media/start-offset'));
    assert.ok(!ruleIds(analyze(parsePlaylist(live('#EXT-X-START:TIME-OFFSET=-20')))).includes('media/start-offset'));
  });

  await test('a session key that disagrees with the renditions is reported', () => {
    const rendition = (method: string, uri: string): LoadedRendition => ({
      uri: 'v.m3u8',
      line: 2,
      bandwidth: 1000000,
      playlist: parsePlaylist(
        `#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=${method},URI="${uri}"\n#EXTINF:6.000,\na.ts\n#EXT-X-ENDLIST\n`,
      ),
    });
    const master = (sessionKey: string): Playlist =>
      parsePlaylist(`#EXTM3U\n${sessionKey}\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nv.m3u8\n`);

    const wrong = analyzeAcross([rendition('SAMPLE-AES', 'https://k/1')], {
      master: master('#EXT-X-SESSION-KEY:METHOD=AES-128,URI="https://k/1"'),
    });
    assert.ok(wrong.map((f) => f.rule).includes('cross/session-key-mismatch'), JSON.stringify(wrong.map((f) => f.rule)));

    const right = analyzeAcross([rendition('AES-128', 'https://k/1')], {
      master: master('#EXT-X-SESSION-KEY:METHOD=AES-128,URI="https://k/1"'),
    });
    assert.ok(!right.map((f) => f.rule).includes('cross/session-key-mismatch'));

    // No session key at all is not a disagreement: the tag is optional.
    const none = analyzeAcross([rendition('AES-128', 'https://k/1')], { master: master('#EXT-X-INDEPENDENT-SEGMENTS') });
    assert.ok(!none.map((f) => f.rule).includes('cross/session-key-mismatch'));
  });

  // ------------------------------------------------------------------- backlog
  const sampleBacklog = [
    '# Backlog',
    '',
    'Intro prose that is not a milestone.',
    '',
    '## v0.1 — Foundation',
    '',
    'What the first release shipped.',
    '',
    '- [x] **HL-0 — Reading manifests**: parser, rules, ladder.',
    '',
    '## v0.2 — Plumbing',
    '',
    '### Rules',
    '',
    '- [ ] **HL-1 — Codecs vs resolution**: a Main@3.0 rung claiming 1080p50.',
    '- [x] **HL-2 — Ladder spacing**: rungs too close together.',
    '',
    '### Editor',
    '',
    '- [ ] **HL-9 — Hover provider**',
    '- a bullet that is not a backlog item',
    '',
    '## Notes',
    '',
    'A section with no items is not a milestone.',
    '',
  ].join('\n');

  await test('parseBacklog reads milestones, ids, state, description and area', () => {
    const sections = parseBacklog(sampleBacklog);
    assert.deepStrictEqual(
      sections.map((s) => s.title),
      ['v0.1 — Foundation', 'v0.2 — Plumbing'],
      'only sections with items are milestones',
    );
    assert.strictEqual(sections[0].blurb, 'What the first release shipped.');
    assert.strictEqual(sections[0].items.length, 1);

    const [hl0] = sections[0].items;
    assert.strictEqual(hl0.id, 'HL-0');
    assert.strictEqual(hl0.title, 'Reading manifests');
    assert.strictEqual(hl0.desc, 'parser, rules, ladder.');
    assert.strictEqual(hl0.done, true);
    assert.strictEqual(hl0.milestone, 'v0.1 — Foundation');
    assert.strictEqual(hl0.area, undefined, 'no ### heading above it');

    const second = sections[1].items;
    assert.deepStrictEqual(
      second.map((i) => i.id),
      ['HL-1', 'HL-2', 'HL-9'],
      'a bullet without an id is not an item',
    );
    assert.deepStrictEqual(
      second.map((i) => i.area),
      ['Rules', 'Rules', 'Editor'],
    );
    assert.deepStrictEqual(
      second.map((i) => i.done),
      [false, true, false],
    );
    assert.strictEqual(second[2].title, 'Hover provider', 'a title with no description still parses');
    assert.strictEqual(second[2].desc, '');
  });

  await test('parseBacklog keeps the id prefix generic and tolerates a hyphen separator', () => {
    const md = ['## Milestone', '', '- [ ] **ABC-12 - Hyphen separator**: body.', ''].join('\n');
    const [section] = parseBacklog(md);
    assert.strictEqual(section.items[0].id, 'ABC-12');
    assert.strictEqual(section.items[0].title, 'Hyphen separator');
    assert.strictEqual(section.items[0].desc, 'body.');
  });

  await test('duplicateIds reports an id used twice', () => {
    const clean = parseBacklog(sampleBacklog);
    assert.deepStrictEqual(duplicateIds(clean), []);
    const dupe = parseBacklog(
      ['## M', '', '- [ ] **HL-1 — One**', '- [x] **HL-1 — Also one**', ''].join('\n'),
    );
    assert.deepStrictEqual(duplicateIds(dupe), ['HL-1']);
  });

  await test('sectionState and backlogStats count what is done', () => {
    const sections = parseBacklog(sampleBacklog);
    assert.strictEqual(sectionState(sections[0]), 'shipped');
    assert.strictEqual(sectionState(sections[1]), 'in progress');
    assert.strictEqual(
      sectionState(parseBacklog(['## M', '', '- [ ] **HL-3 — Nothing done yet**'].join('\n'))[0]),
      'planned',
    );
    assert.deepStrictEqual(backlogStats(sections), { total: 4, done: 2, open: 2, percent: 50 });
    assert.deepStrictEqual(backlogStats([]), { total: 0, done: 0, open: 0, percent: 0 });
  });

  await test('progressBar fills proportionally and never rounds an empty bar up', () => {
    assert.strictEqual(progressBar(0, 4, 4), '░░░░');
    assert.strictEqual(progressBar(2, 4, 4), '██░░');
    assert.strictEqual(progressBar(4, 4, 4), '████');
    assert.strictEqual(progressBar(1, 100, 4), '░░░░', 'a sliver is not a filled cell');
    assert.strictEqual(progressBar(0, 0, 4), '░░░░', 'an empty backlog does not divide by zero');
  });

  await test('renderRoadmap projects the backlog and stays byte-stable', () => {
    const out = renderRoadmap(parseBacklog(sampleBacklog));
    assert.ok(out.startsWith('<!-- Generated by `npm run roadmap`'), 'the file says it is generated');
    assert.ok(out.includes('## v0.1 — Foundation'), 'milestones become headings');
    assert.ok(out.includes('shipped') && out.includes('in progress'), 'each milestone shows its state');
    assert.ok(out.includes('HL-1'), 'items are listed by id');
    assert.ok(out.includes('Rules') && out.includes('Editor'), 'areas survive the projection');
    assert.ok(out.includes('2 of 4'), 'the header carries the overall progress');
    assert.ok(out.endsWith('\n'), 'ends with a newline, like every generated file here');
    // The CI gate regenerates this file and diffs it: a timestamp would make the
    // regeneration differ from the commit on every run.
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(out), 'no date stamp');
    assert.strictEqual(out, renderRoadmap(parseBacklog(sampleBacklog)), 'deterministic');
  });

  await test('the repository BACKLOG.md parses and has no duplicate ids', () => {
    const md = fs.readFileSync(path.join(__dirname, '..', 'BACKLOG.md'), 'utf8');
    const sections = parseBacklog(md);
    assert.ok(sections.length >= 2, 'the real backlog has milestones');
    assert.deepStrictEqual(duplicateIds(sections), [], 'ids are stable and unique');
    const items = sections.flatMap((s) => s.items);
    assert.ok(items.length >= 10);
    for (const item of items) {
      assert.ok(/^HL-\d+$/.test(item.id), `${item.id} follows the HL-n scheme`);
      assert.ok(item.title.length > 0, `${item.id} has a title`);
    }
    assert.strictEqual(items.find((i) => i.id === 'HL-0')?.done, true, 'v0.1 shipped');
  });

  await test('orphanMilestones reports the milestones a renamed section left behind', () => {
    const sections = parseBacklog(sampleBacklog);
    const onGitHub = [
      { title: 'v0.1 — Foundation', issues: 1 }, // a current section, holding its issue
      { title: 'v0.2 — Plumbing', issues: 0 }, // a current section with nothing in it yet
      { title: 'v0.1 — Old Name', issues: 0 }, // what a renamed section left behind
      { title: 'Roadmap 2027', issues: 0 }, // opened by hand, empty
      { title: 'Editor', issues: 3 }, // not in the file, but holds issues
    ];
    // Reported only when the backlog no longer names it AND it holds nothing: a
    // milestone with issues is somebody's working state, and this is a warning for a
    // human to act on, never an automatic delete.
    assert.deepStrictEqual(orphanMilestones(sections, onGitHub), ['v0.1 — Old Name', 'Roadmap 2027']);
    assert.deepStrictEqual(orphanMilestones(sections, []), []);
  });

  await test('the issue mapping anchors on the id, not on the title', () => {
    const [item] = parseBacklog(sampleBacklog)[1].items;
    assert.strictEqual(markerOf('HL-1'), '<!-- backlog:HL-1 -->');
    assert.strictEqual(idFromBody(`text\n${markerOf('HL-7')}\nmore`), 'HL-7');
    assert.strictEqual(idFromBody('an issue opened by hand'), undefined);
    assert.strictEqual(issueTitle(item), 'HL-1 — Codecs vs resolution');
    const body = issueBody(item);
    assert.strictEqual(idFromBody(body), 'HL-1', 'the body carries its own marker');
    assert.ok(body.includes(item.desc));
    assert.ok(body.includes('BACKLOG.md'), 'the body says where to edit it');
    assert.ok(body.includes('Rules'), 'the area is recorded');
    assert.strictEqual(issueBody(item), body, 'stable, so the sync does not patch on every run');
  });

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log('\nall tests passed');
}

void main();
