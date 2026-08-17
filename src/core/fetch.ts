// Fetching a manifest over http(s).
//
// Written on node:http/https rather than fetch() so it works on every VS Code
// version this extension supports, and so the two things that matter for a
// manifest — the URL we ended up at after redirects, and a hard cap on the body —
// are explicit. The final URL is not a detail: every relative URI in the playlist
// resolves against it, so a redirect that is silently forgotten sends the tree and
// the deep check to the wrong host.
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

/** Options for one manifest fetch. */
export interface FetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Hard cap on the response body; a manifest that big is a mistake, not a manifest. */
  maxBytes?: number;
  insecure?: boolean;
}

/** The result of a fetch. */
export interface FetchResult {
  text: string;
  /** The URL the content actually came from, after redirects. */
  finalUrl: string;
  contentType: string;
}

const MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/** fetchText reads a text resource, following redirects. */
export async function fetchText(url: string, options: FetchOptions = {}): Promise<FetchResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? 15000;
  let current = url;

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    const hop = await requestOnce(current, options, timeoutMs, maxBytes);
    if (hop.location !== undefined) {
      current = new URL(hop.location, current).toString();
      continue;
    }
    return { text: hop.body, finalUrl: current, contentType: hop.contentType };
  }
  throw new Error(`too many redirects (more than ${MAX_REDIRECTS}) starting at ${url}`);
}

interface Hop {
  body: string;
  contentType: string;
  /** Set when the response was a redirect and the caller should follow it. */
  location?: string;
}

function requestOnce(url: string, options: FetchOptions, timeoutMs: number, maxBytes: number): Promise<Hop> {
  return new Promise<Hop>((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error(`not a URL: ${url}`));
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      reject(new Error(`unsupported scheme ${parsed.protocol} in ${url}`));
      return;
    }

    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request(
      url,
      {
        method: 'GET',
        headers: { Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, */*', ...(options.headers ?? {}) },
        ...(parsed.protocol === 'https:' && options.insecure ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location) {
          res.resume(); // drain, we are only after the Location
          resolve({ body: '', contentType: '', location });
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`HTTP ${status} ${res.statusMessage ?? ''} for ${url}`.trim()));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy();
            reject(new Error(`response too large (over ${maxBytes} bytes) for ${url}`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          resolve({
            body: Buffer.concat(chunks).toString('utf8'),
            contentType: String(res.headers['content-type'] ?? ''),
          });
        });
        res.on('error', reject);
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timed out after ${timeoutMs}ms fetching ${url}`));
    });
    req.on('error', reject);
    req.end();
  });
}
