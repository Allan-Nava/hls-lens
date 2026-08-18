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

## v0.10.0 — Low latency

Nine rules on the half of the vocabulary nothing was reading. 58 → 67.

- [x] **HL-21 — `media/part-without-part-inf`, `media/part-exceeds-part-target`, `media/part-target-too-large`**: the parser now keeps the parts (`Playlist.parts`, with attributes and line) instead of counting them, and three rules read them — parts with no `EXT-X-PART-INF` to size them, a part longer than the `PART-TARGET` the playlist declares, and a `PART-TARGET` at or above `TARGETDURATION`, which is a part as long as a segment. Three ids rather than the one this item named: they have three severities, and a team that pins one should not lose the others.
- [x] **HL-22 — `media/can-skip-until-too-small`**: the only part of this item that was not already shipped. `media/part-without-server-control` and `media/holdback-too-small` have covered both hold-back floors and the missing `CAN-BLOCK-RELOAD=YES` since `v0.1.0` — the item claimed otherwise and was wrong. What was left is the `CAN-SKIP-UNTIL` floor of six target durations: a boundary below it is one no conforming client is allowed to ask for, so the playlist deltas are never requested.
- [x] **HL-23 — `media/preload-hint` and `media/preload-hint-not-preloading`**: a hint with no `TYPE` or `URI` and a second hint of the same type are spec violations (error); a hint for a part the playlist already publishes, or a `TYPE=PART` hint where there are no parts, buys nothing (warning). Split for the same reason as HL-21.
- [x] **HL-24 — `media/rendition-report`, `media/rendition-report-out-of-step`, `media/rendition-report-missing`**: a report with no `URI` or no `LAST-MSN` is not enough to switch on; a report more than one segment from this playlist's own last media sequence means the rungs are not being published in step; a low-latency playlist with no report at all makes a switching player fetch the other playlist first — the round trip low latency exists to remove.

## v0.11.0 — Timeline

The picture the rules could not draw.

- [x] **HL-12 — Timeline webview**: `src/core/timeline.ts` lays the segments of one or more playlists on a shared axis — `buildTimeline`, `niceTicks` and `renderTimelineHtml`, which renders the **whole page** as a string, so a webview gets tests instead of a screenshot. Discontinuities, `EXT-X-GAP` segments and the ad breaks an `EXT-X-DATERANGE` declares are marked, the rungs are stacked, and a boundary not every rung shares is drawn as a dashed rule across all of them. Only the rung that drifts is called out of step — with one rung out of five it is that rung that is wrong, not the four that agree. Clicking a segment reveals its line. `HLS Lens: Show Timeline` draws a media playlist; on a master it reads the rungs first.

## v0.12.0 — The rest of the vocabulary

Six rules on the four tags nothing was reading, and the variable substitution the
parser was missing. 67 → 73.

- [x] **HL-25 — `syntax/define-malformed` and `syntax/undefined-variable`**: the parser now **substitutes** the variables (`Playlist.variables`, `defines`, `variableRefs`), so the rules, the tree and the document links all see the URI that will be requested. A `{$name}` nothing declares is left written as it is — braces included, which is exactly what a player asks for — and reported on the line that uses it. On the declaration side: a `NAME` with no `VALUE`, two sources for one value, the same name twice, and `IMPORT` in a master, which has nothing to import from.
- [x] **HL-26 — `master/session-data` and `cross/session-key-mismatch`**: session data with neither `VALUE` nor `URI` (no datum) or with both (two answers), and two entries sharing `DATA-ID` and `LANGUAGE`. The session key half turned out to belong in `crosscheck.ts` and not in `master/*`: `EXT-X-SESSION-KEY` is in the master and the `EXT-X-KEY` it promises is in the renditions, so the comparison needs both files. `analyzeAcross` takes an optional `master` for it.
- [x] **HL-27 — `master/content-steering` and `media/start-offset`**: steering with no `SERVER-URI`, a second steering tag, and a `PATHWAY-ID` no variant belongs to. `EXT-X-START` with no `TIME-OFFSET`, an offset outside the playlist (where players fall back to their own default, so the tag does nothing), and a negative offset inside the three target durations a player buffers before it starts.

## v0.13.0 — Rendition groups

Eight rules on `EXT-X-MEDIA`, the one part of a master a player resolves entirely by
name — and where nothing fails loudly when a name is wrong. 73 → 81.

- [x] **HL-28 — The rendition on its own**: `master/rendition-missing-attributes` (no `TYPE`, `GROUP-ID` or `NAME`, or a `TYPE` the spec does not define), `master/rendition-uri` (subtitles with no `URI`, and its mirror: closed captions with a `URI`, which the spec forbids, or with no `INSTREAM-ID`) and `master/rendition-forced` (`FORCED=YES` on anything that is not subtitles).
- [x] **HL-29 — The group as a whole**: `master/rendition-default-not-autoselect` (`DEFAULT=YES` with `AUTOSELECT=NO` — play this unless told otherwise, and never pick it automatically), `master/rendition-duplicate-name` (two identical entries in a player's track picker) and `master/audio-group-mixed-channels` (a group that mixes stereo and 5.1, so changing language changes the mix).
- [x] **HL-30 — The groups against the variants**: `master/unused-group`, the mirror of `master/undefined-group` — a group no variant names is encoded, published and cached and no player can reach it — and `master/inconsistent-groups`, variants that do not all reference the same groups, which makes having the alternate audio a function of the viewer's connection at that moment.

## v0.14.0 — The whole workspace

The manifest with the defect is the one nobody thought to open.

- [x] **HL-31 — Check every manifest in the workspace**: `HLS Lens: Check All Manifests in Workspace` reads every `.m3u8`, `.m3u` and `.mpd` the workspace holds — excluded by `hlsLens.workspace.exclude`, cancellable, capped at 2000 files with the cap **stated** when it is hit — and puts the findings in their own diagnostic collection, so the Problems panel lists files that were never loaded. `src/core/workspace.ts` holds the part that is logic: what counts as a manifest, the ranking (errors, then warnings, then hints, then path, so two scans of the same tree are diffable) and the report. Opening a manifest drops the scan's copy of its findings: the live diagnostics are authoritative and the two collections would otherwise double every entry.

## v0.15.0 — DASH gets a shape

The rules have read MPDs since v0.8.0. The tree never did.

- [x] **HL-32 — The MPD as a tree**: `src/core/mpdtree.ts` with `buildMpdTree` (periods → adaptation sets → representations, each with its own line index) and `mpdSummary` for the status bar. An open `.mpd` now shows its shape in the HLS view, with the Problems at the bottom as a playlist has, and clicking a row reveals its line. The DASH ladder *is* in the file — nested four elements deep and spread across attributes, which is exactly the reading this extension exists to do for you.

## v0.16.0 — Grading and fixing

Rule ids are the API a team pins, and "off" was the only thing it could say.

- [x] **HL-33 — Re-grade a rule instead of switching it off**: `applySeverityOverrides` and the `hlsLens.diagnostics.severity` setting take a rule id or a whole category and give it another severity, or `off`. The more specific setting wins, the findings are re-sorted afterwards (a rule promoted to error and left at the bottom of the panel would be worse than not promoting it), and a value that is not a severity is **left alone** — that is a typo in a settings file, and both dropping the rule and guessing at the intent would hide it.
- [x] **HL-34 — Three more quick fixes**: a misspelled tag offered the tag it was meant to be (Levenshtein against the parser's own vocabulary, never further than two edits — beyond that it is a vendor extension, not a typo), `AUTOSELECT=NO` on a default rendition set to `YES`, and a stray `FORCED` removed without leaving its comma behind.

## v0.17.0 — Sending it to someone

The Problems panel is where a defect is fixed, not where it is argued about with the
team that produced the manifest.

- [x] **HL-35 — Export the findings as a report**: `src/core/report.ts` renders the findings as markdown for a ticket or as JSON for whatever reads it next, from the open manifest or from the last workspace scan. The JSON carries a `schema` number, because anything parsing it is code somebody else wrote and needs something to pin. **Lines are 1-based in the export**: 0-based is an editor's convention, and a report is read by people and by CI, which both count from 1. Pipes in a message are escaped — a URI with one in it would otherwise end the table column early and shift every cell after it.
- [x] **HL-36 — The low-latency vocabulary in the tree**: eleven rules read `EXT-X-PART`, `EXT-X-PRELOAD-HINT` and `EXT-X-RENDITION-REPORT`, and the tree showed none of them. `lowLatencyRows` adds a section with the server control (whether the parts buy any latency at all), the parts with their duration and their `INDEPENDENT`/`GAP` marks, the hint a player blocks on and the reports it switches rungs by. Capped at 50 parts — a live window holds hundreds — and the cap is **stated** in a row of its own.

## v0.18.0 — Against another manifest

"The packager changed something — what?" is a daily question no rule can answer,
because every rule judges one manifest.

- [x] **HL-37 — Compare with another manifest**: `src/core/compare.ts` reports what the open manifest declares that another one did not — rungs added, removed or re-rated, rendition groups that came and went, and for a media playlist the version, the target duration, the segment count and an `EXT-X-ENDLIST` that arrived. **Rungs are matched by URI**: a packager keeps the path of a rendition stable far more often than its bitrate, so the URI is what tells "the same rung, re-rated" apart from "a new rung". A text diff answers the same question in a form nobody can read — a manifest is a set of declarations, and the interesting change is which declaration moved, not which line did.
- [x] **HL-38 — House styles as a starting grade**: `hlsLens.diagnostics.profile` with `apple` (the HLS Authoring Specification: an I-frame playlist and a RESOLUTION stop being advisory) and `low-latency` (a stream sold as such owes the reports and the hold-backs). The catalogue has one opinion per rule and cannot have the right one for everybody — an I-frame playlist is advisory in RFC 8216 and required by Apple, and which you are held to depends on where the stream is going. A profile is a **starting point**: `diagnostics.severity` is applied on top, so a team can take the profile and still argue with one line of it.


## v0.19.0 — DASH compared, and across periods

- [x] **HL-39 — Compare two MPDs**: `compareMpds` matches periods by `@id`, adaptation sets by what they carry and representations by `@id` — the DASH equivalent of matching HLS rungs by URI, stable for the same reason — and reports `@type` and `@mediaPresentationDuration` too. `Compare With…` now runs on an open `.mpd`. The defect this item was opened for is fixed at the source: **two documents that are neither playlists now say they cannot be compared**, instead of returning an empty list that reads as "identical".
- [x] **HL-42 — Cross-period `dash/*` rules**: `dash/period-codecs-change` (a decoder reconfigured mid-presentation, which on many devices is a visible stall), `dash/period-missing-track` (a track that stops existing at a boundary is silence, or a subtitle that disappears, from that point on) and `dash/period-not-contiguous` (periods chain; a hole between them is media no player can request). 81 → 84.

## The extension's interface

Twelve commands, 84 rules and one webview, and no way to discover any of it: the tree
shows everything at once or nothing, the timeline is a snapshot you re-run by hand, and
the only navigation goes one way — from a row to a line, never back. This is the half
of the extension that is glue by design, so each item names the piece of it that is
logic and therefore gets a test.

- [ ] **HL-45 — A timeline that follows the stream**: the panel re-renders on each poll of `Watch Live Playlist` instead of being a snapshot re-run by hand, with the live edge marked and a zoom to a time range for a window with hundreds of segments. `buildTimeline` gains a range option and the marking of the edge, both tested; the panel plumbing is glue. The bars are already buttons — they need the labels that make them usable without a mouse.
- [ ] **HL-46 — Navigation that goes both ways**: clicking a tree row reveals its line, and nothing does the reverse. `rowForLine` in the core answers "which row owns this line" and lets the tree follow the cursor, which is how a finding on line 4000 of a live playlist becomes findable at all.

## v0.20.0 — The glue under test

`src/extension.ts` was exempt from the tests by convention. The exemption had already
cost a bug, so it is gone.

- [x] **HL-47 — Test the extension host glue**: `test/vscode-stub.ts` is a fake `vscode` — the classes, the enums, and the namespaces recording what they are asked to do — aliased into the test bundle by `esbuild.mjs` and nowhere else. `activate()` now runs under Node, so the glue is driven rather than trusted: a **two-way check between the commands `package.json` declares and the ones `activate` registers** (either direction is a bug that fails nothing at build time), the `source = 'hls-lens'` the quick fixes filter on, a finding from another extension that must not be claimed, `hint → Information`, the tree's sections and their reveal commands, the MPD tree and status bar, the profile graded *under* the user's settings, and the workspace scan's diagnostics being dropped when the file is opened. The alternative was `@vscode/test-electron`, which downloads a copy of VS Code: rejected because this suite is offline by rule and runs in a second. What the stub cannot check is that the real API behaves as modelled — that is the price, and it is written into the file rather than left implied.

## v0.21.0 — DASH drawn and documented

The last two of `DASH, all the way`: the milestone is closed.

- [x] **HL-40 — The timeline for an MPD**: `buildMpdTimeline` reads the `<SegmentTimeline>` of every adaptation set — `@r` expanded, `@timescale` applied — and feeds the **same** layout, axis and out-of-step detection the HLS timeline uses (`layoutRows`, extracted for it). Period boundaries are drawn as discontinuities, which is what they are: crossing one is where a decoder gets reconfigured. An MPD that lists no segments draws **nothing** rather than guessing a segment count from `@duration`, because a strip with an invented number of segments in it is a picture that lies.
- [x] **HL-41 — Document links and hover in an MPD**: `mpdLinks` finds the URLs (`<BaseURL>`, `@initialization`, `@sourceURL`, `UTCTiming@value`) and deliberately skips the templates — nothing resolves `$Number$`, so a link to `chunk-$Number$.m4s` would offer a request that cannot be made. It reads the text rather than the parsed tree because a link is a *range* and the XML reader keeps lines, not columns; the limitation (a `<BaseURL>` split across lines) is written down. `src/core/dashspec.ts` documents eleven elements with their attributes, and a test asserts that everything the tree, the rules and the timeline read is among them.

## v0.22.0 — Found and filtered

The first half of `The extension's interface`: being discoverable, and not being a wall.

- [x] **HL-43 — A first run that explains itself**: `contributes.walkthroughs` with four steps — open a manifest, read the shape of the stream, look at more than one file, make the rules yours — each with its own markdown. The logic-free half of the item still gets a test: **every `command:` link in the walkthrough is checked against the commands `activate` registers**, in the steps and in the markdown files, because a walkthrough is the first thing a new user clicks and a dead link there does nothing at all, silently.
- [x] **HL-44 — A tree you can filter**: `src/core/tree.ts` holds the two rules that make a filtered tree usable — a row survives if it or anything under it matches (otherwise searching for a segment URI hides the section containing it), and a row that matches on its own keeps all its children (otherwise filtering for "variants" gives an empty section header). The description is searched as well as the label, because that is where the numbers are. The filter states itself as the first row and clears itself when clicked: a view that looks empty for no reason is worse than one that says why. A severity filter sits next to it. Both are driven end to end in a test, now that the glue can be.
