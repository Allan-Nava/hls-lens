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

## v0.4.0 — Rules that pay for themselves

Six findings a stream engineer would otherwise catch by reading the manifest twice, all computable
from the declarations alone.

- [x] **HL-1 — `master/codecs-resolution-mismatch`**: decodes the H.264 level out of the `avc1`/`avc3` string and compares it with the declared `RESOLUTION` and `FRAME-RATE` against the macroblock limits of ITU-T H.264 table A-1. Only avc1/avc3: for HEVC, AV1 or a string that does not parse the rule has no opinion rather than a guess. It found two real defects in this repository's own "clean" fixture — 720p50 on Main@3.1 and 1080p50 on High@4.0.
- [x] **HL-2 — `master/ladder-spacing`**: rungs under 1.5× apart (ABR cannot distinguish them, and the second encode is paid for twice) and gaps over 2.5× (nothing to fall back to). A hint: ladder shape is judgement, not a broken stream.
- [x] **HL-4 — `media/daterange`**: `EXT-X-DATERANGE` with no usable `START-DATE`, a `DURATION` that disagrees with `END-DATE`, two ranges of the same `CLASS` covering the same seconds, and an `SCTE35-IN`/`CUE-IN` with nothing open to close.
- [x] **HL-5 — `media/key-rotation` and `media/key-dropped`**: one live window covered by a single content key (a hint, and only on a playlist with a non-zero media sequence — the first window has nothing to rotate yet), and `METHOD=NONE` after encrypted segments, which leaves the rest of the playlist in the clear. Two behaviours, so two ids: they have different severities and a team pinning one should not lose the other.
- [x] **HL-6 — `media/iframe-playlist-shape`**: an `EXT-X-I-FRAMES-ONLY` playlist whose segments are whole files instead of `EXT-X-BYTERANGE` ranges, which makes a player download a segment per thumbnail. The other half of the original item — spotting a playlist that *should* declare `EXT-X-I-FRAMES-ONLY` — is not decidable from one file without guessing, so it is deliberately not implemented.

## v0.5.0 — Editor

The spec where the manifest is, instead of in a browser tab.

- [x] **HL-9 — Hover provider**: `src/core/spec.ts` holds every tag of the specification as data — scope, required version, summary, and the attributes with their enumerated values — and `renderTagHover` turns one into markdown. A test asserts that the vocabulary and the parser's set of known tags are the *same* set in both directions, so a tag can never be parsed without being documented or documented without being parsed.
- [x] **HL-10 — Completion provider**: `completeAt` reads the line up to the cursor and decides whether a tag name, an attribute name or an enumerated value belongs there. It filters tags by the kind of playlist (a media playlist is never offered `EXT-X-STREAM-INF`) and never offers an attribute already on the line.
- [x] **HL-11 — Quick fixes**: `quickFixesFor` covers `syntax/version-too-low`, `media/missing-endlist` and the two target-duration findings, as line edits the glue turns into a `WorkspaceEdit`. Only the mechanical ones: a fix that needs a judgement call is not offered.

## v0.6.0 — More than one file at a time

The first rules that need the master and its renditions at once.

- [x] **HL-7 — Cross-playlist rules**: `src/core/crosscheck.ts` with eight `cross/*` rules — same `EXT-X-VERSION`, same `EXT-X-TARGETDURATION`, same segment count, boundaries that land at the same time, discontinuities on the same segment, live windows that start together, and one rung that ended while the others are live. Findings anchor to the `EXT-X-STREAM-INF` line of the master, which is the file the operator has open. The command `HLS Lens: Check Renditions Together` loads the rungs from disk or from the CDN into their own diagnostic collection.
- [x] **HL-3 — `cross/bitrate-vs-declared`**: shipped with HL-7, as the id says — the comparison needs the master's `BANDWIDTH` and the rendition's own `EXT-X-BITRATE` in the same place, so it belongs in the cross category rather than in `media/*` as the original item guessed.

## v0.7.0 — Watching a stream move

- [x] **HL-13 — Live watch**: `src/core/watch.ts` diffs two reloads of the same playlist — new segments, what slid off the front, a discontinuity that appeared, an `EXT-X-ENDLIST` that arrived, and a window that did not move at all. Segments are matched by URI, not by index, because the index changes every time the window slides. `HLS Lens: Watch Live Playlist` polls on the manifest's own target duration (floored at 2s), reports in the output channel, warns after two stalled reloads and stops itself when the stream ends.
- [x] **HL-14 — Deep check on a selection**: right-click a rendition in the tree for `HLS Lens: Deep Check This Rendition`, which points segcheck at that rung's resolved URL instead of the whole master.

## v0.8.0 — DASH

- [x] **HL-8 — MPD parser and a `dash/*` rule category**: `src/core/xml.ts` (a narrow XML reader written here, so the extension still has no dependencies) and `src/core/dash.ts` with eleven rules — `@mediaPresentationDuration` against the segment timeline, `<S>` elements that do not chain, a dynamic manifest with no `<UTCTiming>`, an adaptation set with no `@segmentAlignment`, a `@media` template with no `$Number$`, and a `.mpd` that is really an error page a CDN returned. `.mpd` files get diagnostics like `.m3u8` files do. The name of the extension stays HLS-first; DASH manifests are read, not the headline.

## v0.9.0 — Documentation site

- [x] **HL-16 — Documentation site**: `src/core/markdown.ts` renders the subset of markdown these documents use (headings, lists, pipe tables, fenced code, inline spans, links) and wraps each one in a self-contained page — inline CSS, no script, no font to fetch, still no dependencies. `scripts/build-site.ts` turns `docs/` into `site/`, and `pages.yml` deploys it. **`site/` is not committed**: it is rebuilt from the markdown on every deploy, and two of those documents are themselves generated and gated in CI, so a page cannot describe a state the code is not in.

## Low latency

The LL-HLS tags are parsed and documented, and no rule reads a single one of them: a manifest can
declare partial segments no player will ever manage to use, and the extension says nothing. Every
item here is still computable from the declarations alone — what a part *contains* stays segcheck's
job.

- [ ] **HL-21 — `media/part-target`**: `EXT-X-PART` durations against the `PART-TARGET` of `EXT-X-PART-INF` (rounded, as with `EXTINF` and target duration), parts in a playlist that declares no `EXT-X-PART-INF`, and a `PART-TARGET` above the target duration. The parser counts parts today but does not keep them: they need to be kept with their attributes and their line, like every other tag.
- [ ] **HL-22 — `media/server-control`**: `PART-HOLD-BACK` under three `PART-TARGET`s and `HOLD-BACK` under three target durations — a player that starts closer to the edge than that stalls on its first reload — parts without `CAN-BLOCK-RELOAD=YES`, which leaves the latency unreachable because the player has to poll, and `CAN-SKIP-UNTIL` under six target durations.
- [ ] **HL-23 — `media/preload-hint`**: more than one hint of the same `TYPE`, a `TYPE=PART` hint in a playlist that has no parts, and a hint pointing at a part the playlist already lists. A hint for something that exists is a wasted request, not a preload.
- [ ] **HL-24 — `media/rendition-report`**: a `LAST-MSN` more than one segment away from this playlist's own last media sequence (the rungs are not keeping up with each other), a `LAST-PART` with no `LAST-MSN` to hang it on, and a low-latency playlist carrying no report at all — which makes a switching player fetch the other rendition's playlist first, the round trip low latency exists to avoid.

## More than one file at a time

Everything that needs the master and its variants together, or the same playlist over time.

- [ ] **HL-12 — Timeline webview**: segments as a strip with discontinuities, gaps and ad breaks marked, and the renditions stacked to show whether they are aligned.
