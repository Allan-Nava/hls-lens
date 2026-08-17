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
import { parsePlaylist, looksLikePlaylist } from '../src/core/playlist';
import { analyze, RULES, Finding, Severity } from '../src/core/analyze';
import { buildLadder, renditionRows, ladderSummary, formatBandwidth, formatResolution } from '../src/core/ladder';
import { resolveUri, baseOf, isRemote, isPlainHttp, looksLikePlaylistUri } from '../src/core/uri';
import { buildSegcheckArgs, parseSegcheckResult, segcheckToFindings, segcheckSummary } from '../src/core/segcheck';
import { fetchText } from '../src/core/fetch';
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
    assert.deepStrictEqual(v!.codecs, ['avc1.640028', 'mp4a.40.2']);
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
      assert.match(r.id, /^(syntax|master|media)\/[a-z0-9-]+$/, `${r.id} is not a namespaced kebab-case id`);
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
    assert.ok(video[3].tooltip.includes('avc1.640028'));
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
