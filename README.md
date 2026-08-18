<p align="center">
  <img src="media/icon.png" alt="HLS Lens" width="96" height="96">
</p>

<h1 align="center">HLS Lens</h1>

<p align="center"><strong>Read HLS manifests in VS Code — with the manifest telling you what is wrong with it.</strong></p>

---

An `.m3u8` file is a list of claims, and a text editor shows you all of them equally. HLS Lens reads the manifest the way someone who has debugged a stream reads it: a wildcard where a hostname should be, a segment longer than the target duration it declares, a `PROGRAM-DATE-TIME` that walks away from the media timeline, an fMP4 playlist with no init segment, a content key fetched over plaintext HTTP.

**81 rules, on the line you have to fix**, while you edit:

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
- **The spec on hover.** Hovering a tag says what it does, which `EXT-X-VERSION` it needs, where it is legal and every attribute it accepts with its enumerated values — the reference in the editor instead of a browser tab.
- **Completions that know the tag.** `#` offers the tags that belong in *this* kind of playlist, `,` the attributes the tag accepts and not the ones already on the line, `=` the legal values (`YES`/`NO`, `VOD`/`EVENT`, `AUDIO`/`VIDEO`/`SUBTITLES`/`CLOSED-CAPTIONS`).
- **Quick fixes for the mechanical findings.** Bump `EXT-X-VERSION` to what the playlist already uses, append a missing `EXT-X-ENDLIST`, raise `EXT-X-TARGETDURATION` to the longest segment. Only those: a fix that needs a judgement call is not offered.
- **The renditions compared with each other.** `HLS Lens: Check Renditions Together` loads every rung of the open master — from disk or from the CDN — and reports what they disagree about: a different `EXT-X-VERSION`, segment counts that do not match, boundaries that drift, discontinuities one segment out, one rung that already ended while the others are live. Every rendition is a valid playlist on its own; these defects only exist between them, and they are what a player hits the moment it switches rungs.
- **Watch a live playlist.** `HLS Lens: Watch Live Playlist` reloads the manifest on its own target duration and says what changed each time: the new segments, what slid off the front, a discontinuity that appeared, an `EXT-X-ENDLIST` that arrived. A window that stops moving for two reloads is reported — that is the packager falling over, and it looks identical to a healthy stream in any single snapshot.
- **The timeline as a picture.** `HLS Lens: Show Timeline` draws the segments as a strip — discontinuities, `EXT-X-GAP` holes and the ad breaks an `EXT-X-DATERANGE` declares, each marked — and on a master it stacks every rung on one axis. A boundary that not every rung shares is a dashed rule straight through them, and only the rung that drifts is called out of step: with one rung out of five it is that rung that is wrong, not the four that agree. Clicking a segment reveals its line. The whole page is rendered in the core, so the drawing has tests rather than a screenshot.
- **Low latency, checked as a whole.** A low-latency playlist asks a player to act on it *before* the media exists, so a declaration that does not hold costs a request it cannot take back. Eleven rules read the parts against the `PART-TARGET` the playlist declares, the preload hint against what the playlist already publishes (hinting a part it just listed is a wasted round trip, not a preload), the rendition reports against the position this playlist is at, and `CAN-SKIP-UNTIL` against the six target durations below which no conforming client may ask for a delta.
- **The whole workspace, not just the open file.** `HLS Lens: Check All Manifests in Workspace` reads every `.m3u8` and `.mpd` in the folder and fills the Problems panel with what it finds — including files nobody has opened, which is where the defect usually is. The scan is cancellable, and when it stops at its 2000-file cap it says so rather than reporting a partial result as if it were the whole one.
- **Rendition groups, resolved by name.** Alternate audio and subtitles are the one part of a master a player looks up purely by string, and nothing fails loudly when the string is wrong: the stream plays without the track and the viewer reports "no Italian audio" for a manifest that looks well formed. Eight rules read the group from both sides — the renditions in it, and the variants that are supposed to name it.
- **One template, several deployments.** `EXT-X-DEFINE` variables are substituted as the manifest is parsed, so the tree, the document links and every rule see the URI that will actually be requested. A `{$name}` nothing declares is *not* guessed at: substitution is textual and has no error path, so the braces stay in the URL a player requests — and that is reported on the line that uses it, which is the only clue you get from a 404 with a `{` in the hostname.
- **DASH, read the same way.** Open an `.mpd` and eleven `dash/*` rules report on it: a `@mediaPresentationDuration` the segment timeline does not fill, `<S>` elements that do not chain (a hole in the presentation, or two segments claiming the same seconds), a dynamic manifest with no `<UTCTiming>` for clients to synchronise their clock to, an adaptation set that never declares `@segmentAlignment`, a `@media` template with no `$Number$`. The XML reader is written here, like everything else: still no dependencies.
- **A status bar line** that says what the open manifest is: `4 variants · 360p→1080p · 0.88 Mbps–6.10 Mbps · 3 alternate renditions`.

## The rules, in one paragraph

Seven **structure** rules (missing `#EXTM3U`, a BOM before it, a file that is both master and media, a misspelled tag — which players silently ignore, so a typo'd `EXT-X-TARGETDURATON` reads as *no target duration at all* — an `EXT-X-VERSION` lower than the tags in use, a malformed `EXT-X-DEFINE`, and a `{$variable}` nothing declares).
Twenty-four **master playlist** rules (missing `BANDWIDTH`/`RESOLUTION`/`CODECS`, duplicate `BANDWIDTH`, a variant with no URI, an `AUDIO`/`SUBTITLES` group nothing declares, groups with no default or two defaults, no I-frame playlist for trick play, plaintext child URIs, missing `AVERAGE-BANDWIDTH`, a ladder that is not in ascending order, a `CODECS` level that cannot carry the declared `RESOLUTION` and `FRAME-RATE`, rungs so close together that ABR cannot tell them apart — or so far apart that there is nothing to fall back to — malformed `EXT-X-SESSION-DATA`, and content steering with no server or a pathway no variant belongs to) — **eight of them on rendition groups** (an `EXT-X-MEDIA` with no `TYPE`/`GROUP-ID`/`NAME`, subtitles with no `URI`, closed captions with one — the spec forbids it — or with no `INSTREAM-ID`, `FORCED` on something that is not subtitles, `DEFAULT=YES` with `AUTOSELECT=NO`, two renditions of a group sharing a `NAME`, an audio group that mixes stereo and 5.1, a group no variant references, and variants that do not agree on which groups they use).
Thirty **media playlist** rules (no `TARGETDURATION`, a segment longer than it, a target duration far above the real segments, `PLAYLIST-TYPE:VOD` with no `EXT-X-ENDLIST`, fMP4 with no `EXT-X-MAP`, a content key over HTTP, `PROGRAM-DATE-TIME` going backwards or drifting from the `EXTINF` sum, a live playlist with no wall clock, discontinuities with no `DISCONTINUITY-SEQUENCE`, an `EXTINF` with no URI, `EXT-X-GAP` segments, a live window under three target durations, plaintext segment URIs, malformed or overlapping `EXT-X-DATERANGE` ad breaks, a live window a single content key covers, encryption switched off part-way through, an I-frames-only playlist that addresses whole segments instead of byte ranges, and an `EXT-X-START` that lands outside the playlist or inside the live edge) — eleven of them **low latency** (`EXT-X-PART` without the `SERVER-CONTROL` that makes parts worth serving, a hold-back under three target durations, parts with no `EXT-X-PART-INF` or longer than the `PART-TARGET` they declare, a part target as long as a segment, `CAN-SKIP-UNTIL` under six target durations, a malformed or duplicated preload hint, a hint for something the playlist already publishes, a rendition report with no position or several segments out of step, and a low-latency playlist that reports no other rendition at all).

Each one is documented with *why it matters*, not just what it matches: see [docs/RULES.md](docs/RULES.md).

## Install

Documentation: **[allan-nava.github.io/hls-lens](https://allan-nava.github.io/hls-lens/)** — usage, the full rule reference and the roadmap.

From the Marketplace: search **HLS Lens**. Or build the `.vsix` yourself:

```bash
npm install
npm run package        # → hls-lens-0.9.0.vsix
code --install-extension hls-lens-0.9.0.vsix
```

For the deep check, install segcheck (`brew install --cask allan-nava/tap/segcheck`, or a binary from [its releases](https://github.com/Allan-Nava/segcheck/releases)) and point `hlsLens.segcheck.path` at it if it is not on your `PATH`.

## Commands

| Command | What it does |
|---|---|
| `HLS Lens: Open Manifest URL…` | Fetch a playlist into a read-only editor, diagnostics included |
| `HLS Lens: Check Renditions Together` | Load every rung of the master and report what they disagree about |
| `HLS Lens: Show Timeline` | The segments as a strip, the rungs stacked on one axis, the drift drawn |
| `HLS Lens: Check All Manifests in Workspace` | Analyse every manifest in the folder, opened or not |
| `HLS Lens: Watch Live Playlist` | Reload the live playlist and report what changes; click the status bar to stop |
| `HLS Lens: Deep Check This Rendition` | Run segcheck against one rung picked in the tree, not the whole master |
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
| `hlsLens.watch.intervalSeconds` | `0` | Reload interval for the watch; 0 follows `EXT-X-TARGETDURATION` |
| `hlsLens.workspace.exclude` | `**/node_modules/**` | Glob skipped by the workspace scan |

## Design notes

- **The logic is a pure core.** `src/core/` never imports `vscode`: the parser, the 81 rules, the ladder model, URI resolution, the segcheck bridge — and even the backlog parser and the icon generator — are plain TypeScript with tests. `src/extension.ts` only translates that model into diagnostics, tree items and links, and the scripts in `scripts/` are I/O over the same core.
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
npm run icon:check # verify the committed icon against its generator, pixel for pixel
npm run site       # build site/ from docs/ (what GitHub Pages publishes)
npm run roadmap    # regenerate docs/ROADMAP.md from BACKLOG.md (CI checks this)
```

## Releasing

A pushed `v*` tag is the whole release process. [`ci.yml`](.github/workflows/ci.yml) runs the tests,
refuses a tag that disagrees with `package.json`, packages the `.vsix`, attaches it to the GitHub
release, and then publishes **that same file** — not a fresh package — to the VS Code Marketplace and
to Open VSX:

```bash
# after the changelog entry and the version bump
git tag -a v0.9.0 -m "Release 0.9.0" && git push origin main --follow-tags
```

The two store credentials live in the `marketplace` environment, which is also where you can require
a manual approval before a tag reaches users:

| Secret | Where it comes from | Missing? |
|---|---|---|
| `VSCE_PAT` | Azure DevOps PAT, scope **Marketplace › Manage**, for the `allannava95` publisher | Warns and skips the Marketplace step |
| `OVSX_PAT` | [Open VSX](https://open-vsx.org) access token, namespace `allannava95` | Warns nothing, skips Open VSX |

A missing PAT never fails the run: the `.vsix` is still built and attached to the release, so a tag
is releasable before the store accounts exist. Once `VSCE_PAT` is set, **every** tag publishes — the
project tags every commit, so bump the version deliberately.

## Roadmap

[BACKLOG.md](BACKLOG.md) is the plan, and the only place work is tracked. Two things are generated
from it, so none of them can drift:

- **[docs/ROADMAP.md](docs/ROADMAP.md)** — `npm run roadmap`, with CI failing if the committed file
  is not what the backlog produces.
- **GitHub milestones and issues** — the [`backlog-sync`](.github/workflows/backlog-sync.yml)
  workflow runs on every push that touches the backlog and makes the tracker a mirror of the file:
  a `##` heading is a milestone, an item is an issue labelled `backlog`, `- [x]` closes it. A section
  is named after a **release** once it has shipped (`v0.3.0 — Publishing automation`, closed) and
  after a **theme** while it is planned (`Editor`); an item moves from the theme to the release that
  shipped it, which is the only way to answer both questions with the single milestone an issue
  has. Each
  issue is anchored to its stable id (`HL-7`) by a marker in the body, so renaming an item retitles
  its issue instead of opening a second one, and the whole thing is idempotent — it writes only what
  diverges. `workflow_dispatch` takes a `dry_run` input that reports what it would change.

Editing an issue on GitHub is therefore pointless: the next sync overwrites it. Edit the file.

## Related

Part of a family of domain-specific tooling: [segcheck](https://github.com/Allan-Nava/segcheck) (what your HLS/DASH segments actually contain), [checkfleet](https://github.com/Allan-Nava/checkfleet) (infrastructure health checks), [keycloak-doctor](https://github.com/Allan-Nava/keycloak-doctor) (Keycloak realm audit), and the other lenses: [nomad-lens](https://github.com/Allan-Nava/nomad-lens), [nats-lens](https://github.com/Allan-Nava/nats-lens), [ansible-vars-lens](https://github.com/Allan-Nava/ansible-vars-lens).

## License

MIT — see [LICENSE](LICENSE).
