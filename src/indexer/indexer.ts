/**
 * Background email indexer.
 * Reads messages from Mailspring's local SQLite DB via DatabaseStore,
 * extracts text content, chunks it, embeds it, and writes to LanceDB.
 * Runs inside the Mailspring renderer process; progress is reported via
 * the onProgress callback passed to the constructor.
 */

import * as fs from 'fs';

import type { EmbeddingProvider } from '../embedding/provider';
import type { PluginConfig } from '../config/types';
import { htmlToText, contextualChunk, stripQuotedLines } from '../utils/text';
import { logger } from '../utils/logger';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface IndexerProgress {
  type: 'progress' | 'done' | 'error';
  account?: string;
  phase?: 'scan' | 'extract' | 'embed' | 'write';
  processed?: number;
  total?: number;
  chunksWritten?: number;
  startTime?: number;
  error?: string;
}

export interface MessageChunk {
  message_id: string;   // headerMessageId (RFC 2822)
  mailspring_id: string; // Mailspring internal UUID
  thread_id: string;
  account_id: string;
  from_addr: string;
  to_addrs: string;
  cc_addrs: string;
  subject: string;
  date: number;         // unix timestamp ms
  labels: string[];
  has_attachments: boolean;
  source_part: string;  // 'body' | 'attachment:filename'
  chunk_index: number;
  chunk_text: string;
  vector: number[];
}

// ── LanceDB schema ────────────────────────────────────────────────────────────

// We use the arrow schema lazily to avoid loading it at import time
function buildSchema(dimensions: number) {
  const arrow = require('apache-arrow');
  return new arrow.Schema([
    new arrow.Field('message_id',     new arrow.Utf8(),    false),
    new arrow.Field('mailspring_id',  new arrow.Utf8(),    false),
    new arrow.Field('thread_id',      new arrow.Utf8(),    false),
    new arrow.Field('account_id',     new arrow.Utf8(),    false),
    new arrow.Field('from_addr',      new arrow.Utf8(),    true),
    new arrow.Field('to_addrs',       new arrow.Utf8(),    true),
    new arrow.Field('cc_addrs',       new arrow.Utf8(),    true),
    new arrow.Field('subject',        new arrow.Utf8(),    true),
    new arrow.Field('date',           new arrow.Int64(),   true),
    new arrow.Field('labels',         new arrow.List(new arrow.Field('item', new arrow.Utf8())), true),
    new arrow.Field('has_attachments',new arrow.Bool(),    true),
    new arrow.Field('source_part',    new arrow.Utf8(),    true),
    new arrow.Field('chunk_index',    new arrow.Int32(),   false),
    new arrow.Field('chunk_text',     new arrow.Utf8(),    false),
    new arrow.Field('vector',         new arrow.FixedSizeList(dimensions, new arrow.Field('item', new arrow.Float32())), false),
  ]);
}

// ── Text extraction ───────────────────────────────────────────────────────────

function extractBodyText(message: any): string {
  const body: string = message.body || '';
  if (!body) return '';

  const isHtml = !message.plaintext && (body.includes('<') || body.includes('&'));
  const text = isHtml ? htmlToText(body) : body;
  return stripQuotedLines(text);
}

function buildChunks(message: any, config: PluginConfig): Array<Omit<MessageChunk, 'vector'>> {
  const subject = message.subject || '';
  const fromAddr = (message.from || []).map((c: any) => c.email || String(c)).join(', ');
  const toAddrs  = (message.to   || []).map((c: any) => c.email || String(c)).join(', ');
  const ccAddrs  = (message.cc   || []).map((c: any) => c.email || String(c)).join(', ');
  const dateMs   = message.date instanceof Date ? message.date.getTime() : (Number(message.date) || 0);
  const labels   = (message.labels || message.categories || []).map((l: any) => l.displayName || String(l));
  const hasAtt   = (message.files || []).length > 0;

  const metaHeader = [
    `Subject: ${subject}`,
    `From: ${fromAddr}`,
    `To: ${toAddrs}`,
    `Date: ${new Date(dateMs).toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    `Labels: ${labels.join(', ')}`,
  ].join('\n');

  const bodyText = extractBodyText(message);
  const textChunks = contextualChunk(bodyText, metaHeader, 'body', config.indexing.chunkSize);

  const base = {
    message_id:    message.headerMessageId || `mailspring-${message.id}`,
    mailspring_id: message.id,
    thread_id:     message.threadId || '',
    account_id:    message.accountId || '',
    from_addr:     fromAddr,
    to_addrs:      toAddrs,
    cc_addrs:      ccAddrs,
    subject,
    date:          dateMs,
    labels,
    has_attachments: hasAtt,
  };

  const chunks: Array<Omit<MessageChunk, 'vector'>> = textChunks.map((t, i) => ({
    ...base,
    source_part:  'body',
    chunk_index:  i,
    chunk_text:   t,
  }));

  // If no text extracted, still index with just the metadata header
  if (chunks.length === 0) {
    chunks.push({ ...base, source_part: 'body', chunk_index: 0, chunk_text: metaHeader });
  }

  // Index attachments that are already cached locally
  if (config.indexing.indexAttachments && message.files?.length > 0) {
    const { AttachmentStore } = require('mailspring-exports');
    const fs = require('fs');

    for (const file of message.files) {
      const localPath = AttachmentStore.pathForFile(file);
      if (!localPath || !fs.existsSync(localPath)) continue;  // not downloaded

      const { size = 0 } = file;
      if (size > config.indexing.maxAttachmentBytes) continue;  // too large

      const ext = (file.filename || '').split('.').pop()?.toLowerCase() || '';
      const supported = ['pdf', 'docx', 'doc', 'odt', 'rtf', 'xlsx', 'xls', 'csv', 'pptx', 'txt', 'md', 'eml'];
      if (!supported.includes(ext)) continue;

      const attText = extractAttachmentText(localPath, ext);
      if (!attText || attText.trim().length < 50) continue;

      const attHeader = `${metaHeader}\n[Attachment: ${file.filename}]`;
      const attChunks = contextualChunk(attText, attHeader, `attachment:${file.filename}`, config.indexing.chunkSize);
      for (const t of attChunks) {
        chunks.push({ ...base, source_part: `attachment:${file.filename}`, chunk_index: chunks.length, chunk_text: t });
      }
    }
  }

  return chunks;
}

function extractAttachmentText(filePath: string, ext: string): string {
  // Use spawnSync (not execSync) to avoid shell injection via filenames
  const { spawnSync } = require('child_process');

  try {
    if (['txt', 'md', 'csv'].includes(ext)) {
      return fs.readFileSync(filePath, 'utf8');
    }

    // markitdown handles PDF/DOCX/XLSX — pass path as argument, not via shell
    try {
      const r = spawnSync(
        'python3',
        ['-c', `from markitdown import MarkItDown; m=MarkItDown(); r=m.convert(${JSON.stringify(filePath)}); print(r.text_content)`],
        { encoding: 'utf8', timeout: 15000 }
      );
      if (r.status === 0 && r.stdout && r.stdout.trim().length > 50) return r.stdout.trim();
    } catch { /* fall through to pandoc */ }

    if (['pdf', 'docx', 'doc', 'odt', 'rtf', 'pptx'].includes(ext)) {
      const r = spawnSync('pandoc', [filePath, '-t', 'plain', '--wrap=none'], { encoding: 'utf8', timeout: 15000 });
      if (r.status === 0 && r.stdout) return r.stdout.trim();
    }
  } catch { /* attachment extraction failed — skip */ }

  return '';
}

// ── Main indexer class ────────────────────────────────────────────────────────

export class Indexer {
  private lancedb: any = null;
  private table: any = null;

  constructor(
    private config: PluginConfig,
    private embedder: EmbeddingProvider,
    private onProgress?: (p: IndexerProgress) => void,
  ) {}

  private emit(progress: IndexerProgress) {
    this.onProgress?.(progress);
  }

  private async openDB(): Promise<void> {
    const lancedb = require('@lancedb/lancedb');
    const dbPath = this.config.dbPath;
    fs.mkdirSync(dbPath, { recursive: true });

    // Always create a fresh connection to avoid stale table cache
    this.lancedb = await lancedb.connect(dbPath);

    // Retry once — LanceDB sometimes returns stale tableNames after a drop
    for (let attempt = 0; attempt < 2; attempt++) {
      const tables = await this.lancedb.tableNames();
      if (tables.includes('emails')) {
        try {
          this.table = await this.lancedb.openTable('emails');
          return;
        } catch {
          // Table listed but not accessible — drop and recreate
          try { await this.lancedb.dropTable('emails'); } catch { /* ignore */ }
        }
      }
      // Create fresh table
      this.table = await this.lancedb.createTable('emails', [],
        { schema: buildSchema(this.embedder.dimensions) }
      );
      return;
    }
  }

  /** Return set of already-indexed mailspring message IDs */
  private async loadIndexedIds(): Promise<Set<string>> {
    try {
      const rows = await this.table.query().select(['mailspring_id']).toArray();
      return new Set(rows.map((r: any) => r.mailspring_id));
    } catch {
      return new Set();
    }
  }

  /**
   * Index all messages from Mailspring's DatabaseStore.
   * Must be called from within a Mailspring plugin context where
   * DatabaseStore and Message are available globally.
   */
  async indexAll(DatabaseStore: any, Message: any): Promise<void> {
    await this.openDB();
    const indexedIds = await this.loadIndexedIds();

    const BATCH = 200;
    const MAX_CHARS = 6000;
    let offset = 0;
    let total = 0;
    let chunksWritten = 0;
    const startTime = Date.now();

    try {
      total = await DatabaseStore.count(Message)
        .where(Message.attributes.draft.equal(false))
        .then((n: number) => n);
    } catch { total = 0; }

    this.emit({ type: 'progress', phase: 'scan', processed: 0, total, chunksWritten, startTime });

    const fetchBatch = (off: number) => DatabaseStore
      .findAll(Message)
      .where(Message.attributes.draft.equal(false))
      .include(Message.attributes.body)
      .order(Message.attributes.date.descending())
      .limit(BATCH)
      .offset(off)
      .background();

    const extractChunks = (messages: any[]) => {
      const allChunks: Array<Omit<MessageChunk, 'vector'>> = [];
      for (const msg of messages.filter(m => !indexedIds.has(m.id))) {
        for (const chunk of buildChunks(msg, this.config)) {
          allChunks.push(chunk);
        }
      }
      return allChunks;
    };

    const embedChunks = async (chunks: Array<Omit<MessageChunk, 'vector'>>) => {
      const texts = chunks.map(c =>
        c.chunk_text.length > MAX_CHARS ? c.chunk_text.slice(0, MAX_CHARS) : c.chunk_text
      );
      try {
        return await this.embedder.embed(texts);
      } catch {
        // Fallback: embed individually with aggressive truncation
        const vecs: number[][] = [];
        for (const text of texts) {
          try { vecs.push((await this.embedder.embed([text.slice(0, 2000)]))[0]); }
          catch { vecs.push(new Array(this.embedder.dimensions).fill(0)); }
        }
        return vecs;
      }
    };

    // Pipeline: fetch next batch while embedding current batch
    let nextFetch = fetchBatch(0);

    while (true) {
      const messages: any[] = await nextFetch;
      if (messages.length === 0) break;

      // Start fetching the next batch immediately (overlaps with embed+write below)
      nextFetch = fetchBatch(offset + BATCH);

      const allChunks = extractChunks(messages);

      if (allChunks.length > 0) {
        this.emit({ type: 'progress', phase: 'embed', processed: offset, total });

        // Embed and fetch next batch run in parallel
        const vectors = await embedChunks(allChunks);

        // Attach vectors and write
        const rows: MessageChunk[] = allChunks.map((chunk, i) => ({
          ...chunk,
          vector: vectors[i],
        }));

        this.emit({ type: 'progress', phase: 'write', processed: offset, total });
        await this.table.add(rows);

        // Optimize every 10 batches to prevent fragment buildup that causes panics
        if (offset > 0 && offset % (BATCH * 10) === 0) {
          try { await this.table.optimize(); } catch { /* non-fatal */ }
        }
        chunksWritten += rows.length;

        // Track all messages from this batch as indexed
        for (const msg of messages) indexedIds.add(msg.id);
      }

      offset += BATCH;
      this.emit({ type: 'progress', phase: 'scan', processed: offset, total, chunksWritten, startTime });

      if (messages.length < BATCH) break;
    }

    this.emit({ type: 'done', processed: offset, total, chunksWritten, startTime });
  }

  /** Index a single message (called when Mailspring receives new mail) */
  async indexMessage(message: any): Promise<void> {
    if (!this.table) await this.openDB();

    const chunks = buildChunks(message, this.config);
    const texts = chunks.map(c => c.chunk_text);
    const vectors = await this.embedder.embed(texts);
    const rows: MessageChunk[] = chunks.map((chunk, i) => ({ ...chunk, vector: vectors[i] }));

    // Remove old chunks for this message if re-indexing
    try {
      await this.table.delete(`mailspring_id = '${message.id}'`);
    } catch { /* ignore */ }

    await this.table.add(rows);
  }
}
