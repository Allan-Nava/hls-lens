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

Two rules have thresholds, because they are the ones that are genuinely site policy:

- `hlsLens.pdtDriftToleranceMs` (default 500) — how far `EXT-X-PROGRAM-DATE-TIME` may drift from the sum of the `EXTINF` durations between two stamps before `media/pdt-drift` fires.
- `hlsLens.targetDurationSlack` (default 1.5) — how far `EXT-X-TARGETDURATION` may exceed the longest real segment before `media/target-duration-overstated` fires.

The full catalogue, with the reason each rule matters, is in the [rule reference](RULES.md) — and **HLS Lens: Show Rule Reference** opens the same thing from inside the editor, generated from the extension itself.

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

Point `hlsLens.segcheck.path` at it if it is not on your `PATH`. The findings land in the Problems panel in their own collection — editing the manifest does not clear them — and the full run is in the **HLS Lens** output channel. `hlsLens.segcheck.segments`, `.renditions` and `.from` control how much it samples; the run is cancellable from the progress notification.

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
