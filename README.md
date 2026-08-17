<p align="center">
  <img src="media/icon.png" alt="HLS Lens" width="96" height="96">
</p>

<h1 align="center">HLS Lens</h1>

<p align="center"><strong>Read HLS manifests in VS Code — with the manifest telling you what is wrong with it.</strong></p>

---

An `.m3u8` file is a list of claims, and a text editor shows you all of them equally. HLS Lens reads the manifest the way someone who has debugged a stream reads it: a wildcard where a hostname should be, a segment longer than the target duration it declares, a `PROGRAM-DATE-TIME` that walks away from the media timeline, an fMP4 playlist with no init segment, a content key fetched over plaintext HTTP.

**33 rules, on the line you have to fix**, while you edit:

```m3u8
#EXTM3U
#EXT-X-VERSION:3                        ← error   syntax/version-too-low
#EXT-X-TARGETDURATION:6                          EXT-X-MAP needs 6
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-KEY:METHOD=AES-128,URI="http://…" ← error  media/key-over-http
#EXT-X-MAP:URI="init.mp4"
#EXTINF:8.500,                          ← error   media/extinf-exceeds-target
seg-01205.m4s                                    8.5s against a 6s target
```

Plus the ladder as a tree, clickable child playlists, and — when you point it at a live URL — a deep check that hands the segment-level findings of [segcheck](https://github.com/Allan-Nava/segcheck) to the same Problems panel.

## What it does

- **Diagnostics while you type.** Every rule reports the line, the reason and the fix. Rule ids are stable (`media/extinf-exceeds-target`), so a rule you disagree with goes in `hlsLens.diagnostics.skip` and stays gone. The full reference is [docs/RULES.md](docs/RULES.md), and `HLS Lens: Show Rule Reference` opens it inside the editor.
- **The manifest as a tree.** The bitrate ladder in ascending order (with I-frame streams kept out of it, where they belong), the alternate audio and subtitle renditions, the segments with their durations and discontinuity/gap marks, the init segment and the keys, and the findings. Clicking a row reveals its line.
- **Open a manifest from a URL.** `HLS Lens: Open Manifest URL…` fetches a playlist into a read-only editor with the diagnostics already on it. Redirects are followed and the *final* URL is what child URIs resolve against, so a CDN redirect does not send you hunting on the wrong host.
- **Follow the links.** Variant, rendition, segment and `EXT-X-MAP` URIs are document links: on disk they open the file, on a CDN they open where they live.
- **Deep check with segcheck.** The manifest rules read claims. `HLS Lens: Deep Check Segments` runs `segcheck check --output json` on a URL, so the findings that need the actual bytes — a gap no `EXT-X-DISCONTINUITY` declares, a rung that codes a lower resolution than it promises, a segment whose real duration drifts from its `EXTINF` — land next to them in the Problems panel. Without the binary the extension still does everything else; the deep check is the only feature that needs it.
- **A status bar line** that says what the open manifest is: `4 variants · 360p→1080p · 0.88 Mbps–6.10 Mbps · 3 alternate renditions`.

## The rules, in one paragraph

Five **structure** rules (missing `#EXTM3U`, a BOM before it, a file that is both master and media, a misspelled tag — which players silently ignore, so a typo'd `EXT-X-TARGETDURATON` reads as *no target duration at all* — and an `EXT-X-VERSION` lower than the tags in use).
Twelve **master playlist** rules (missing `BANDWIDTH`/`RESOLUTION`/`CODECS`, duplicate `BANDWIDTH`, a variant with no URI, an `AUDIO`/`SUBTITLES` group nothing declares, groups with no default or two defaults, no I-frame playlist for trick play, plaintext child URIs, missing `AVERAGE-BANDWIDTH`, a ladder that is not in ascending order).
Sixteen **media playlist** rules (no `TARGETDURATION`, a segment longer than it, a target duration far above the real segments, `PLAYLIST-TYPE:VOD` with no `EXT-X-ENDLIST`, fMP4 with no `EXT-X-MAP`, a content key over HTTP, `PROGRAM-DATE-TIME` going backwards or drifting from the `EXTINF` sum, a live playlist with no wall clock, discontinuities with no `DISCONTINUITY-SEQUENCE`, an `EXTINF` with no URI, `EXT-X-PART` without the `SERVER-CONTROL` that makes parts worth serving, a `HOLD-BACK` under three target durations, `EXT-X-GAP` segments, a live window under three target durations, plaintext segment URIs).

Each one is documented with *why it matters*, not just what it matches: see [docs/RULES.md](docs/RULES.md).

## Install

From the Marketplace: search **HLS Lens**. Or build the `.vsix` yourself:

```bash
npm install
npm run package        # → hls-lens-0.1.0.vsix
code --install-extension hls-lens-0.1.0.vsix
```

For the deep check, install segcheck (`brew install --cask allan-nava/tap/segcheck`, or a binary from [its releases](https://github.com/Allan-Nava/segcheck/releases)) and point `hlsLens.segcheck.path` at it if it is not on your `PATH`.

## Commands

| Command | What it does |
|---|---|
| `HLS Lens: Open Manifest URL…` | Fetch a playlist into a read-only editor, diagnostics included |
| `HLS Lens: Deep Check Segments (segcheck)` | Download and parse the segments, bring the findings back |
| `HLS Lens: Show Rule Reference` | The rule catalogue, from the extension itself |
| `HLS Lens: Copy Resolved URI` | Absolute URI of the selected tree row |
| `HLS Lens: Refresh` | Re-read the active manifest |

## Settings

| Setting | Default | What it is for |
|---|---|---|
| `hlsLens.diagnostics.enabled` | `true` | Turn the squiggles off without disabling the extension |
| `hlsLens.diagnostics.minSeverity` | `hint` | `warning` hides the advisory rules |
| `hlsLens.diagnostics.skip` | `[]` | Rule ids or whole categories to skip |
| `hlsLens.pdtDriftToleranceMs` | `500` | How far `PROGRAM-DATE-TIME` may drift from the `EXTINF` durations |
| `hlsLens.targetDurationSlack` | `1.5` | When `TARGETDURATION` counts as overstated |
| `hlsLens.request.headers` | `{}` | Extra headers for fetching a manifest (a token, a `Host` override) |
| `hlsLens.request.timeoutMs` | `15000` | Fetch timeout |
| `hlsLens.segcheck.path` | `segcheck` | Where the binary is |
| `hlsLens.segcheck.segments` | `6` | Segments sampled per rendition in the deep check |
| `hlsLens.segcheck.renditions` | `0` | Video renditions to inspect (0 = all) |
| `hlsLens.segcheck.from` | `auto` | Sample at the live edge, at the start, or let segcheck decide |
| `hlsLens.segcheck.insecure` | `false` | Skip TLS verification — lab servers only |

## Design notes

- **The logic is a pure core.** `src/core/` never imports `vscode`: the parser, the 33 rules, the ladder model, URI resolution and the segcheck bridge are plain TypeScript with tests. `src/extension.ts` only translates that model into diagnostics, tree items and links.
- **Line numbers everywhere, 0-based.** The parser keeps the line index of every tag, URI, `EXTINF` and `PROGRAM-DATE-TIME` it decodes, because a finding that cannot point at a line is just a linter you have to read twice.
- **Attribute lists are parsed, not split.** `CODECS="avc1.4d401f,mp4a.40.2"` is one value with a comma in it; splitting the line on commas is how a manifest gets reported as codec-less.
- **No dependencies.** Not one runtime dependency; the fetcher is `node:http(s)` and even the Marketplace icon is generated (`npm run icon`) rather than pulled from a toolchain.
- **Nothing in the tests touches the network.** Fixtures for the manifests, a throwaway local HTTP server for the fetcher, and the segcheck bridge tested against the JSON shape rather than by spawning the binary.

## Development

```bash
npm install
npm run watch      # esbuild in watch mode, then F5 for the Extension Host
npm test           # the core: parser, rules, ladder, URIs, segcheck bridge, fetcher
npm run typecheck
npm run docs       # regenerate docs/RULES.md from the catalogue (CI checks this)
```

## Related

Part of a family of domain-specific tooling: [segcheck](https://github.com/Allan-Nava/segcheck) (what your HLS/DASH segments actually contain), [checkfleet](https://github.com/Allan-Nava/checkfleet) (infrastructure health checks), [keycloak-doctor](https://github.com/Allan-Nava/keycloak-doctor) (Keycloak realm audit), and the other lenses: [nomad-lens](https://github.com/Allan-Nava/nomad-lens), [nats-lens](https://github.com/Allan-Nava/nats-lens), [ansible-vars-lens](https://github.com/Allan-Nava/ansible-vars-lens).

## License

MIT — see [LICENSE](LICENSE).
