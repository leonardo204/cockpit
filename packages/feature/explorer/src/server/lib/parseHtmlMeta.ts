import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { basename, extname } from 'path';

export interface ParsedHtmlMeta {
  /** Slash-command / registry key. From <meta name="cockpit-name">, else the filename. */
  name: string;
  /** Card title. From <title>, else the name. */
  title: string;
  /** From <meta name="description">. */
  description: string;
  /** From <meta name="cockpit-icon"> (emoji or url). */
  icon?: string;
  valid: boolean;
}

/**
 * Parse the <head> meta of an HTML file for the HTML-apps registry card.
 *
 * Mirrors parseSkillMd's shape/fallbacks. Reads a bounded prefix of the file
 * (the head is at the top) and scrapes tags by regex — no DOM needed.
 *
 * Fallbacks:
 *  - name  -> filename without extension (e.g. "trace-viewer")
 *  - title -> name
 *  - description -> ""
 *  - icon  -> undefined
 */
export async function parseHtmlMeta(absPath: string): Promise<ParsedHtmlMeta> {
  if (!absPath || !existsSync(absPath)) return makeInvalid(absPath);

  let raw: string;
  try {
    raw = await readFile(absPath, 'utf-8');
  } catch {
    return makeInvalid(absPath);
  }

  // Only the head matters; cap the scan so a huge body isn't regex-scanned.
  const head = raw.slice(0, 64 * 1024);
  const fallbackName = basename(absPath, extname(absPath)) || basename(absPath);

  const metaName = getMeta(head, 'cockpit-name');
  const title = getTitle(head);
  return {
    name: sanitizeName(metaName) || fallbackName,
    title: title || sanitizeName(metaName) || fallbackName,
    description: getMeta(head, 'description') || '',
    icon: getMeta(head, 'cockpit-icon') || undefined,
    valid: true,
  };
}

function makeInvalid(absPath: string): ParsedHtmlMeta {
  const fallbackName = absPath ? basename(absPath, extname(absPath)) || basename(absPath) : 'unknown';
  return { name: fallbackName, title: fallbackName, description: '', icon: undefined, valid: false };
}

/** `<meta name="<key>" content="...">` (order-insensitive), first match. */
function getMeta(html: string, key: string): string {
  const re = new RegExp(
    `<meta\\b[^>]*\\bname\\s*=\\s*["']${escapeRe(key)}["'][^>]*\\bcontent\\s*=\\s*["']([^"']*)["']`,
    'i',
  );
  const m = html.match(re);
  if (m) return decodeEntities(m[1].trim());
  // content-before-name ordering
  const re2 = new RegExp(
    `<meta\\b[^>]*\\bcontent\\s*=\\s*["']([^"']*)["'][^>]*\\bname\\s*=\\s*["']${escapeRe(key)}["']`,
    'i',
  );
  const m2 = html.match(re2);
  return m2 ? decodeEntities(m2[1].trim()) : '';
}

function getTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1].trim().replace(/\s+/g, ' ')) : '';
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Minimal HTML entity decode for the few that show up in titles/descriptions. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Name is used as a `/<name>` trigger — keep only safe-to-type chars (matches parseSkillMd). */
function sanitizeName(name: string | undefined): string {
  if (!name) return '';
  return name.trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9\-_:.]/g, '');
}
