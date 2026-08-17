# Backlog

Single source of truth for the work on hls-lens. Items have a stable id (`HL-n`) so a commit or a branch can reference one. Do not scatter TODO comments in the code.

## Open

### Rules

- **HL-1** — `master/codecs-resolution-mismatch`: report a `CODECS` profile/level that cannot carry the declared `RESOLUTION` and `FRAME-RATE` (an `avc1.4d401e` Main@3.0 rung claiming 1080p50).
- **HL-2** — `master/ladder-spacing`: report rungs less than ~1.5× apart in bitrate (ABR cannot use a rung it cannot distinguish) and gaps wider than ~2.5× (nothing to fall back to).
- **HL-3** — `media/bitrate-vs-declared`: compare `EXT-X-BITRATE` tags, where a packager emits them, with the variant's `BANDWIDTH`.
- **HL-4** — `media/daterange`: validate `EXT-X-DATERANGE` (SCTE-35 ad breaks): overlapping ranges, `DURATION` disagreeing with `END-DATE`, a `CUE-IN` with no `CUE-OUT`.
- **HL-5** — `media/key-rotation`: report an `EXT-X-KEY` that never rotates across a long live window, and a `METHOD=NONE` after encrypted segments.
- **HL-6** — `media/iframe-playlist-shape`: an I-frame playlist without `EXT-X-I-FRAMES-ONLY`, or with segments that are not byte ranges.
- **HL-7** — Cross-playlist rules: with the master and its variants loaded, check that renditions share a timeline (same segment count and boundaries), that every variant declares the same `EXT-X-VERSION`, and that discontinuities line up. This is the first rule set that needs more than one file open.

### DASH

- **HL-8** — MPD parser and a `dash/*` rule category: `@mediaPresentationDuration` vs the segment timeline, `SegmentTemplate` numbering gaps, `@availabilityStartTime` with no `UTCTiming`, `AdaptationSet` without `@segmentAlignment`. The name of the extension stays HLS-first; DASH manifests are read, not the headline.

### Editor features

- **HL-9** — Hover provider: hovering a tag shows what it means, its required version and the attributes it accepts — the spec, in the editor, without a browser tab.
- **HL-10** — Completion provider for tag and attribute names, with the enumerated values (`YES`/`NO`, `VOD`/`EVENT`, `TYPE=`…).
- **HL-11** — Quick fixes for the mechanical findings: bump `EXT-X-VERSION` to what the playlist needs, append a missing `EXT-X-ENDLIST`, raise `EXT-X-TARGETDURATION` to the longest segment.
- **HL-12** — Timeline webview: segments as a strip with discontinuities, gaps and ad breaks marked, and the renditions stacked to show whether they are aligned.
- **HL-13** — Live watch: reload a live playlist on its target duration and report what changed (new segments, a window that stopped sliding, a discontinuity that appeared).
- **HL-14** — Deep check on a selection: run segcheck against a single variant picked in the tree rather than the whole master.

### Plumbing

- **HL-15** — CI: package the `.vsix` on a `v*` tag and attach it to the release; publish to the Marketplace with `vsce publish` once a PAT is in the repository secrets.
- **HL-16** — Documentation site on GitHub Pages from `docs/`, with the generated rule reference as its reference section (the sibling repos already do this).
- **HL-17** — Mirror the backlog automation of keycloak-doctor here (`BACKLOG.md` → milestones and issues), so this file stays the only place work is tracked.

## Done

- **HL-0** — v0.1.0: pure core (parser with line indexes, 33 rules, ladder model, URI resolution, segcheck bridge, fetcher), diagnostics, manifest tree, document links, URL fetching, deep check, generated rule reference, generated icon, full local test suite.
