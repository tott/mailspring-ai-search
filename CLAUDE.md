# mailspring-ai-search — Claude Code Instructions

## Project overview

A Mailspring plugin that adds AI-powered semantic email search. Written in TypeScript, runs inside Mailspring's Electron renderer process. Reads email data directly from Mailspring's local SQLite database — no IMAP, no duplicate storage.

## Repository layout

```
src/
  main.ts               Plugin entry point — activate(), deactivate(), public API
  config/
    types.ts            All provider/plugin config TypeScript types
    config-store.ts     Load/save config via AppEnv.config; credentials via OS keychain
  embedding/
    provider.ts         EmbeddingProvider interface + factory; supports OpenAI, Bedrock Titan, Ollama, Local ONNX
  llm/
    provider.ts         LLMProvider interface + factory; supports Anthropic, Bedrock, OpenAI, Ollama
  indexer/
    indexer.ts          Reads from Mailspring's DatabaseStore, chunks emails, embeds, writes LanceDB
  search/
    search-engine.ts    LLM query planning + hybrid vector/FTS search + synthesis
  utils/
    text.ts             htmlToText, contextualChunk, stripQuotedLines, rrf
    logger.ts           Structured logger — wraps console + AppEnv.reportError
  ui/
    search-bar.tsx      AI search bar React component (injected into toolbar)
    settings.tsx        Settings panel React component (injected into Preferences)
lib/                    TypeScript compiled output (gitignored, built via npm run build)
```

## Tech stack

- **Language**: TypeScript, compiled to CommonJS for Mailspring's Electron renderer
- **Plugin API**: `mailspring-exports` — `DatabaseStore`, `Message`, `Thread`, `Actions`, `ComponentRegistry`
- **Vector DB**: `@lancedb/lancedb` (Node.js client)
- **Embedding**: configurable — OpenAI / Bedrock Titan / Ollama / Local ONNX
- **LLM**: configurable — Anthropic / Bedrock / OpenAI / Ollama
- **Bundler**: none — TypeScript compiles directly to `lib/`

## Build commands

```bash
npm run build       # compile TypeScript → lib/
npm run watch       # compile in watch mode (development)
npm run test        # run unit tests (Jest)
npm run test:watch  # run tests in watch mode
npm run typecheck   # type-check without emitting files
npm run lint        # ESLint
```

## Tests

Unit tests cover pure logic that runs outside Mailspring: text utilities (`htmlToText`, `stripQuotedLines`, `contextualChunk`, `rrf`) and the search engine's query plan parsing and retry logic. Tests live in `specs/` and use Jest with `ts-jest`.

Mailspring globals (`DatabaseStore`, `AppEnv`, etc.) are stubbed in `specs/__mocks__/mailspring-exports.ts`.

Tests that require Mailspring internals (live indexing, database queries) are tested via the DevTools console after loading the plugin — see the Debugging section below.

## Running the plugin in Mailspring

1. Initial setup — copy the package into Mailspring's packages directory:
   ```bash
   cp -r . ~/.config/Mailspring/packages/mailspring-ai-search/
   ```
   **Do not symlink** — Electron cannot read `package.json` through a symlink at the directory level.

2. Build and sync: `npm run build:dev` — this compiles TypeScript and rsyncs `lib/` and `package.json` to `~/.config/Mailspring/packages/mailspring-ai-search/` automatically. (`npm run build` compiles only, without syncing — suitable for CI.)

3. Reload in Mailspring: Edit → Developer → Reload Package

For development with live reload:
```bash
npm run watch
# In Mailspring: Edit → Developer → Toggle Developer Tools
# Reload the plugin without restarting: Edit → Reload Package
```

## Debugging

### DevTools console
Launch Mailspring in dev mode for verbose output:
```bash
mailspring --dev
```
All plugin logs are prefixed `[ai-search]`. Open DevTools (Edit → Developer → Toggle Developer Tools) and filter by `[ai-search]`.

### Log levels
- `logger.debug(...)` — only in `--dev` mode; use for verbose tracing
- `logger.info(...)` — always logged; normal operational messages
- `logger.warn(...)` — always logged; unexpected but recoverable
- `logger.error(...)` — always logged + reported to `AppEnv.reportError()` with `pluginIds: ['mailspring-ai-search']`

### Dump log history to console
From the DevTools console:
```js
require('/path/to/lib/utils/logger').logger.dump()
```

### Check index state from DevTools console
```js
// How many messages indexed?
const lancedb = require('@lancedb/lancedb');
const db = await lancedb.connect(require('os').homedir() + '/.local/share/mailspring-ai-search');
const t = await db.openTable('emails');
console.log(await t.countRows());

// Sample a few chunks
const rows = await t.query().limit(5).toArray();
console.log(rows.map(r => ({ subject: r.subject, chunk: r.chunk_text.slice(0, 100) })));
```

### Test providers from DevTools console
```js
// Test embedding provider
const { createEmbeddingProvider } = require('./lib/embedding/provider');
const { loadConfig } = require('./lib/config/config-store');
const cfg = loadConfig();
const embedder = await createEmbeddingProvider(cfg.embedding);
const vecs = await embedder.embed(['test email content']);
console.log('Vector dim:', vecs[0].length);

// Test LLM provider
const { createLLMProvider } = require('./lib/llm/provider');
const llm = await createLLMProvider(cfg.llm);
const response = await llm.complete('You are a test assistant.', 'Say hello.');
console.log(response);

// Test search
const { search } = require('./lib/main');
const result = await search('emails from today');
console.log(JSON.stringify(result, null, 2));
```

## How it works

### Query planning
The search engine passes the user's natural language query and the LanceDB schema to the configured LLM. The LLM returns a JSON plan: an intent (`list`/`summarize`/`answer`/`open`), a SQL WHERE clause for structural constraints (sender, date, labels), and a semantic query string for vector search. The plugin executes the plan deterministically against LanceDB. This correctly handles queries like "flight from New York to London" (geographic — uses subject LIKE) vs "emails from Alice" (sender — uses from_addr filter).

### Credential storage
Credentials are stored in `AppEnv.config` under the key `mailspring-ai-search-credentials` — separate from general plugin config but using the same Mailspring config mechanism. Environment variables (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `AWS_BEARER_TOKEN_BEDROCK`, etc.) take precedence over stored credentials, which is useful for development.

### Mailspring globals
`AppEnv` is set as `window.AppEnv` by Mailspring at startup — a true browser global available as a bare name in all plugin files. Declare it at the top of any file that uses it:
```ts
/* global AppEnv */
declare const AppEnv: any;
```

All other APIs come from `mailspring-exports`:
```ts
const { Actions, DatabaseStore, Message, ComponentRegistry } = require('mailspring-exports');
```

React also comes from `mailspring-exports`, but use a type-only import for TypeScript checking:
```ts
import type * as ReactTypes from 'react';
const React: typeof ReactTypes = require('mailspring-exports').React;
```
This pattern gives full TypeScript types at compile time while using Mailspring's bundled React at runtime.

## What NOT to do

- **Do not write** to `DatabaseStore` — the renderer DB connection is read-only
- **Do not** hardcode API endpoints — use the provider abstraction in `embedding/provider.ts` and `llm/provider.ts`
- **Do not** store credentials in `AppEnv.config` or any plain JSON — use `setCredential()` / `getCredential()` from `config-store.ts`
- **Do not** call `console.log` directly — use `logger` from `utils/logger.ts`
- **Do not** load all messages at once — the indexer pages through `DatabaseStore` in batches of 200 with `.background()`
- **Do not** block the UI thread with heavy computation — use `setImmediate()` or `process.nextTick()` to yield

## Adding a new provider

### New embedding provider
1. Add the config type to `src/config/types.ts` (`EmbeddingProvider` union + interface)
2. Implement the `EmbeddingProvider` interface in `src/embedding/provider.ts`
3. Add a case to the `createEmbeddingProvider` factory function
4. Add the option to the settings dropdown in `src/ui/settings.tsx`

### New LLM provider
Same pattern in `src/llm/provider.ts` and `LLMProvider` interface.
