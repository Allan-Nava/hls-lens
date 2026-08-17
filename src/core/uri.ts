// URI handling shared by the tree, the fetcher and the rules.
//
// A manifest addresses its children with relative URIs, so every feature that
// follows a link — opening a variant, fetching a child playlist, telling whether a
// key travels in the clear — needs the same resolution, and it has to work both
// for an https master on a CDN and for a file open from disk.
import * as path from 'path';

/** isRemote reports whether a URI is http(s), i.e. fetched rather than read. */
export function isRemote(uri: string): boolean {
  return /^https?:\/\//i.test(uri.trim());
}

/**
 * isPlainHttp reports whether a URI travels unencrypted to a real host.
 *
 * Loopback is excluded on purpose: `http://localhost:8080/master.m3u8` is how
 * every packager is tested, and reporting it would train people to ignore the
 * rule that matters on a CDN.
 */
export function isPlainHttp(uri: string): boolean {
  const trimmed = uri.trim();
  if (!/^http:\/\//i.test(trimmed)) return false;
  try {
    const host = new URL(trimmed).hostname.toLowerCase();
    return !(host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost'));
  } catch {
    return false;
  }
}

/** baseOf returns the directory a manifest's relative URIs resolve against. */
export function baseOf(uri: string): string {
  if (isRemote(uri)) {
    try {
      return new URL('.', uri).toString();
    } catch {
      return uri;
    }
  }
  return path.dirname(uri) + path.sep;
}

/** resolveUri resolves a manifest-relative reference against the manifest itself. */
export function resolveUri(manifest: string, ref: string): string {
  const target = ref.trim();
  if (isRemote(target)) return target;
  if (isRemote(manifest)) {
    try {
      return new URL(target, manifest).toString();
    } catch {
      return target;
    }
  }
  if (path.isAbsolute(target)) return target;
  return path.join(path.dirname(manifest), target);
}

/** looksLikePlaylistUri reports whether a URI addresses another playlist. */
export function looksLikePlaylistUri(uri: string): boolean {
  const withoutQuery = uri.split('#')[0].split('?')[0];
  return /\.(m3u8|m3u)$/i.test(withoutQuery.trim());
}

/**
 * looksLikeFmp4Uri reports whether a segment URI is fragmented MP4 rather than
 * MPEG-TS. It decides whether the playlist needs an EXT-X-MAP init segment.
 */
export function looksLikeFmp4Uri(uri: string): boolean {
  const withoutQuery = uri.split('#')[0].split('?')[0];
  return /\.(m4s|mp4|m4v|m4a|cmfv|cmfa|cmft|fmp4)$/i.test(withoutQuery.trim());
}
