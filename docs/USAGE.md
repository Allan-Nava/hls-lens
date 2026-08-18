---
title: Usage
---

# Usage

## Open a manifest

Open any `.m3u8` file and the diagnostics appear as you edit. To read one from a CDN, run **HLS Lens: Open Manifest URL…** (from the command palette, or the cloud icon in the HLS view): the playlist is fetched into a read-only editor with the diagnostics already on it.

Redirects are followed, and the URL the content *actually* came from is what child URIs resolve against — so opening a variant after a CDN redirect goes to the right host rather than the one you typed.

Extra headers (a signed-URL token, a `Host` override for a staging edge) go in `hlsLens.request.headers`.

## The tree

The **HLS** view in the activity bar shows the manifest as it is structured:

| Section | What is in it |
|---|---|
| Summary | `4 variants · 360p→1080p · 0.88 Mbps–6.10 Mbps · 3 alternate renditions` |
| Variants | The ladder in ascending bitrate, with I-frame streams last — they are trick play, not a rung |
| Renditions | Alternate audio, subtitles and captions, with their group, language and default flag |
| Segments | Duration, URI and the DISCONTINUITY / GAP / BYTERANGE marks (first 50 — a live playlist has thousands) |
| Init & keys | `EXT-X-MAP` and every `EXT-X-KEY`, with its method and URI |
| Problems | Every finding, worst first, with the line |

Clicking a row reveals its line in the manifest. Variant and rendition rows have two inline actions: **open the child playlist** (in the editor when it is a file, fetched when it is remote) and **copy the resolved URI**.

Variant, rendition, segment and `EXT-X-MAP` URIs are also document links in the editor itself: ⌘-click a URI to follow it.

## Diagnostics

Every finding carries the rule id as its diagnostic code, so the Problems panel is filterable and a rule you disagree with can be pinned:

```jsonc
{
  // A rule id, or a whole category.
  "hlsLens.diagnostics.skip": ["master/no-iframe-stream", "syntax/unknown-tag"],
  // Hide the advisory rules entirely.
  "hlsLens.diagnostics.minSeverity": "warning"
}
```

A rule you disagree with about *how loud* it should be does not have to be switched off:

```jsonc
{
  // A rule id or a whole category, graded to error / warning / hint / off.
  "hlsLens.diagnostics.severity": {
    "master/ladder-spacing": "warning",
    "syntax/unknown-tag": "off",
    "dash": "hint"
  }
}
```

The more specific setting wins, so a category can be quietened with one rule kept loud. A value
that is not a severity is left alone rather than guessed at: that is a typo in a settings file, and
silently dropping the rule would hide it.

Two rules have thresholds, because they are the ones that are genuinely site policy:

- `hlsLens.pdtDriftToleranceMs` (default 500) — how far `EXT-X-PROGRAM-DATE-TIME` may drift from the sum of the `EXTINF` durations between two stamps before `media/pdt-drift` fires.
- `hlsLens.targetDurationSlack` (default 1.5) — how far `EXT-X-TARGETDURATION` may exceed the longest real segment before `media/target-duration-overstated` fires.

The full catalogue, with the reason each rule matters, is in the [rule reference](RULES.md) — and **HLS Lens: Show Rule Reference** opens the same thing from inside the editor, generated from the extension itself.

## Writing a manifest

Hover a tag for its reference: what it does, the `EXT-X-VERSION` it needs, whether it belongs in a master or a media playlist, and a table of its attributes with the values each one accepts.

Completions follow the same source. Typing `#` offers the tags that are legal in the playlist you are in — a media playlist is never offered `EXT-X-STREAM-INF` — with the required version on each entry. Inside a tag that takes an attribute list, `,` offers the attributes it accepts, minus the ones already on the line, and `=` offers the enumerated values where the attribute has a closed set.

Seven findings come with a quick fix (the lightbulb, or `⌘.`):

| Finding | Fix |
|---|---|
| `syntax/version-too-low` | Set `EXT-X-VERSION` to what the playlist already uses |
| `media/missing-endlist` | Append `#EXT-X-ENDLIST` after the last segment |
| `media/extinf-exceeds-target` · `media/target-duration-overstated` | Set `EXT-X-TARGETDURATION` to the longest segment, rounded up |
| `syntax/unknown-tag` | Change the tag to the one it was meant to be, when one is within two edits |
| `master/rendition-default-not-autoselect` | Set `AUTOSELECT=YES` |
| `master/rendition-forced` | Remove `FORCED` |

Nothing else is offered a fix. A missing `CODECS` string, a badly spaced ladder or a key served over plaintext HTTP all need a decision that an editor command has no business making.

## Checking the whole workspace

The diagnostics in the editor only exist for a document that is loaded — the one manifest you are
already looking at. **HLS Lens: Check All Manifests in Workspace** reads every `.m3u8`, `.m3u` and
`.mpd` in the folder instead, and fills the Problems panel with what it finds, files nobody has
opened included.

The results live in their own diagnostic collection. Opening one of those manifests replaces its
entries with the live ones, so nothing is ever listed twice.

| | |
|---|---|
| What is scanned | `**/*.{m3u8,m3u,mpd}`, minus `hlsLens.workspace.exclude` (`**/node_modules/**` by default) |
| Settings honoured | `diagnostics.skip`, `diagnostics.minSeverity`, and both thresholds |
| Cap | 2000 manifests — when the scan stops there it says so in the output channel |

The report in the **HLS Lens** output channel ranks the files worst first: errors, then warnings,
then hints, then the path. The last tie-break is what makes two scans of the same tree comparable,
so a report can be diffed against yesterday's.

## Checking the renditions together

`HLS Lens: Check Renditions Together` reads every playable rung of the open master — over HTTP when the master came from a URL, off disk when it is a file — and compares them with each other. The findings land in the Problems panel on the master's own `EXT-X-STREAM-INF` lines, in their own collection, because that is the line that names the rendition that diverges.

| The renditions disagree about | Why it matters |
|---|---|
| `EXT-X-VERSION` | A player honours the version of the playlist it happens to be reading |
| `EXT-X-TARGETDURATION` | Buffering and the reload interval are sized on it |
| Segment count, or where the boundaries fall | A switch continues at the boundary the player knows: drift lands mid-picture |
| Discontinuity positions | An ad break one segment out breaks the switch exactly where the stream already changes |
| Live or finished, and the media sequence | One rung with `EXT-X-ENDLIST` strands every player that switches to it |
| `BANDWIDTH` against the rendition's own `EXT-X-BITRATE` | ABR provisions against `BANDWIDTH`; understating it picks a rung the connection cannot carry |

Only the playable video rungs are compared. An alternate audio or subtitle rendition is legitimately segmented differently, and reporting that as drift would be a finding that is not one. A rendition that cannot be read is listed in the **HLS Lens** output channel and skipped, so one unreachable rung does not hide the others.

## Rendition groups

Alternate audio, subtitles and captions are the one part of a master a player resolves purely by
name. Nothing fails loudly when a name is wrong — the stream plays without the track — so these
rules read the group from both sides.

| Rule | What it catches |
|---|---|
| `master/rendition-missing-attributes` | an `EXT-X-MEDIA` with no `TYPE`, `GROUP-ID` or `NAME`, or a `TYPE` the spec does not define |
| `master/rendition-uri` | subtitles with no `URI`; closed captions *with* one (forbidden) or with no `INSTREAM-ID` |
| `master/rendition-forced` | `FORCED=YES` on a rendition that is not subtitles |
| `master/rendition-default-not-autoselect` | `DEFAULT=YES` together with `AUTOSELECT=NO` |
| `master/rendition-duplicate-name` | two renditions of one group sharing a `NAME` |
| `master/audio-group-mixed-channels` | one audio group mixing stereo and 5.1 |
| `master/undefined-group` | a variant naming a group no `EXT-X-MEDIA` declares |
| `master/unused-group` | a group no variant names — the same rename, from the other side |
| `master/inconsistent-groups` | variants that do not all reference the same groups |

The last one is the one that produces the strangest bug reports: a player picks a rung on bandwidth
alone, so if only some rungs name the `AUDIO` group, whether the viewer has alternate audio depends
on their connection at that moment, and changes mid-playback.

`AUTOSELECT` left out is not treated as `AUTOSELECT=NO`. Only the explicit "no" contradicts a
default, and only that is reported.

## Variables

`EXT-X-DEFINE` lets one template serve several deployments, and the extension substitutes the
variables as it parses:

```m3u8
#EXT-X-DEFINE:NAME="host",VALUE="cdn.example.com"
#EXT-X-MAP:URI="https://{$host}/init.mp4"
```

The tree, the document links and every rule then see `https://cdn.example.com/init.mp4` — the URI
that will actually be requested. `IMPORT` and `QUERYPARAM` declare a name whose value arrives from
the master or from the request, so the name counts as declared and the text is left alone.

A `{$name}` nothing declares is **not** guessed at. Substitution is textual and has no error path: a
player requests the URL with the braces still in it, and `syntax/undefined-variable` reports it on
the line that uses it. Otherwise the only clue is a 404 for a hostname with a `{` in it.

## The timeline

`HLS Lens: Show Timeline` opens a panel beside the manifest with the segments drawn as a strip. On a
media playlist it is that playlist; on a master it reads every playable rung first and stacks them on
one axis, which is the only way misalignment is visible rather than inferred.

| On the strip | What it means |
|---|---|
| a bar | one segment, as wide as its `EXTINF` share of the longest track |
| an orange edge | an `EXT-X-DISCONTINUITY` precedes the segment |
| a hatched bar | `EXT-X-GAP`: the packager published a hole |
| a purple bar | the segment falls inside an ad break an `EXT-X-DATERANGE` declares |
| a dashed rule | a boundary that not every rung shares |

Clicking a segment reveals its line in the manifest.

Ad breaks are only drawn when the playlist carries an `EXT-X-PROGRAM-DATE-TIME`: a `DATERANGE` is
anchored to the wall clock, and with nothing to tie the media timeline to it there is nothing to
convert. A guessed ad break in a picture is worse than none, because a picture looks like a fact.

When several rungs disagree, the rows called *out of step* are the minority — with one rung out of
five putting a boundary somewhere else, it is that rung that is wrong, and flagging all five would
hide it. `HLS Lens: Check Renditions Together` is the same disagreement as findings on lines; this is
the same disagreement as a shape.

## Low-latency playlists

A low-latency playlist is a promise a player acts on *before* the media exists: it blocks on a
reload, it requests a part the server has not finished writing, it switches rungs on a report
instead of on a playlist it fetched. Every one of those is a request that cannot be taken back, so
a declaration that does not hold costs a stall at the live edge — where there is no buffer left to
absorb it.

| Rule | What it catches |
|---|---|
| `media/part-without-part-inf` | parts with no `EXT-X-PART-INF`: nothing says how long a part is meant to be |
| `media/part-exceeds-part-target` | a part longer than the `PART-TARGET` the playlist declares |
| `media/part-target-too-large` | `PART-TARGET` at or above `TARGETDURATION` — a part as long as a segment |
| `media/part-without-server-control` | parts with no `CAN-BLOCK-RELOAD=YES` and `PART-HOLD-BACK`: bandwidth spent, no latency bought |
| `media/holdback-too-small` | a hold-back under the three target durations (or three part durations) the spec requires |
| `media/can-skip-until-too-small` | `CAN-SKIP-UNTIL` under six target durations: a delta no conforming client may ask for |
| `media/preload-hint` | a hint with no `TYPE` or `URI`, or a second hint of a type that allows one |
| `media/preload-hint-not-preloading` | a hint for a part the playlist already publishes, or a `TYPE=PART` hint where there are no parts |
| `media/rendition-report` | a report with no `URI` or no `LAST-MSN`: not enough to switch on |
| `media/rendition-report-out-of-step` | a report several segments away from where this playlist is |
| `media/rendition-report-missing` | a low-latency playlist that reports no other rendition at all |

What a part *contains* is not asked here — whether those bytes are really 500ms of video is a
question about the media, and that is [segcheck](https://github.com/Allan-Nava/segcheck)'s.

## DASH manifests

Open an `.mpd` and it is read the way a playlist is: the **HLS** view shows the manifest's shape — periods, adaptation sets and the representations under them, with bitrate, resolution and frame rate — the status bar says what the manifest is (`static · 1 period · 2 adaptation sets · 5 representations · 10:30`), and the `dash/*` rules report in the same Problems panel, on the line to edit. Clicking a row reveals its line.

The defects are the same ones a playlist has: The same stream is usually packaged both ways from one mezzanine, and the defects are the same ones: a duration that disagrees with the segments, a hole in the timeline, a live manifest with no clock.

| Rule | What it catches |
|---|---|
| `dash/timeline-gap` | `<S>` elements that do not chain — a gap, or two segments claiming the same seconds |
| `dash/duration-vs-timeline` | `@mediaPresentationDuration` against what the timeline actually covers |
| `dash/dynamic-without-utctiming` | a live MPD with no `<UTCTiming>`: a client whose clock is off requests segments that do not exist yet |
| `dash/adaptationset-not-aligned` | several representations with no `@segmentAlignment="true"`, so a player must assume it cannot switch |
| `dash/segment-template-without-number` | a `@media` template with neither `$Number$` nor `$Time$`: every segment is the same URL |
| `dash/not-an-mpd` | a `.mpd` that is an error page a CDN returned |

The XML reader is part of the extension rather than a dependency, and it is deliberately narrow: elements, attributes and nesting. A manifest that needs entity expansion, DTDs or namespace resolution is reported rather than guessed at.

## Watching a live playlist

`HLS Lens: Watch Live Playlist` reloads a manifest opened from a URL and reports what changed, in the **HLS Lens** output channel, at the interval the playlist itself declares — `EXT-X-TARGETDURATION`, floored at two seconds so a low-latency playlist does not turn the watch into a load test. `hlsLens.watch.intervalSeconds` overrides it.

What it tells you between two reloads:

- the new segments, and how many slid off the front of the window;
- a **discontinuity** that appeared, by segment name;
- an `EXT-X-ENDLIST` that arrived — the stream ended, and the watch stops itself;
- a window that **did not move for two reloads**, which is the packager having stopped. In any single snapshot that looks exactly like a healthy stream.

The status bar shows `$(eye) watching` while it runs, with the stall count when there is one; clicking it stops the watch. Segments are matched by URI rather than by index, so a packager that renumbers does not report the whole window as new.

## Deep check

**HLS Lens: Deep Check Segments (segcheck)** answers the questions a manifest cannot:

| The manifest says | The deep check reads the segments and answers |
|---|---|
| `#EXTINF:6.000` | Is the media really 6.000s, or 5.184s and drifting? |
| `RESOLUTION=1920x1080` | What does the bitstream actually code? |
| Segment 41 follows 40 | Do the timestamps join up, or is there a hole with no `EXT-X-DISCONTINUITY`? |
| `BANDWIDTH=2400000` | What is the measured peak segment bitrate? |
| Four renditions | Do their segment boundaries land on the same timeline? |

It needs a URL (the segments live next to the manifest on the CDN) and the [segcheck](https://github.com/Allan-Nava/segcheck) binary:

```bash
brew install --cask allan-nava/tap/segcheck
```

Point `hlsLens.segcheck.path` at it if it is not on your `PATH`. To inspect one rung rather than the whole master, right-click a variant in the HLS view and pick **Deep Check This Rendition**. The findings land in the Problems panel in their own collection — editing the manifest does not clear them — and the full run is in the **HLS Lens** output channel. `hlsLens.segcheck.segments`, `.renditions` and `.from` control how much it samples; the run is cancellable from the progress notification.

Everything else in the extension works without the binary. Only the deep check needs it.

## Development

```bash
npm install
npm run watch      # then F5 for the Extension Host
npm test           # the pure core; no network, ever
npm run typecheck
npm run docs       # regenerate the rule reference from the catalogue
```

The logic lives in `src/core/` and never imports `vscode`, which is why the parser, the rules, the ladder model and the segcheck bridge are all testable against fixtures. See `CLAUDE.md` for the conventions and the known traps.
