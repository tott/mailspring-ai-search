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

  /** Persist and load the indexing watermark (last indexed message date in ms). */
  private get watermarkPath(): string {
    return require('path').join(this.config.dbPath, 'watermark.json');
  }

  private loadWatermark(): number {
    try {
      const data = fs.readFileSync(this.watermarkPath, 'utf8');
      return JSON.parse(data).lastDateMs || 0;
    } catch {
      return 0;
    }
  }

  private saveWatermark(lastDateMs: number): void {
    try {
      fs.writeFileSync(this.watermarkPath, JSON.stringify({ lastDateMs }));
    } catch { /* non-fatal */ }
  }

  /**
   * Index all messages from Mailspring's DatabaseStore.
   * On incremental runs (index already exists), only fetches messages
   * newer than the most recently indexed message — avoids scanning the
   * full mailbox on every startup.
   */
  async indexAll(DatabaseStore: any, Message: any): Promise<void> {
    await this.openDB();

    let lastDateMs = this.loadWatermark();

    // If no watermark file exists but the table has data, seed the watermark
    // from the most recent date in the index so the next run is incremental
    if (lastDateMs === 0) {
      try {
        const rows = await this.table.search().select(['date']).limit(1).toArray();
        if (rows.length > 0) {
          const d = rows[0].date;
          lastDateMs = typeof d === 'bigint' ? Number(d) : (d || 0);
          // Take a broader sample to find the actual max (first result is most recent due to desc order)
          const sample = await this.table.search().select(['date']).limit(1000).toArray();
          const sampleMax = Math.max(...sample.map((r: any) => typeof r.date === 'bigint' ? Number(r.date) : (r.date || 0)));
          if (sampleMax > lastDateMs) lastDateMs = sampleMax;
          if (lastDateMs > 0) {
            this.saveWatermark(lastDateMs);
            logger.info(`Seeded watermark from existing index: ${new Date(lastDateMs).toISOString()}`);
          }
        }
      } catch { /* index may be empty */ }
    }

    const isIncremental = lastDateMs > 0;

    // For incremental runs, only fetch messages newer than the watermark.
    // Subtract 5 minutes to catch messages with slightly out-of-order timestamps.
    const sinceMs = isIncremental ? lastDateMs - 5 * 60 * 1000 : 0;
    // Mailspring's date attribute is in seconds, not milliseconds
    const sinceSec = Math.floor(sinceMs / 1000);

    const BATCH = 200;
    const MAX_CHARS = 6000;
    let offset = 0;
    let total = 0;
    let chunksWritten = 0;
    const startTime = Date.now();
    let maxDateMsSeen = lastDateMs;

    // For incremental runs, load only IDs in the recent window to skip already-indexed ones
    let indexedIds = new Set<string>();
    if (isIncremental) {
      try {
        const rows = await this.table.query()
          .select(['mailspring_id'])
          .where(`date >= ${sinceMs}`)
          .toArray();
        indexedIds = new Set(rows.map((r: any) => r.mailspring_id as string));
        logger.info(`Incremental index: since ${new Date(sinceMs).toISOString()}, ${indexedIds.size} already indexed in window`);
      } catch { /* proceed without dedup — may re-embed a few messages */ }
    }

    try {
      total = await DatabaseStore.count(Message)
        .where(Message.attributes.draft.equal(false))
        .then((n: number) => n);
    } catch { total = 0; }

    if (isIncremental) {
      logger.info(`Incremental index: watermark=${new Date(lastDateMs).toISOString()}, will stop early when reaching older messages`);
    }

    this.emit({ type: 'progress', phase: 'scan', processed: 0, total, chunksWritten, startTime });

    // Always fetch newest-first. For incremental runs, stop as soon as all
    // messages in a batch are older than the watermark (they're already indexed).
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

      // Incremental early exit: stop when the entire batch is older than the watermark.
      // Messages are newest-first, so once a full batch is all older, everything after is too.
      if (isIncremental && sinceMs > 0 && messages.length === BATCH) {
        const batchNewest = messages.reduce((max: number, msg: any) => {
          const d = msg.date instanceof Date ? msg.date.getTime() : Number(msg.date) * 1000;
          return d > max ? d : max;
        }, 0);
        if (batchNewest < sinceMs) {
          logger.info(`Incremental index: reached messages older than watermark at offset ${offset}, stopping early`);
          break;
        }
      }

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

        // Track watermark: keep the highest date seen across all processed messages
        for (const msg of messages) {
          indexedIds.add(msg.id);
          const msgDateMs = msg.date ? (msg.date instanceof Date ? msg.date.getTime() : Number(msg.date) * 1000) : 0;
          if (msgDateMs > maxDateMsSeen) maxDateMsSeen = msgDateMs;
        }

        // Save watermark after every write so restarts know where to resume
        if (maxDateMsSeen > lastDateMs) {
          this.saveWatermark(maxDateMsSeen);
        }
      } else {
        // Even if no new chunks, advance the watermark past messages we skipped
        for (const msg of messages) {
          const msgDateMs = msg.date ? (msg.date instanceof Date ? msg.date.getTime() : Number(msg.date) * 1000) : 0;
          if (msgDateMs > maxDateMsSeen) maxDateMsSeen = msgDateMs;
        }
        if (maxDateMsSeen > lastDateMs) {
          this.saveWatermark(maxDateMsSeen);
        }
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
