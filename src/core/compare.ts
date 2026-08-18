// Two manifests, side by side.
//
// The daily question this answers is "the packager changed something — what?".
// Every rule in this extension judges one manifest, or one manifest against its own
// renditions; none of them can see that the 720p rung was re-rated overnight, or that
// the audio group is gone. A diff of the text says the same thing in a form nobody
// can read: a manifest is a set of declarations, not a sequence of lines, and the
// interesting change is which declaration moved.
import { formatBandwidth } from './ladder';
import { parseIsoDuration } from './dash';
import { Playlist, Variant } from './playlist';
import { XmlNode, attr, findAll, parseXml } from './xml';

/** One difference between two manifests. */
export interface ManifestChange {
  kind:
    | 'kind'
    | 'mpd-type'
    | 'duration'
    | 'period-added'
    | 'period-removed'
    | 'adaptation-set-added'
    | 'adaptation-set-removed'
    | 'representation-added'
    | 'representation-removed'
    | 'representation-changed'
    | 'rung-added'
    | 'rung-removed'
    | 'rung-changed'
    | 'group-added'
    | 'group-removed'
    | 'version'
    | 'target-duration'
    | 'segments'
    | 'endlist';
  /** What changed: a rung's URI, a group's name, the field's name. */
  label: string;
  detail: string;
  /** 0-based line in the manifest being compared *to*, or -1 when it is not there. */
  line: number;
}

/**
 * compareManifests reports what the second manifest declares that the first did not.
 *
 * Rungs are matched by URI: a packager keeps the path of a rendition stable far more
 * often than it keeps its bitrate, so the URI is what answers "is this the same rung,
 * re-rated?" rather than "is this a new rung?".
 */
export function compareManifests(before: Playlist, after: Playlist): ManifestChange[] {
  if (before.kind !== after.kind) {
    return [
      {
        kind: 'kind',
        label: 'playlist kind',
        detail: `${before.kind} → ${after.kind}`,
        line: 0,
      },
    ];
  }
  // Two files that are not playlists have nothing in common that this function can
  // read, and every branch below would skip them — which returns an empty list, and
  // an empty list means "identical". Saying nothing here would be saying the wrong
  // thing. (An .mpd lands exactly here: compareMpds is what reads those.)
  if (before.kind === 'unknown') {
    return [
      {
        kind: 'kind',
        label: 'not a playlist',
        detail: 'neither file parses as an HLS playlist, so they cannot be compared this way',
        line: 0,
      },
    ];
  }

  const changes: ManifestChange[] = [];
  if (before.kind === 'master' || before.kind === 'mixed') {
    compareLadders(before, after, changes);
    compareGroups(before, after, changes);
  }
  if (before.kind === 'media' || before.kind === 'mixed') {
    compareMedia(before, after, changes);
  }
  if ((before.version ?? 1) !== (after.version ?? 1)) {
    changes.push({
      kind: 'version',
      label: 'EXT-X-VERSION',
      detail: `${before.version ?? 1} → ${after.version ?? 1}`,
      line: after.versionLine ?? -1,
    });
  }
  return changes;
}

/** describeComparison writes the changes as lines for an output channel. */
export function describeComparison(changes: ManifestChange[]): string[] {
  if (changes.length === 0) return ['the two manifests declare the same thing'];
  return changes.map((change) => `${marker(change.kind)} ${change.label}: ${change.detail}`);
}

function compareLadders(before: Playlist, after: Playlist, changes: ManifestChange[]): void {
  const beforeByUri = new Map(before.variants.map((v) => [v.uri, v]));
  const afterByUri = new Map(after.variants.map((v) => [v.uri, v]));

  for (const variant of before.variants) {
    if (afterByUri.has(variant.uri)) continue;
    changes.push({
      kind: 'rung-removed',
      label: variant.uri || `line ${variant.line + 1}`,
      detail: describeRung(variant),
      line: -1,
    });
  }
  for (const variant of after.variants) {
    const was = beforeByUri.get(variant.uri);
    if (!was) {
      changes.push({ kind: 'rung-added', label: variant.uri || `line ${variant.line + 1}`, detail: describeRung(variant), line: variant.line });
      continue;
    }
    const differences = [
      was.bandwidth !== variant.bandwidth ? `${formatBandwidth(was.bandwidth)} → ${formatBandwidth(variant.bandwidth)}` : '',
      resolutionOf(was) !== resolutionOf(variant) ? `${resolutionOf(was)} → ${resolutionOf(variant)}` : '',
      was.codecs.join(',') !== variant.codecs.join(',') ? `${was.codecs.join(',') || '—'} → ${variant.codecs.join(',') || '—'}` : '',
      was.frameRate !== variant.frameRate ? `${was.frameRate ?? '—'} → ${variant.frameRate ?? '—'} fps` : '',
    ].filter(Boolean);
    if (differences.length > 0) {
      changes.push({ kind: 'rung-changed', label: variant.uri, detail: differences.join(' · '), line: variant.line });
    }
  }
}

function compareGroups(before: Playlist, after: Playlist, changes: ManifestChange[]): void {
  const key = (type: string, groupId: string): string => `${type} "${groupId}"`;
  const beforeGroups = new Map(before.renditions.map((r) => [key(r.type, r.groupId), r]));
  const afterGroups = new Map(after.renditions.map((r) => [key(r.type, r.groupId), r]));

  for (const [name] of beforeGroups) {
    if (!afterGroups.has(name)) changes.push({ kind: 'group-removed', label: name, detail: 'no rendition declares it any more', line: -1 });
  }
  for (const [name, rendition] of afterGroups) {
    if (!beforeGroups.has(name)) changes.push({ kind: 'group-added', label: name, detail: rendition.name || 'new group', line: rendition.line });
  }
}

function compareMedia(before: Playlist, after: Playlist, changes: ManifestChange[]): void {
  if (before.targetDuration !== after.targetDuration) {
    changes.push({
      kind: 'target-duration',
      label: 'EXT-X-TARGETDURATION',
      detail: `${before.targetDuration ?? '—'} → ${after.targetDuration ?? '—'}`,
      line: after.targetDurationLine ?? -1,
    });
  }
  if (before.segments.length !== after.segments.length || before.totalDuration !== after.totalDuration) {
    changes.push({
      kind: 'segments',
      label: 'segments',
      detail: `${before.segments.length} (${before.totalDuration}s) → ${after.segments.length} (${after.totalDuration}s)`,
      line: -1,
    });
  }
  if (before.hasEndList !== after.hasEndList) {
    changes.push({
      kind: 'endlist',
      label: 'EXT-X-ENDLIST',
      detail: after.hasEndList ? 'the stream ended' : 'the stream is live again',
      line: -1,
    });
  }
}

function describeRung(variant: Variant): string {
  return [formatBandwidth(variant.bandwidth), resolutionOf(variant), variant.codecs.join(',')].filter(Boolean).join(' · ');
}

function resolutionOf(variant: Variant): string {
  return variant.resolution ? `${variant.resolution.width}x${variant.resolution.height}` : '—';
}

function marker(kind: ManifestChange['kind']): string {
  if (kind.endsWith('added')) return '+';
  if (kind.endsWith('removed')) return '-';
  return '~';
}

/**
 * compareMpds is the same question asked of two DASH manifests: periods matched by
 * @id (falling back to their order), adaptation sets by what they carry, and
 * representations by @id — which is the DASH equivalent of matching HLS rungs by URI,
 * and stable for the same reason.
 */
export function compareMpds(before: string, after: string): ManifestChange[] {
  const a = parseXml(before).root;
  const b = parseXml(after).root;
  if (!a || !b || !/(^|:)MPD$/.test(a.name) || !/(^|:)MPD$/.test(b.name)) {
    return [{ kind: 'kind', label: 'not an MPD', detail: 'one of the two files does not parse as a DASH manifest', line: 0 }];
  }

  const changes: ManifestChange[] = [];
  const typeOf = (root: XmlNode): string => attr(root, 'type') ?? 'static';
  if (typeOf(a) !== typeOf(b)) {
    changes.push({ kind: 'mpd-type', label: '@type', detail: `${typeOf(a)} → ${typeOf(b)}`, line: b.line });
  }
  const durationA = parseIsoDuration(attr(a, 'mediaPresentationDuration'));
  const durationB = parseIsoDuration(attr(b, 'mediaPresentationDuration'));
  if (durationA !== durationB) {
    changes.push({
      kind: 'duration',
      label: '@mediaPresentationDuration',
      detail: `${durationA === null ? 'none' : `${durationA}s`} → ${durationB === null ? 'none' : `${durationB}s`}`,
      line: b.line,
    });
  }

  const periodsA = findAll(a, 'Period');
  const periodsB = findAll(b, 'Period');
  const keyOf = (period: XmlNode, index: number): string => attr(period, 'id') ?? `#${index + 1}`;
  const beforePeriods = new Map(periodsA.map((p, i) => [keyOf(p, i), p]));
  const afterPeriods = new Map(periodsB.map((p, i) => [keyOf(p, i), p]));

  for (const [key] of beforePeriods) {
    if (!afterPeriods.has(key)) changes.push({ kind: 'period-removed', label: `Period ${key}`, detail: 'gone', line: -1 });
  }
  for (const [key, period] of afterPeriods) {
    const was = beforePeriods.get(key);
    if (!was) {
      changes.push({ kind: 'period-added', label: `Period ${key}`, detail: `${findAll(period, 'Representation').length} representations`, line: period.line });
      continue;
    }
    comparePeriod(was, period, key, changes);
  }
  return changes;
}

function comparePeriod(before: XmlNode, after: XmlNode, periodKey: string, changes: ManifestChange[]): void {
  const setKey = (set: XmlNode, index: number): string =>
    attr(set, 'contentType') ?? attr(set, 'mimeType') ?? attr(set, 'id') ?? `#${index + 1}`;
  const beforeSets = new Map(findAll(before, 'AdaptationSet').map((set, i) => [setKey(set, i), set]));
  const afterSets = new Map(findAll(after, 'AdaptationSet').map((set, i) => [setKey(set, i), set]));

  for (const [key] of beforeSets) {
    if (!afterSets.has(key)) {
      changes.push({ kind: 'adaptation-set-removed', label: `${periodKey} · ${key}`, detail: 'the whole track is gone', line: -1 });
    }
  }
  for (const [key, set] of afterSets) {
    const was = beforeSets.get(key);
    if (!was) {
      changes.push({ kind: 'adaptation-set-added', label: `${periodKey} · ${key}`, detail: 'a new track', line: set.line });
      continue;
    }
    compareRepresentations(was, set, changes);
  }
}

function compareRepresentations(before: XmlNode, after: XmlNode, changes: ManifestChange[]): void {
  const repKey = (rep: XmlNode, index: number): string => attr(rep, 'id') ?? `#${index + 1}`;
  const beforeReps = new Map(findAll(before, 'Representation').map((rep, i) => [repKey(rep, i), rep]));
  const afterReps = new Map(findAll(after, 'Representation').map((rep, i) => [repKey(rep, i), rep]));

  for (const [key, rep] of beforeReps) {
    if (!afterReps.has(key)) {
      changes.push({ kind: 'representation-removed', label: key, detail: describeRepresentation(rep), line: -1 });
    }
  }
  for (const [key, rep] of afterReps) {
    const was = beforeReps.get(key);
    if (!was) {
      changes.push({ kind: 'representation-added', label: key, detail: describeRepresentation(rep), line: rep.line });
      continue;
    }
    const differences = [
      bandwidthOf(was) !== bandwidthOf(rep) ? `${formatBandwidth(bandwidthOf(was))} → ${formatBandwidth(bandwidthOf(rep))}` : '',
      sizeOf(was) !== sizeOf(rep) ? `${sizeOf(was)} → ${sizeOf(rep)}` : '',
      (attr(was, 'codecs') ?? '') !== (attr(rep, 'codecs') ?? '') ? `${attr(was, 'codecs') ?? '—'} → ${attr(rep, 'codecs') ?? '—'}` : '',
    ].filter(Boolean);
    if (differences.length > 0) {
      changes.push({ kind: 'representation-changed', label: key, detail: differences.join(' · '), line: rep.line });
    }
  }
}

function describeRepresentation(rep: XmlNode): string {
  return [formatBandwidth(bandwidthOf(rep)), sizeOf(rep), attr(rep, 'codecs') ?? ''].filter((part) => part && part !== '—').join(' · ');
}

function bandwidthOf(rep: XmlNode): number | null {
  const value = Number.parseInt(attr(rep, 'bandwidth') ?? '', 10);
  return Number.isFinite(value) ? value : null;
}

function sizeOf(rep: XmlNode): string {
  const width = attr(rep, 'width');
  const height = attr(rep, 'height');
  return width && height ? `${width}x${height}` : '—';
}
