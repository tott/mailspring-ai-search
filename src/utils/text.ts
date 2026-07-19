/**
 * Text processing utilities — HTML extraction, chunking, cleaning.
 * Pure functions, no external dependencies except html2text fallback.
 */

/**
 * Convert HTML email body to plain text using html2text.
 * Falls back to regex stripping if html2text is unavailable.
 */
function cleanEmailText(text: string): string {
  try {
    const he = require('he');
    text = he.decode(text);
  } catch { /* fallback: manual decode */ }
  return text
    // Strip zero-width/invisible characters used as spacers in HTML emails
    .replace(/[​‌‍­﻿⁠]/g, '')
    // Strip markdown image/link syntax left by html2text — keep the label text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    // Collapse runs of whitespace-only lines
    .replace(/^[ \t]*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function htmlToText(html: string): string {
  try {
    // html2text v6+ uses htmlToText(html, options) directly
    const { htmlToText: convert } = require('html2text');
    const raw = convert(html, {
      wordwrap: false,
      selectors: [
        { selector: 'img', format: 'skip' },
        { selector: 'script', format: 'skip' },
        { selector: 'style', format: 'skip' },
        { selector: 'a', options: { ignoreHref: true } },
      ],
    });
    return cleanEmailText(raw);
  } catch {
    // Regex fallback
    const he = require('he');
    let text = html
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/?(p|div|tr|li|h[1-6])[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ');
    try { text = he.decode(text); } catch { /* ignore */ }
    return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }
}

/**
 * Strip quoted reply lines (lines starting with ">").
 */
export function stripQuotedLines(text: string): string {
  return text
    .split('\n')
    .filter(line => !line.trimStart().startsWith('>'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Split text into semantically meaningful chunks at paragraph boundaries.
 * Overlap: the last paragraph of the previous chunk is prepended to the next.
 *
 * @param text       - Body text to chunk
 * @param metaHeader - Metadata header prepended to chunk 0 (Subject, From, etc.)
 * @param sourcePart - Label for this content source ('body', 'attachment:file.pdf')
 * @param targetChars - Target chunk size in characters (~600 tokens = ~2400 chars)
 */
export function contextualChunk(
  text: string,
  metaHeader: string,
  _sourcePart: string,
  targetChars = 2400,
): string[] {
  if (!text.trim()) {
    return metaHeader ? [metaHeader.trim()] : [];
  }

  const paragraphs = text.split(/\n\n+/).map(p => p.trim()).filter(Boolean);
  if (paragraphs.length === 0) {
    return [metaHeader ? `${metaHeader}\n\n${text}` : text];
  }

  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;
  let overlapPara = '';

  for (const para of paragraphs) {
    if (currentLen + para.length > targetChars && current.length > 0) {
      const body = current.join('\n\n');
      if (chunks.length === 0) {
        chunks.push(metaHeader ? `${metaHeader}\n\n${body}` : body);
      } else {
        const withOverlap = overlapPara ? `${overlapPara}\n\n${body}` : body;
        chunks.push(withOverlap.trim());
      }
      overlapPara = current[current.length - 1];
      current = [para];
      currentLen = para.length;
    } else {
      current.push(para);
      currentLen += para.length;
    }
  }

  if (current.length > 0) {
    const body = current.join('\n\n');
    if (chunks.length === 0) {
      chunks.push(metaHeader ? `${metaHeader}\n\n${body}` : body);
    } else {
      const withOverlap = overlapPara ? `${overlapPara}\n\n${body}` : body;
      chunks.push(withOverlap.trim());
    }
  }

  return chunks.filter(Boolean);
}

/**
 * Reciprocal Rank Fusion for combining vector and FTS results.
 */
export function rrf<T extends { id: string }>(
  vectorResults: T[],
  ftsResults: T[],
  k = 60,
): T[] {
  const scores = new Map<string, number>();
  const byId = new Map<string, T>();

  for (const [rank, item] of vectorResults.entries()) {
    scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (k + rank + 1));
    byId.set(item.id, item);
  }
  for (const [rank, item] of ftsResults.entries()) {
    scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (k + rank + 1));
    byId.set(item.id, item);
  }

  return [...byId.values()].sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0));
}
