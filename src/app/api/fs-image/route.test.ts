import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * /api/fs-image is the first route in the app that hands back raw file bytes,
 * and its caller is a markdown document — which the user may not have written.
 * So the refusals are the point, exactly as they are for /api/fs-op:
 *
 *   1. It really serves the image, with the right type and the real bytes.
 *   2. It refuses rather than leaks — an escaping `rel`, a directory, a missing
 *      file and a non-whitelisted extension all come back as a status, never as
 *      content. A `![](../../../.ssh/id_rsa)` in a README must not be a read
 *      primitive.
 *
 * The fixture puts a SIBLING directory next to the project so the escape tests
 * have a real secret to fail to reach.
 */

const root = mkdtempSync(join(tmpdir(), 'naby-fs-image-'));
const cwd = join(root, 'proj');
const outside = join(root, 'outside');

let route: typeof import('./route');

/** A PNG that is a valid signature plus an IHDR chunk — enough for a header
 *  probe to report 1920x1080, and small enough to compare byte for byte. */
function pngBytes(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), ihdr]);
}

const SHOT = pngBytes(1920, 1080);

const get = (params: Record<string, string>, headers: Record<string, string> = {}) => {
  const query = new URLSearchParams(params).toString();
  return route.GET(new Request(`http://127.0.0.1/api/fs-image?${query}`, { headers }));
};

type ProbeRes = {
  ok: boolean;
  reason?: string;
  sizes?: Record<string, { width: number; height: number } | null>;
};

const probe = async (body: unknown): Promise<ProbeRes> => {
  const res = await route.POST(
    new Request('http://127.0.0.1/api/fs-image', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as ProbeRes;
};

beforeAll(async () => {
  mkdirSync(join(cwd, 'docs', 'img'), { recursive: true });
  mkdirSync(join(cwd, 'looks-like.png'), { recursive: true });
  writeFileSync(join(cwd, 'docs', 'img', 'shot.png'), SHOT);
  writeFileSync(join(cwd, 'docs', 'img', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"></svg>');
  writeFileSync(join(cwd, 'docs', 'img', 'photo.HEIC'), 'not decodable by chromium');
  writeFileSync(join(cwd, '.env'), 'SECRET=1');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'private.png'), pngBytes(10, 10));
  route = await import('./route');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('GET — serving the bytes', () => {
  it('returns the real file with the whitelisted content type', async () => {
    const res = await get({ cwd, rel: 'docs/img/shot.png' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const body = Buffer.from(await res.arrayBuffer());
    // Byte for byte: nothing on this path resamples, re-encodes or thumbnails
    // the user's file.
    expect(body.equals(SHOT)).toBe(true);
  });

  it('serves SVG as image/svg+xml, hardened against being treated as a document', async () => {
    const res = await get({ cwd, rel: 'docs/img/logo.svg' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    // Through <img> an SVG cannot run script. These two cover the one context
    // where it would be a document instead: a direct navigation to the URL.
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  it('carries an ETag keyed on mtime and size, and honours a conditional request', async () => {
    const first = await get({ cwd, rel: 'docs/img/shot.png' });
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();
    expect(first.headers.get('cache-control')).toContain('must-revalidate');

    const second = await get({ cwd, rel: 'docs/img/shot.png' }, { 'if-none-match': etag as string });
    expect(second.status).toBe(304);
    expect(second.headers.get('etag')).toBe(etag);

    // Touching the file invalidates it — which is what lets the viewer skip a
    // watcher entirely.
    const when = new Date(Date.now() + 10_000);
    utimesSync(join(cwd, 'docs', 'img', 'shot.png'), when, when);
    const third = await get(
      { cwd, rel: 'docs/img/shot.png' },
      { 'if-none-match': etag as string },
    );
    expect(third.status).toBe(200);
    expect(third.headers.get('etag')).not.toBe(etag);
  });
});

describe('GET — what it refuses', () => {
  it('refuses a rel that walks out of the project, without reading it', async () => {
    const res = await get({ cwd, rel: '../outside/private.png' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, reason: 'escape' });
  });

  it('refuses a sibling directory whose name merely starts with the root name', async () => {
    // `/…/proj-old` against `/…/proj` — the case the `+ sep` in withinCwd exists
    // for. Reached via an absolute-looking rel that resolve() joins away.
    const res = await get({ cwd, rel: '../proj-old/x.png' });
    expect(res.status).toBe(403);
  });

  it('refuses a file that is not there', async () => {
    const res = await get({ cwd, rel: 'docs/img/ghost.png' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, reason: 'not-found' });
  });

  it('refuses a DIRECTORY, even one named like an image', async () => {
    const res = await get({ cwd, rel: 'looks-like.png' });
    expect(res.status).toBe(404);
  });

  it('refuses a non-whitelisted extension before it opens anything', async () => {
    // Containment alone is not enough: a contained path only yields bytes when
    // it is a format the viewer shows. This is what stops a markdown file from
    // becoming a way to read `.env`.
    const res = await get({ cwd, rel: '.env' });
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ ok: false, reason: 'unsupported-type' });
  });

  it('refuses HEIC, which is on disk but which Chromium cannot decode', async () => {
    // Whitelisting it would paint a blank frame; refusing it makes the viewer
    // show a placeholder that says what happened. Same list on both sides.
    const res = await get({ cwd, rel: 'docs/img/photo.HEIC' });
    expect(res.status).toBe(415);
  });

  it('refuses a missing or relative cwd, and the project root itself', async () => {
    expect((await get({ cwd: '', rel: 'a.png' })).status).toBe(400);
    expect((await get({ cwd: 'proj', rel: 'a.png' })).status).toBe(400);
    expect((await get({ cwd, rel: '' })).status).toBe(400);
  });
});

describe('POST — the batch header probe', () => {
  it('answers with intrinsic dimensions, read from the header alone', async () => {
    const res = await probe({ cwd, rels: ['docs/img/shot.png'] });
    expect(res.ok).toBe(true);
    expect(res.sizes).toEqual({ 'docs/img/shot.png': { width: 1920, height: 1080 } });
  });

  it('answers null for every rel it refuses, rather than dropping it', async () => {
    // An absent key would read as "not probed yet" to the caller, which would
    // then ask again on every render, forever.
    const rels = [
      '../outside/private.png',
      'docs/img/ghost.png',
      'looks-like.png',
      '.env',
      'docs/img/photo.HEIC',
    ];
    const res = await probe({ cwd, rels });
    expect(res.ok).toBe(true);
    for (const rel of rels) {
      expect(res.sizes).toHaveProperty([rel], null);
    }
  });

  it('serves a repeat request from the cache with the same answer', async () => {
    const first = await probe({ cwd, rels: ['docs/img/shot.png'] });
    const second = await probe({ cwd, rels: ['docs/img/shot.png'] });
    expect(second.sizes).toEqual(first.sizes);
  });

  it('refuses a missing cwd or a rels that is not a list', async () => {
    expect(await probe({ cwd: '', rels: [] })).toEqual({ ok: false, reason: 'invalid-cwd' });
    expect(await probe({ cwd, rels: 'a.png' })).toEqual({ ok: false, reason: 'invalid-target' });
  });
});
