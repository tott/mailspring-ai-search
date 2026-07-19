/**
 * Mailspring AI Search Plugin — main entry point.
 *
 * Activates:
 *   - Background indexer (runs incrementally, picks up new mail)
 *   - AI search UI injected into the search toolbar
 *   - Settings panel in Preferences
 */

import { loadConfig, resolveDbPath } from './config/config-store';
import { createEmbeddingProvider } from './embedding/provider';
import { createLLMProvider } from './llm/provider';
import { Indexer } from './indexer/indexer';
import { SearchEngine } from './search/search-engine';
import { logger } from './utils/logger';

/* global AppEnv */
declare const AppEnv: any;

// Other APIs come from mailspring-exports
const {
  Actions,
  DatabaseStore,
  Message,
  ComponentRegistry,
  PreferencesUIStore,
} = require('mailspring-exports');

let indexer: Indexer | null = null;
let searchEngine: SearchEngine | null = null;
let indexingInProgress = false;
let disposables: Array<{ dispose(): void }> = [];
let lastProgress: { processed: number; total: number; chunksWritten: number; startTime: number } | null = null;
let needsReindex = false;

export function activate(): void {
  logger.info('Plugin activating...');

  initializeServices().catch(err => {
    logger.error(' Initialization failed:', err);
    AppEnv.showErrorDialog?.(`AI Search initialization failed: ${err.message}`);
  });

  // Register UI components
  registerUI();

  // Listen for new mail — index incrementally
  const unlisten = Actions.didReceiveNewMessages?.listen(onNewMessages);
  if (unlisten) disposables.push({ dispose: unlisten });
}

export function deactivate(): void {
  for (const d of disposables) d.dispose();
  disposables = [];
  indexer = null;
  searchEngine = null;
  logger.info('Plugin deactivated.');
}

// ── Service initialization ────────────────────────────────────────────────────

async function initializeServices(): Promise<void> {
  const config = loadConfig();
  config.dbPath = resolveDbPath();

  // Try to create providers — if credentials are missing, log a warning
  // and wait for the user to configure them via Preferences → AI Search.
  let embedder: any;
  let llm: any;
  try {
    [embedder, llm] = await Promise.all([
      createEmbeddingProvider(config.embedding),
      createLLMProvider(config.llm),
    ]);
    // Warm up to get actual model dimensions before any schema creation
    await embedder.warmup();
    logger.info(`Embedding provider ready: ${(config.embedding as any).model} (${embedder.dimensions}-dim)`);
  } catch (e: any) {
    logger.warn(`Providers not configured yet: ${e.message}. Open Preferences → AI Search to configure.`);
    return; // Plugin stays active — user can configure via Settings
  }

  const lancedb = require('@lancedb/lancedb');
  const { mkdirSync } = require('fs');
  mkdirSync(config.dbPath, { recursive: true });
  const db = await lancedb.connect(config.dbPath);

  let table: any = null;
  try {
    const tables = await db.tableNames();
    if (tables.includes('emails')) {
      table = await db.openTable('emails');

      // Detect embedding dimension mismatch
      try {
        const schema = table.schema;
        const vectorField = schema?.fields?.find((f: any) => f.name === 'vector');
        const storedDim = vectorField?.type?.listSize ?? 0;
        if (storedDim > 0 && storedDim !== embedder.dimensions) {
          logger.warn(
            `Embedding dimension mismatch: index has ${storedDim}-dim vectors but ` +
            `${(config.embedding as any).model} produces ${embedder.dimensions}-dim. ` +
            `A reindex is required.`
          );
          needsReindex = true;
        }
      } catch { /* schema check failed — proceed */ }
    }
  } catch (e: any) {
    // Table doesn't exist yet — indexer will create it on first run
    logger.debug(`No emails table yet: ${e.message}`);
    table = null;
  }

  indexer = new Indexer(config, embedder, async (progress) => {
    if (progress.processed !== undefined && progress.total !== undefined) {
      lastProgress = {
        processed: progress.processed,
        total: progress.total,
        chunksWritten: progress.chunksWritten ?? 0,
        startTime: progress.startTime ?? Date.now(),
      };
    }
    // Enable search as soon as we have some indexed data (don't wait for full index)
    if (!searchEngine && (progress.chunksWritten ?? 0) > 0) {
      try {
        const lancedb = require('@lancedb/lancedb');
        const db = await lancedb.connect(config.dbPath);
        const t = await db.openTable('emails');
        searchEngine = new SearchEngine(t, embedder, llm, config);
        logger.info('Search engine ready (partial index).');
      } catch { /* not ready yet */ }
    }
    Actions.broadcastAISearchProgress?.(progress);
  });

  if (table) {
    searchEngine = new SearchEngine(table, embedder, llm, config);
  }

  // Start background indexing (non-blocking)
  startBackgroundIndex();
}

// ── Background indexing ───────────────────────────────────────────────────────

function startBackgroundIndex(): void {
  if (indexingInProgress || !indexer) return;
  indexingInProgress = true;

  // Use setImmediate to yield to the UI before starting
  setImmediate(async () => {
    try {
      logger.info('Starting background index...');
      await indexer!.indexAll(DatabaseStore, Message);
      logger.info('Background index complete.');

      // Reinitialize search engine now that the table exists
      if (!searchEngine) {
        try {
          const config = loadConfig();
          config.dbPath = resolveDbPath();
          const lancedb = require('@lancedb/lancedb');
          const db = await lancedb.connect(config.dbPath);
          const tables = await db.tableNames();
          if (tables.includes('emails')) {
            const table = await db.openTable('emails');
            const [embedder, llm] = await Promise.all([
              createEmbeddingProvider(config.embedding),
              createLLMProvider(config.llm),
            ]);
            searchEngine = new SearchEngine(table, embedder, llm, config);
            logger.info('Search engine ready.');
          }
        } catch (e: any) {
          logger.warn(`Could not initialize search engine after indexing: ${e.message}`);
        }
      }
    } catch (err: any) {
      logger.error(' Background index error:', err);
    } finally {
      indexingInProgress = false;
    }
  });
}

async function onNewMessages(messages: any[]): Promise<void> {
  if (!indexer) return;
  for (const msg of messages) {
    try {
      await indexer.indexMessage(msg);
    } catch (e) {
      logger.error(' Failed to index new message:', e);
    }
  }
}

// ── Public search API (called by UI components) ───────────────────────────────

export async function search(query: string) {
  // Always open a fresh table connection — prevents stale fragment references
  // after drop/reindex. Embedder and LLM are reused from the cached searchEngine.
  try {
    const config = loadConfig();
    config.dbPath = resolveDbPath();
    const lancedb = require('@lancedb/lancedb');
    const db = await lancedb.connect(config.dbPath);
    const tables = await db.tableNames();
    if (!tables.includes('emails')) {
      return { query, plan: null, results: [], error: 'Index not ready yet — still indexing.' };
    }
    const table = await db.openTable('emails');
    const rowCount = await table.countRows();
    if (rowCount < 2) {
      return { query, plan: null, results: [], error: `Index building... (${rowCount} chunks indexed so far)` };
    }
    // Reuse cached embedder/LLM if available, otherwise create fresh ones
    if (!searchEngine) {
      return { query, plan: null, results: [], error: 'Search engine initializing — try again in a moment.' };
    }
    // Create a fresh engine with the new table but same embedder/llm
    const freshEngine = new SearchEngine(table, (searchEngine as any).embedder, (searchEngine as any).llm, config);
    return freshEngine.search(query);
  } catch (e: any) {
    return { query, plan: null, results: [], error: e.message };
  }
}

export function isIndexReady(): boolean {
  return searchEngine !== null;
}

export function isIndexing(): boolean {
  return indexingInProgress;
}

export function getIndexProgress() {
  return lastProgress;
}

export function isReindexNeeded(): boolean {
  return needsReindex;
}

/** Drop the emails table and rebuild the index from scratch. */
export async function dropAndReindex(): Promise<void> {
  needsReindex = false;
  indexer = null;
  searchEngine = null;

  const config = loadConfig();
  config.dbPath = resolveDbPath();
  const lancedb = require('@lancedb/lancedb');
  const db = await lancedb.connect(config.dbPath);
  try {
    const tables = await db.tableNames();
    if (tables.includes('emails')) {
      await db.dropTable('emails');
      logger.info('Dropped emails table for reindex.');
    }
  } catch (e: any) {
    logger.warn(`Could not drop emails table: ${e.message} — proceeding anyway.`);
  }
  await reinitialize();
}

/** Re-initialize services after credentials are saved in Settings. */
export async function reinitialize(): Promise<void> {
  indexer = null;
  searchEngine = null;
  indexingInProgress = false; // allow startBackgroundIndex to run after reinit
  await initializeServices();
  if (indexer) startBackgroundIndex();
}

// ── UI registration ───────────────────────────────────────────────────────────

function registerUI(): void {
  // Register each component independently so one failure doesn't block others

  try {
    const { WorkspaceStore } = require('mailspring-exports');
    const { AISearchBar } = require('./ui/search-bar');
    // Register in the thread list toolbar — same area as the native search bar
    ComponentRegistry.register(AISearchBar, {
      location: WorkspaceStore.Location.ThreadList.Toolbar,
    });
    disposables.push({ dispose: () => ComponentRegistry.unregister(AISearchBar) });
  } catch (e) {
    logger.error('Search bar registration failed:', e);
  }

  try {
    PreferencesUIStore.registerPreferencesTab(new PreferencesUIStore.TabItem({
      tabId: 'AISearch',
      displayName: 'AI Search',
      componentClassFn: () => require('./ui/settings').AISearchSettings,
      order: 99,
    }));
    disposables.push({ dispose: () => PreferencesUIStore.unregisterPreferencesTab('AISearch') });
    logger.info('Preferences tab registered.');
  } catch (e) {
    logger.error('Preferences tab registration failed:', e);
  }
}
