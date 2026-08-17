---
title: HLS Lens
---

# HLS Lens

**Read HLS manifests in VS Code — with the manifest telling you what is wrong with it.**

An `.m3u8` file is a list of claims, and a text editor shows you all of them equally. HLS Lens reads a manifest the way someone who has debugged a stream reads it, and reports what it finds on the line you have to fix.

- [Usage](USAGE.md) — commands, the tree, the deep check, settings
- [Rule reference](RULES.md) — all 67 rules with the reason each one matters
- [Roadmap](ROADMAP.md) — what is shipped and what is next, generated from the backlog
- [Source on GitHub](https://github.com/Allan-Nava/hls-lens)

This site is built from the same markdown the repository keeps, by a renderer that is part of the extension: no theme, no framework, no dependency — the same rule the code follows.

## In one screenshot's worth of words

```m3u8
#EXTM3U
#EXT-X-VERSION:3                        ← error   syntax/version-too-low
#EXT-X-TARGETDURATION:6                          EXT-X-MAP needs 6
#EXT-X-PLAYLIST-TYPE:VOD                ← error  media/missing-endlist
#EXT-X-KEY:METHOD=AES-128,URI="http://…" ← error  media/key-over-http
#EXT-X-MAP:URI="init.mp4"
#EXTINF:8.500,                          ← error   media/extinf-exceeds-target
seg-01205.m4s                                    8.5s against a 6s target
```

## Two layers, on purpose

The 67 rules in the extension read the manifest: they are instant, work offline, and need nothing installed. The defects that cannot be seen from the manifest — a timeline gap no `EXT-X-DISCONTINUITY` declares, a 1080p rung whose bitstream codes 720p, a real segment duration that drifts from its `EXTINF` — need the segment bytes, and those are [segcheck](https://github.com/Allan-Nava/segcheck)'s job. `HLS Lens: Deep Check Segments` runs it and brings its findings into the same Problems panel.

Nothing in the extension reimplements a demuxer, and nothing in segcheck duplicates a manifest rule.
