# Backlog

Single source of truth for the work on hls-lens. Every item has a stable id (`HL-n`) so a commit, a
branch or an issue can reference one; check items off, never delete them. Do not scatter TODO
comments in the code.

Every `##` heading is a **milestone** and every item is an **issue**: the [`backlog-sync`
workflow](.github/workflows/backlog-sync.yml) makes GitHub a mirror of this file, and
[`docs/ROADMAP.md`](docs/ROADMAP.md) is generated from it with `npm run roadmap`. Edit here, never
there — the sync overwrites the issue, and CI fails if the roadmap is stale.

Sections come in two kinds, because a GitHub issue can hold **one** milestone and that milestone has
to answer one question at a time:

- **Released** — named after the tag that shipped the work (`## v0.3.0 — Publishing automation`).
  Every item is checked, so the sync closes the milestone. A release that only moves documentation
  around does not open a section; the `CHANGELOG.md` is where every tag is accounted for.
- **Planned** — named after the theme (`## Editor`). An item lives here until it ships, then it moves
  into the section of the release that shipped it. Moving an item retitles nothing and reopens
  nothing: the issue is anchored to its `HL-n` id and only changes milestone.

Format, exactly: `- [ ] **HL-7 — Title**: description.` A `###` heading inside a section groups items
by area and is carried through to the roadmap and the issue body.

## v0.1.0 — Reading manifests

Reading a manifest in the editor at all: the pure core, the diagnostics, the tree.

- [x] **HL-0 — Reading HLS manifests in VS Code**: pure core (parser with line indexes, 33 rules, ladder model, URI resolution, segcheck bridge, fetcher), diagnostics, manifest tree, document links, URL fetching, deep check, generated rule reference, generated icon, full local test suite.

## v0.2.0 — Backlog and roadmap automation

The plan maintaining itself: one file, two generated projections.

- [x] **HL-17 — Backlog and roadmap automation**: `BACKLOG.md` parsed in the pure core (`src/core/backlog.ts`), `docs/ROADMAP.md` generated from it (`npm run roadmap`, no-op gate in CI), and the `backlog-sync` workflow making GitHub milestones and issues an idempotent mirror of the file, anchored on the `HL-n` ids.

## v0.3.0 — Publishing automation

A pushed `v*` tag as the whole release process, stores included.

- [x] **HL-15 — Publish on tag**: `publish` job in `ci.yml` that on a `v*` tag uploads to the VS Code Marketplace (`vsce publish`) and to Open VSX (`ovsx publish`), publishing the exact `.vsix` the `release` job attached rather than repackaging it. Both publishers are pinned in the lockfile, the PATs live in the `marketplace` environment, and a missing PAT warns and skips instead of failing a tag that released correctly. Setting up `VSCE_PAT`/`OVSX_PAT` is an account action, not a repository one.

## v0.3.2 — Reproducible gates

The first push turned the CI red on every run and left leftovers on the issue tracker: both
were gates that assumed something the environment does not guarantee.

- [x] **HL-18 — Icon gate compares pixels, not bytes**: `npm run icon:check` decodes the committed PNG and compares it with the generator's pixels, replacing the regenerate-and-diff step that failed on every CI run. DEFLATE output is not fixed by the PNG format, so the runner's zlib re-encodes the same image into different bytes and the byte diff reported a stale icon on a machine where nothing had changed.
- [x] **HL-19 — Report milestones a rename left behind**: `orphanMilestones` in the core, wired into the sync, names the milestones that are empty and no longer in this file (five of them after the section restructure). It reports and never deletes, and it counts issues with the issues endpoint because GitHub does not recompute a milestone's own counters when an issue moves away from it.

## v0.3.3 — Icon generator under test

- [x] **HL-20 — The icon generator moves into the tested core**: `src/core/png.ts` holds `drawIcon`, `encodePng`/`decodePng` and `comparePixels`, with tests that assert the mark's own pixels, the encode/decode round-trip, the rejection of a file the generator did not write, and that two compression levels of the same image compare equal. `scripts/make-icon.ts` is now I/O only, bundled like the other tools. Written test-first: the truncated-PNG test failed on a Buffer `RangeError` and produced a real fix, a chunk-length guard.

## Docs and site

- [ ] **HL-16 — Documentation site**: GitHub Pages from `docs/`, with the generated rule reference as its reference section and the roadmap as its plan (the sibling lenses already do this).

## Rules that pay for themselves

Findings a stream engineer would otherwise catch by reading the manifest twice — all of them still
computable from the declarations alone.

### Master playlist

- [ ] **HL-1 — `master/codecs-resolution-mismatch`**: report a `CODECS` profile/level that cannot carry the declared `RESOLUTION` and `FRAME-RATE` (an `avc1.4d401e` Main@3.0 rung claiming 1080p50).
- [ ] **HL-2 — `master/ladder-spacing`**: report rungs less than ~1.5× apart in bitrate (ABR cannot use a rung it cannot distinguish) and gaps wider than ~2.5× (nothing to fall back to).

### Media playlist

- [ ] **HL-3 — `media/bitrate-vs-declared`**: compare `EXT-X-BITRATE` tags, where a packager emits them, with the variant's `BANDWIDTH`.
- [ ] **HL-4 — `media/daterange`**: validate `EXT-X-DATERANGE` (SCTE-35 ad breaks): overlapping ranges, `DURATION` disagreeing with `END-DATE`, a `CUE-IN` with no `CUE-OUT`.
- [ ] **HL-5 — `media/key-rotation`**: report an `EXT-X-KEY` that never rotates across a long live window, and a `METHOD=NONE` after encrypted segments.
- [ ] **HL-6 — `media/iframe-playlist-shape`**: an I-frame playlist without `EXT-X-I-FRAMES-ONLY`, or with segments that are not byte ranges.

## Editor

The spec where the manifest is, instead of in a browser tab.

- [ ] **HL-9 — Hover provider**: hovering a tag shows what it means, its required version and the attributes it accepts.
- [ ] **HL-10 — Completion provider**: tag and attribute names, with the enumerated values (`YES`/`NO`, `VOD`/`EVENT`, `TYPE=`…).
- [ ] **HL-11 — Quick fixes for the mechanical findings**: bump `EXT-X-VERSION` to what the playlist needs, append a missing `EXT-X-ENDLIST`, raise `EXT-X-TARGETDURATION` to the longest segment.

## More than one file at a time

Everything that needs the master and its variants together, or the same playlist over time.

- [ ] **HL-7 — Cross-playlist rules**: with the master and its variants loaded, check that renditions share a timeline (same segment count and boundaries), that every variant declares the same `EXT-X-VERSION`, and that discontinuities line up. The first rule set that needs more than one file open.
- [ ] **HL-12 — Timeline webview**: segments as a strip with discontinuities, gaps and ad breaks marked, and the renditions stacked to show whether they are aligned.
- [ ] **HL-13 — Live watch**: reload a live playlist on its target duration and report what changed (new segments, a window that stopped sliding, a discontinuity that appeared).
- [ ] **HL-14 — Deep check on a selection**: run segcheck against a single variant picked in the tree rather than the whole master.

## Later — DASH

- [ ] **HL-8 — MPD parser and a `dash/*` rule category**: `@mediaPresentationDuration` vs the segment timeline, `SegmentTemplate` numbering gaps, `@availabilityStartTime` with no `UTCTiming`, `AdaptationSet` without `@segmentAlignment`. The name of the extension stays HLS-first; DASH manifests are read, not the headline.
