// Types only — React runtime comes from mailspring-exports
import type * as ReactTypes from 'react';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const React: typeof ReactTypes = require('mailspring-exports').React;
const { useState, useRef, useEffect } = React;
import { search, isIndexReady, isIndexing } from '../main';

// ── Markdown rendering ────────────────────────────────────────────────────────

function MarkdownAnswer({ text }: { text: string }) {
  const { marked } = require('marked');
  const DOMPurify = require('dompurify');
  marked.setOptions({ breaks: true, gfm: true });
  const rawHtml = marked.parse(text) as string;
  // Sanitize before injecting — LLM output may contain prompt-injected HTML
  const html = DOMPurify.sanitize(rawHtml, { USE_PROFILES: { html: true } });
  return React.createElement('div', {
    dangerouslySetInnerHTML: { __html: html },
    style: { fontSize: 13, color: '#ddd', lineHeight: 1.6 },
    className: 'ai-search-markdown',
  });
}

// ── Search result component ───────────────────────────────────────────────────

function SearchResult({ result }: { result: any }) {
  const date = result.date ? new Date(result.date).toLocaleDateString() : '';

  const handleOpen = (e: any) => {
    e.preventDefault();
    const { Actions, DatabaseStore, Thread, Message } = require('mailspring-exports');
    const mailspringId = result.mailspring_id || result.mailspringId;
    const threadId = result.thread_id || result.threadId;

    // Prefer direct thread focus via Actions — opens inline preview without relaunching Mailspring
    if (threadId) {
      DatabaseStore.find(Thread, threadId)
        .then((thread: any) => {
          if (thread) {
            Actions.setFocus({ collection: 'thread', item: thread });
          } else if (mailspringId) {
            // Thread not found by id — fall back to finding via message
            return DatabaseStore.find(Message, mailspringId).then((msg: any) => {
              if (msg?.threadId) return DatabaseStore.find(Thread, msg.threadId);
            }).then((thread: any) => {
              if (thread) Actions.setFocus({ collection: 'thread', item: thread });
            });
          }
        })
        .catch(() => {
          // Last resort: open via URL scheme
          if (result.message_id) {
            const { shell } = require('electron');
            shell.openExternal(`mailspring://plugins?action=open-message&id=${encodeURIComponent(result.message_id)}`);
          }
        });
    } else if (result.message_id) {
      const { shell } = require('electron');
      shell.openExternal(`mailspring://plugins?action=open-message&id=${encodeURIComponent(result.message_id)}`);
    }
  };

  return (
    <div
      onClick={handleOpen}
      style={{
        padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid rgba(255,255,255,0.06)',
        transition: 'background 0.1s',
      }}
      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.06)')}
      onMouseLeave={e => (e.currentTarget.style.background = '')}
    >
      <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {result.subject || '(no subject)'}
      </div>
      <div style={{ fontSize: 12, color: '#888', display: 'flex', gap: 8 }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }}>
          {result.fromAddr || result.from_addr || ''}
        </span>
        <span>·</span>
        <span style={{ whiteSpace: 'nowrap' }}>{date}</span>
      </div>
      {result.snippet && (
        <div style={{ fontSize: 12, color: '#666', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {result.snippet}
        </div>
      )}
    </div>
  );
}

// ── Floating search panel ─────────────────────────────────────────────────────

function AISearchPanel({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<any[]>([]);
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const ready = isIndexReady();
  const indexing = isIndexing();

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const handleSearch = async (e: any) => {
    e.preventDefault();
    if (!query.trim() || loading) return;
    setLoading(true);
    setError(null);
    setAnswer(null);
    setResults([]);
    try {
      const resp = await (search as any)(query);
      setResults(resp.results || []);
      if (resp.answer) setAnswer(resp.answer);
      if (resp.error) setError(resp.error);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      position: 'fixed', top: 60, right: 16, width: 420, maxHeight: '80vh',
      background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.15)',
      borderRadius: 8, boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
      display: 'flex', flexDirection: 'column', zIndex: 9999,
      fontFamily: 'inherit',
    }}>
      {/* Markdown styles scoped to this panel */}
      <style>{`
        .ai-search-markdown p { margin: 4px 0; }
        .ai-search-markdown h1, .ai-search-markdown h2, .ai-search-markdown h3 {
          margin: 8px 0 4px; font-size: 14px; font-weight: 600; color: #eee;
        }
        .ai-search-markdown ul, .ai-search-markdown ol {
          margin: 4px 0; padding-left: 18px;
        }
        .ai-search-markdown li { margin: 2px 0; }
        .ai-search-markdown strong { color: #eee; font-weight: 600; }
        .ai-search-markdown a { color: #4a9eff; text-decoration: none; }
        .ai-search-markdown a:hover { text-decoration: underline; }
        .ai-search-markdown code {
          background: rgba(255,255,255,0.1); padding: 1px 4px;
          border-radius: 3px; font-size: 12px; font-family: monospace;
        }
        .ai-search-markdown hr { border: none; border-top: 1px solid rgba(255,255,255,0.1); margin: 8px 0; }
        .ai-search-markdown blockquote {
          border-left: 3px solid #4a9eff; margin: 4px 0; padding-left: 10px; color: #aaa;
        }
      `}</style>
      {/* Header */}
      <div style={{ padding: '12px 14px', borderBottom: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 16 }}>✦</span>
        <form onSubmit={handleSearch} style={{ flex: 1, display: 'flex', gap: 8 }}>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={indexing && !ready ? 'Indexing… search available soon' : 'Search your email with AI…'}
            disabled={loading}
            style={{
              flex: 1, background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 5, padding: '6px 10px', color: '#eee', fontSize: 13, outline: 'none',
            }}
          />
          <button type="submit" disabled={loading || !query.trim()} style={{
            background: loading ? '#333' : '#4a9eff', color: '#fff', border: 'none',
            borderRadius: 5, padding: '6px 12px', cursor: 'pointer', fontSize: 13, fontWeight: 600,
          }}>
            {loading ? '…' : 'Search'}
          </button>
        </form>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '2px 4px' }}>×</button>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {error && (
          <div style={{ padding: '10px 14px', color: '#f87171', fontSize: 13 }}>{error}</div>
        )}

        {answer && (
          <div style={{ padding: '12px 14px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
            <MarkdownAnswer text={answer} />
          </div>
        )}

        {results.length > 0 && (
          <div>
            {!answer && (
              <div style={{ padding: '6px 12px', fontSize: 11, color: '#555', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                {results.length} result{results.length !== 1 ? 's' : ''} — click to open in Mailspring
              </div>
            )}
            {results.map((r, i) => <SearchResult key={r.message_id || i} result={r} />)}
          </div>
        )}

        {!loading && !error && results.length === 0 && query && !answer && (
          <div style={{ padding: '20px', textAlign: 'center' as const, color: '#555', fontSize: 13 }}>
            No results found
          </div>
        )}

        {!query && !loading && (
          <div style={{ padding: '16px 14px', color: '#555', fontSize: 12, lineHeight: 1.8 }}>
            <div style={{ marginBottom: 8, color: '#666', fontWeight: 500 }}>Examples:</div>
            {[
              'emails from today',
              'invoices last month',
              'what did the team decide about the project?',
              'give me a summary of this week\'s emails',
            ].map(ex => (
              <div key={ex} onClick={() => setQuery(ex)} style={{ cursor: 'pointer', padding: '3px 0', color: '#4a9eff' }}>
                {ex}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{ padding: '6px 14px', borderTop: '1px solid rgba(255,255,255,0.06)', fontSize: 11, color: '#444', display: 'flex', justifyContent: 'space-between' }}>
        <span>{isIndexReady() ? '✓ Index ready' : indexing ? '⟳ Indexing…' : '○ Not ready'}</span>
        <span>Esc to close</span>
      </div>
    </div>
  );
}

// ── Toolbar button ────────────────────────────────────────────────────────────

export class AISearchBar extends React.Component<{}, { open: boolean }> {
  static displayName = 'AISearchBar';
  state = { open: false };

  render() {
    const { open } = this.state;
    return (
      <>
        <button
          title="AI Search"
          onClick={() => this.setState({ open: !open })}
          style={{
            background: open ? 'rgba(74,158,255,0.15)' : 'transparent',
            border: `1px solid ${open ? 'rgba(74,158,255,0.6)' : 'rgba(255,255,255,0.25)'}`,
            borderRadius: 5, cursor: 'pointer', padding: '0 9px',
            color: open ? '#4a9eff' : 'rgba(255,255,255,0.7)',
            fontSize: 12, fontWeight: 500,
            height: 24, marginTop: 4,
            display: 'inline-flex', alignItems: 'center', gap: 5,
            transition: 'all 0.15s', whiteSpace: 'nowrap' as const,
            verticalAlign: 'middle',
          }}
          onMouseEnter={e => { if (!open) { (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.45)'; (e.currentTarget as HTMLButtonElement).style.color = '#fff'; } }}
          onMouseLeave={e => { if (!open) { (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.25)'; (e.currentTarget as HTMLButtonElement).style.color = 'rgba(255,255,255,0.7)'; } }}
        >
          <span style={{ fontSize: 11 }}>✦</span>
          AI Search
        </button>
        {open && <AISearchPanel onClose={() => this.setState({ open: false })} />}
      </>
    );
  }
}
