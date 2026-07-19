// Types only — React runtime comes from mailspring-exports
import type * as ReactTypes from 'react';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const React: typeof ReactTypes = require('mailspring-exports').React;
const { useState, useEffect } = React;
import {
  loadConfig, saveConfig, setCredential, getCredential, resolveDbPath,
} from '../config/config-store';
import type { PluginConfig } from '../config/types';

// Default models per provider
const EMBEDDING_DEFAULTS: Record<string, { model: string; region?: string }> = {
  'ollama':        { model: 'bge-m3' },
  'openai':        { model: 'text-embedding-3-small' },
  'bedrock-titan': { model: 'amazon.titan-embed-text-v2:0', region: 'us-east-1' },
  'local-onnx':    { model: 'Xenova/bge-base-en-v1.5' },
};

const LLM_DEFAULTS: Record<string, { model: string; region?: string; maxTokens: number }> = {
  'ollama':     { model: 'llama3.2',                           maxTokens: 1024 },
  'anthropic':  { model: 'claude-haiku-4-5-20251001',          maxTokens: 1024 },
  'bedrock':    { model: 'us.anthropic.claude-sonnet-4-6',      maxTokens: 1024, region: 'us-east-1' },
  'openai':     { model: 'gpt-4o-mini',                        maxTokens: 1024 },
};

export class AISearchSettings extends React.Component {
  static displayName = 'AISearchSettings';
  render() { return <AISearchSettingsPanel />; }
}

function AISearchSettingsPanel() {
  const [config, setConfig] = useState<PluginConfig>(loadConfig);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [status, setStatus] = useState('');
  const [indexStatus, setIndexStatus] = useState<{
    chunks: number; indexing: boolean; ready: boolean;
    processed: number; total: number; etaSecs: number | null;
    needsReindex: boolean;
  }>({ chunks: 0, indexing: false, ready: false, processed: 0, total: 0, etaSecs: null, needsReindex: false });

  useEffect(() => {
    const update = async () => {
      try {
        const main = require('../main');
        const lancedb = require('@lancedb/lancedb');
        const dbPath = resolveDbPath();
        const db = await lancedb.connect(dbPath);
        const tables = await db.tableNames();
        let chunks = 0;
        let uniqueMessages = 0;
        if (tables.includes('emails')) {
          const tbl = await db.openTable('emails');
          chunks = await tbl.countRows();
          // Count unique messages (chunk_index=0 = one row per message)
          try {
            const r = await tbl.query().where('chunk_index = 0').select(['mailspring_id']).toArray();
            uniqueMessages = r.length;
          } catch { uniqueMessages = Math.round(chunks / 1.7); }
        }
        const prog = main.getIndexProgress?.();
        let etaSecs: number | null = null;
        // Use session progress for ETA
        if (prog && prog.processed > 0 && prog.total > prog.processed) {
          const elapsed = (Date.now() - prog.startTime) / 1000;
          const rate = prog.processed / elapsed;
          etaSecs = Math.round((prog.total - prog.processed) / rate);
        }
        setIndexStatus({
          chunks: uniqueMessages, // show messages not chunks
          indexing: main.isIndexing(),
          ready: main.isIndexReady(),
          processed: prog?.processed ?? 0,
          total: prog?.total ?? 0,
          etaSecs,
          needsReindex: main.isReindexNeeded?.() ?? false,
        });
      } catch { /* DB not ready yet */ }
    };
    update();
    const interval = setInterval(update, 3000);
    return () => clearInterval(interval);
  }, []);

  // Load existing credential hints (show *** if set, empty if not)
  useEffect(() => {
    const keys = ['openai-api-key', 'anthropic-api-key', 'aws-bearer-token-bedrock',
                  'aws-access-key-id', 'aws-secret-access-key'];
    Promise.all(keys.map(async k => ({ k, v: await getCredential(k) }))).then(results => {
      const hints: Record<string, string> = {};
      for (const { k, v } of results) {
        if (v) hints[k] = ''; // show empty so user can re-enter; placeholder shows "already set"
      }
      setCredentials(hints);
    });
  }, []);

  const handleEmbeddingProviderChange = (provider: string) => {
    const defaults = EMBEDDING_DEFAULTS[provider] || {};
    setConfig(c => ({
      ...c,
      embedding: {
        provider,
        model: defaults.model || '',
        ...(defaults.region ? { region: defaults.region } : {}),
        baseUrl: provider === 'ollama' ? 'http://localhost:11434' : undefined,
      } as any,
    }));
  };

  const handleLLMProviderChange = (provider: string) => {
    const defaults = LLM_DEFAULTS[provider] || { maxTokens: 1024 };
    setConfig(c => ({
      ...c,
      llm: {
        provider,
        model: defaults.model || '',
        maxTokens: defaults.maxTokens,
        ...(defaults.region ? { region: defaults.region } : {}),
        baseUrl: provider === 'ollama' ? 'http://localhost:11434' : undefined,
      } as any,
    }));
  };

  const handleSave = async () => {
    saveConfig(config);
    for (const [key, value] of Object.entries(credentials)) {
      if (value.trim()) await setCredential(key, value.trim());
    }
    setSaved(true);
    setStatus('Saved. Reinitializing...');
    try {
      const main = require('../main');
      await main.reinitialize();
      setStatus(main.isIndexReady() ? 'Ready — indexing your email.' : 'Saved. Indexing will start shortly.');
    } catch (e: any) {
      setStatus(`Saved, but init failed: ${e.message}`);
    }
    setTimeout(() => { setSaved(false); setStatus(''); }, 4000);
  };

  const embProvider = (config.embedding as any).provider;
  const llmProvider = (config.llm as any).provider;

  return (
    <div style={{ padding: 24, maxWidth: 600, fontFamily: 'inherit' }}>
      <h2 style={{ marginTop: 0 }}>AI Search Settings</h2>

      {/* ── Embedding Provider ────────────────────────────────────────── */}
      <section style={{ marginBottom: 28 }}>
        <h3 style={{ marginBottom: 4 }}>Embedding Provider</h3>
        <p style={{ color: '#888', marginTop: 0, marginBottom: 12, fontSize: 13 }}>
          Converts email text to vectors for semantic search.
        </p>

        <label style={labelStyle}>Provider
          <select value={embProvider} onChange={e => handleEmbeddingProviderChange(e.target.value)} style={selectStyle}>
            <option value="local-onnx">Local ONNX (offline, no API key)</option>
            <option value="ollama">Ollama (local)</option>
            <option value="openai">OpenAI</option>
            <option value="bedrock-titan">AWS Bedrock (Titan)</option>
          </select>
        </label>

        <label style={labelStyle}>Model
          <input style={inputStyle} value={(config.embedding as any).model || ''}
            onChange={e => setConfig(c => ({ ...c, embedding: { ...c.embedding, model: e.target.value } as any }))} />
        </label>

        {(embProvider === 'bedrock-titan') && <>
          <label style={labelStyle}>AWS Region
            <input style={inputStyle} value={(config.embedding as any).region || 'us-east-1'}
              onChange={e => setConfig(c => ({ ...c, embedding: { ...c.embedding, region: e.target.value } as any }))} />
          </label>
          <CredField label="AWS Bearer Token" credKey="aws-bearer-token-bedrock"
            credentials={credentials} setCredentials={setCredentials} />
        </>}

        {embProvider === 'openai' && <>
          <CredField label="OpenAI API Key" credKey="openai-api-key"
            credentials={credentials} setCredentials={setCredentials} />
          <label style={labelStyle}>Custom Base URL (optional)
            <input style={inputStyle} placeholder="https://api.openai.com/v1"
              value={(config.embedding as any).baseUrl || ''}
              onChange={e => setConfig(c => ({ ...c, embedding: { ...c.embedding, baseUrl: e.target.value } as any }))} />
          </label>
        </>}

        {embProvider === 'ollama' && <label style={labelStyle}>Ollama URL
          <input style={inputStyle} value={(config.embedding as any).baseUrl || 'http://localhost:11434'}
            onChange={e => setConfig(c => ({ ...c, embedding: { ...c.embedding, baseUrl: e.target.value } as any }))} />
        </label>}
      </section>

      {/* ── LLM Provider ──────────────────────────────────────────────── */}
      <section style={{ marginBottom: 28 }}>
        <h3 style={{ marginBottom: 4 }}>LLM Provider</h3>
        <p style={{ color: '#888', marginTop: 0, marginBottom: 12, fontSize: 13 }}>
          Understands your queries and synthesises answers from results.
        </p>

        <label style={labelStyle}>Provider
          <select value={llmProvider} onChange={e => handleLLMProviderChange(e.target.value)} style={selectStyle}>
            <option value="ollama">Ollama (local)</option>
            <option value="anthropic">Anthropic</option>
            <option value="bedrock">AWS Bedrock (Claude)</option>
            <option value="openai">OpenAI</option>
          </select>
        </label>

        <label style={labelStyle}>Model
          <input style={inputStyle} value={(config.llm as any).model || ''}
            onChange={e => setConfig(c => ({ ...c, llm: { ...c.llm, model: e.target.value } as any }))} />
        </label>

        {llmProvider === 'bedrock' && <>
          <label style={labelStyle}>AWS Region
            <input style={inputStyle} value={(config.llm as any).region || 'us-east-1'}
              onChange={e => setConfig(c => ({ ...c, llm: { ...c.llm, region: e.target.value } as any }))} />
          </label>
          <CredField label="AWS Bearer Token" credKey="aws-bearer-token-bedrock"
            credentials={credentials} setCredentials={setCredentials} />
        </>}

        {llmProvider === 'anthropic' && <>
          <CredField label="Anthropic API Key" credKey="anthropic-api-key"
            credentials={credentials} setCredentials={setCredentials} />
        </>}

        {llmProvider === 'openai' && <>
          <CredField label="OpenAI API Key" credKey="openai-api-key"
            credentials={credentials} setCredentials={setCredentials} />
          <label style={labelStyle}>Custom Base URL (optional)
            <input style={inputStyle} placeholder="https://api.openai.com/v1"
              value={(config.llm as any).baseUrl || ''}
              onChange={e => setConfig(c => ({ ...c, llm: { ...c.llm, baseUrl: e.target.value } as any }))} />
          </label>
        </>}

        {llmProvider === 'ollama' && <label style={labelStyle}>Ollama URL
          <input style={inputStyle} value={(config.llm as any).baseUrl || 'http://localhost:11434'}
            onChange={e => setConfig(c => ({ ...c, llm: { ...c.llm, baseUrl: e.target.value } as any }))} />
        </label>}
      </section>

      {/* ── Index status ───────────────────────────────────────────────── */}
      <section style={{ marginBottom: 24, padding: '12px 16px', background: '#1a1a1a', borderRadius: 6, border: `1px solid ${indexStatus.needsReindex ? '#b45309' : '#333'}` }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Index Status</div>

        {indexStatus.needsReindex && (
          <div style={{ marginBottom: 10, padding: '8px 12px', background: '#451a03', borderRadius: 4, border: '1px solid #b45309' }}>
            <div style={{ fontSize: 13, color: '#fbbf24', fontWeight: 600, marginBottom: 4 }}>
              ⚠ Reindex required
            </div>
            <div style={{ fontSize: 12, color: '#d97706', marginBottom: 8 }}>
              The embedding model has changed. The existing index uses different vector dimensions
              and must be rebuilt before search will work correctly.
            </div>
            <button
              onClick={async () => {
                const main = require('../main');
                setStatus('Dropping index and rebuilding...');
                await main.dropAndReindex();
              }}
              style={{ ...btnStyle, background: '#b45309', fontSize: 12, padding: '5px 14px' }}
            >
              Reindex Now
            </button>
          </div>
        )}

        <div style={{ fontSize: 13, color: '#aaa', display: 'flex', flexDirection: 'column' as const, gap: 6 }}>
          <div style={{ display: 'flex', gap: 16 }}>
            <span style={{ color: indexStatus.indexing ? '#4a9eff' : indexStatus.ready ? '#4caf50' : '#888' }}>
              {indexStatus.indexing ? '⟳ Indexing...' : indexStatus.ready ? '✓ Ready' : '○ Not started'}
            </span>
            <span>{indexStatus.chunks.toLocaleString()} messages indexed</span>
          </div>
          {indexStatus.indexing && indexStatus.total > 0 && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span>{indexStatus.processed.toLocaleString()} / {indexStatus.total.toLocaleString()} messages</span>
                {indexStatus.etaSecs !== null && (
                  <span>ETA: {indexStatus.etaSecs >= 3600
                    ? `${Math.floor(indexStatus.etaSecs / 3600)}h ${Math.floor((indexStatus.etaSecs % 3600) / 60)}m`
                    : indexStatus.etaSecs >= 60
                      ? `${Math.floor(indexStatus.etaSecs / 60)}m ${indexStatus.etaSecs % 60}s`
                      : `${indexStatus.etaSecs}s`}
                  </span>
                )}
              </div>
              <div style={{ background: '#333', borderRadius: 3, height: 4, overflow: 'hidden' }}>
                <div style={{
                  background: '#4a9eff', height: '100%', borderRadius: 3,
                  width: `${Math.round((indexStatus.processed / indexStatus.total) * 100)}%`,
                  transition: 'width 0.5s ease',
                }} />
              </div>
            </div>
          )}
        </div>
      </section>

      {/* ── User context ───────────────────────────────────────────────── */}
      <section style={{ marginBottom: 24 }}>
        <h3 style={{ marginBottom: 4 }}>Your Details</h3>
        <p style={{ color: '#888', marginTop: 0, marginBottom: 12, fontSize: 13 }}>
          Used to personalise AI answers and summaries. Name and email are auto-detected from your Mailspring accounts.
        </p>
        <label style={labelStyle}>Name
          <input style={inputStyle}
            value={config.userContext?.name || ''}
            placeholder="Auto-detected from Mailspring"
            onChange={e => setConfig((c: any) => ({ ...c, userContext: { ...c.userContext, name: e.target.value } }))}
          />
        </label>
        <label style={labelStyle}>Location (city / timezone)
          <input style={inputStyle}
            value={config.userContext?.location || ''}
            placeholder="e.g. Berlin, Germany"
            onChange={e => setConfig((c: any) => ({ ...c, userContext: { ...c.userContext, location: e.target.value } }))}
          />
        </label>
      </section>

      <button onClick={handleSave} style={btnStyle}>
        {saved ? '✓ Saved' : 'Save & Apply'}
      </button>

      {status && <p style={{ marginTop: 12, color: '#aaa', fontSize: 13 }}>{status}</p>}
    </div>
  );
}

function CredField({ label, credKey, credentials, setCredentials }: {
  label: string;
  credKey: string;
  credentials: Record<string, string>;
  setCredentials: (fn: (c: Record<string, string>) => Record<string, string>) => void;
}) {
  return (
    <label style={labelStyle}>{label}
      <input
        type="password"
        style={inputStyle}
        placeholder={credKey in credentials ? '(already set — enter new value to update)' : 'Enter value'}
        value={credentials[credKey] || ''}
        onChange={e => setCredentials(c => ({ ...c, [credKey]: e.target.value }))}
        autoComplete="off"
      />
    </label>
  );
}

const labelStyle: any = {
  display: 'block', marginBottom: 10, fontSize: 13,
};
const inputStyle: any = {
  display: 'block', width: '100%', marginTop: 4, padding: '6px 8px',
  border: '1px solid #444', borderRadius: 4, background: '#222',
  color: '#eee', fontSize: 13, boxSizing: 'border-box',
};
const selectStyle: any = {
  ...inputStyle, cursor: 'pointer',
};
const btnStyle: any = {
  padding: '8px 20px', background: '#4a9eff', color: '#fff',
  border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 14,
  fontWeight: 600,
};
