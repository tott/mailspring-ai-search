/**
 * Semantic search engine — query planning, hybrid retrieval, thread reconstruction.
 *
 * The LLM receives the user's natural language query and the LanceDB schema,
 * and returns a JSON query plan (intent, WHERE clause, semantic query string).
 * The plugin executes the plan deterministically: SQL filter + vector search + FTS,
 * merged with Reciprocal Rank Fusion, then deduplicated to unique threads.
 * For answer/summarize intents, the retrieved threads are passed back to the LLM
 * for synthesis.
 */

import type { EmbeddingProvider } from '../embedding/provider';
import type { LLMProvider } from '../llm/provider';
import type { PluginConfig, UserContext } from '../config/types';
import { rrf } from '../utils/text';

export interface QueryPlan {
  intent: 'list' | 'summarize' | 'answer' | 'open';
  whereClause: string | null;
  semanticQuery: string | null;
  topN: number | null;
  explanation: string;
}

export interface SearchResult {
  threadId: string;
  subject: string;
  fromAddr: string;
  date: number;
  labels: string[];
  accountId: string;
  messageId: string;   // RFC Message-ID for Mailspring deep-link
  snippet: string;
  score: number;
}

export interface SearchResponse {
  query: string;
  plan: QueryPlan;
  results: SearchResult[];
  answer?: string;
  retried: boolean;
}

// ── Schema description passed to LLM ─────────────────────────────────────────

const SCHEMA_DESCRIPTION = `
LanceDB table: emails
EXACT column names (use these exactly — do not guess or abbreviate):
  message_id    string  — RFC 2822 Message-ID
  mailspring_id string  — Mailspring internal UUID
  thread_id     string  — thread grouping key
  account_id    string  — Mailspring account UUID
  from_addr     string  — sender "name <email>" (NOT from_address, NOT sender)
  to_addrs      string  — recipients (NOT to_address, NOT recipient)
  cc_addrs      string  — CC recipients (NOT cc_address)
  subject       string  — email subject line
  date          int64   — Unix timestamp in MILLISECONDS (NOT seconds)
  labels        list<string>  — labels/folders e.g. "INBOX", "STARRED", "work/clients"
  has_attachments bool
  source_part   string  — "body" | "attachment:filename"
  chunk_index   int32   — 0 = first chunk (contains Subject/From header)
  chunk_text    string  — indexed text content
  vector        float32[N]  — embedding vector

CRITICAL SQL rules:
- Column names: from_addr (not from_address), to_addrs (not to_address)
- LIKE is case-insensitive: from_addr LIKE '%github%' matches "noreply@github.com"
- list_contains(labels, 'X') for label filtering
- date is milliseconds since epoch (today's approximate value is in the context above), multiply YYYY-MM-DD by 86400000
- For service/tool name searches, cover subject, sender AND body:
  e.g. subject LIKE '%GitHub%' OR from_addr LIKE '%github%' OR chunk_text LIKE '%GitHub%'
- Emails about a service often arrive via notification routing whose subject/sender doesn't
  mention the service — always include chunk_text in topic searches
- Prefer broader whereClause + strong semanticQuery over narrow whereClause alone
`;

const QUERY_SYSTEM = `You are an expert email search query planner. Given a user question and the email database schema below, produce the optimal search plan.

${SCHEMA_DESCRIPTION}

{user_context}
Today's date (ISO): {today}

Return ONLY a JSON object:
{
  "intent": "list | summarize | answer | open",   (use "answer" for aggregation/analysis/pattern questions)
  "whereClause": "SQL WHERE clause string, or null",
  "semanticQuery": "text for vector+FTS search, or null if structural-only",
  "topN": number or null (null = return all for list/summarize, 10 for answer/open),
  "explanation": "one sentence describing what you understood and why"
}

Intent rules:
- "summarize": digest/overview requested ("summarize", "summary", "what came in", "overview", "digest")
- "answer": specific question ("what did", "tell me about", "details on", "did I get", ends with "?")
- "open": open in mail client ("open", "show me")
- "list": bare filter queries ("emails from today", "starred this week")

whereClause rules:
- date values are milliseconds: date >= ${Date.UTC(2026,0,1)} means Jan 1 2026
- Use list_contains(labels, 'LABEL') for label filtering
- Use LIKE '%term%' for text matching
- null if no structural filter applies

For "tell me about" / comprehensive queries: set topN = 20 to ensure full coverage.`;

const RETRY_SYSTEM = `The previous query plan returned 0 results. Broaden it.

IMPORTANT: Column names are from_addr (not from_address), to_addrs (not to_address).

Previous plan:
{prev_plan}

Broadening strategies:
- Remove or relax date constraints
- Use single keywords instead of phrases
- For service/tool names: search subject, from_addr AND chunk_text with OR
  e.g. subject LIKE '%ServiceName%' OR from_addr LIKE '%service%' OR chunk_text LIKE '%ServiceName%'
- Add alternative spellings in English AND German
- For travel: add airport codes, booking terms
- If whereClause had wrong column names (from_address, sender, etc.), fix to from_addr/to_addrs

Return the same JSON format.`;

function buildUserContextBlock(ctx: UserContext): string {
  const parts: string[] = [];
  if (ctx.name)     parts.push(`User: ${ctx.name}`);
  if (ctx.email)    parts.push(`Email: ${ctx.email}`);
  if (ctx.location) parts.push(`Location: ${ctx.location}`);
  if (ctx.today)    parts.push(`Today: ${ctx.today}`);
  if (ctx.now)      parts.push(`Current time: ${ctx.now}`);
  return parts.length > 0 ? parts.join('\n') : '';
}

// ── Search engine ─────────────────────────────────────────────────────────────

export class SearchEngine {
  constructor(
    private lanceTable: any,
    readonly embedder: EmbeddingProvider,
    readonly llm: LLMProvider,
    private config: PluginConfig,
  ) {}

  async search(query: string): Promise<SearchResponse> {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const userCtx: UserContext = {
      ...this.config.userContext,
      today,
      now: now.toISOString(),
    };

    // Step 1: Generate query plan
    let plan = await this.generatePlan(query, userCtx);

    // Normalize any unknown intent to 'answer'
    const validIntents = ['list', 'summarize', 'answer', 'open'];
    if (!validIntents.includes(plan.intent)) {
      plan = { ...plan, intent: 'answer' };
    }

    let retried = false;

    // Step 2: Execute search
    let rawResults = await this.executeSearch(plan);

    // Step 3: Auto-retry if 0 results
    if (rawResults.length === 0 && plan.whereClause) {
      const retrySystem = RETRY_SYSTEM.replace('{prev_plan}', JSON.stringify(plan, null, 2));
      try {
        const raw = await this.llm.complete(retrySystem, `Original question: ${query}`);
        const retryPlan = this.parsePlan(raw);
        if (retryPlan) {
          plan = retryPlan;
          rawResults = await this.executeSearch(plan);
          retried = true;
        }
      } catch { /* ignore retry errors, return empty */ }
    }

    // Step 4: Group to unique threads
    const results = this.deduplicateToThreads(rawResults, plan.topN);

    // Step 5: Synthesize if needed
    let answer: string | undefined;
    if (results.length > 0 && (plan.intent === 'answer' || plan.intent === 'summarize')) {
      try {
        answer = await this.synthesize(query, plan.intent, results, userCtx);
      } catch (e: any) {
        answer = `(Could not synthesize answer: ${e.message})`;
      }
    }

    return { query, plan, results, answer, retried };
  }

  private async generatePlan(query: string, ctx: UserContext): Promise<QueryPlan> {
    const system = QUERY_SYSTEM
      .replace('{today}', ctx.today || new Date().toISOString().slice(0, 10))
      .replace('{user_context}', buildUserContextBlock(ctx));
    try {
      const raw = await this.llm.complete(system, `Question: ${query}`);
      const plan = this.parsePlan(raw);
      if (plan) return plan;
    } catch (e) {
      // LLM unavailable — use fallback plan below
    }
    // Fallback: pure semantic search
    return {
      intent: 'answer',
      whereClause: null,
      semanticQuery: query,
      topN: 10,
      explanation: 'LLM unavailable — full semantic search',
    };
  }

  private parsePlan(raw: string): QueryPlan | null {
    // Handle markdown code blocks
    const cleaned = raw.replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]) as QueryPlan;
    } catch {
      return null;
    }
  }

  private async executeSearch(plan: QueryPlan): Promise<any[]> {
    const fetchN = (plan.topN ?? 50) * 5;
    let vectorRows: any[] = [];
    let ftsRows: any[] = [];

    if (plan.semanticQuery) {
      // Guard: LanceDB panics on vector search with < 2 rows
      const rowCount = await this.lanceTable.countRows();
      if (rowCount < 2) return [];

      const vec = (await this.embedder.embed([plan.semanticQuery]))[0];
      try {
        let q = this.lanceTable.vectorSearch(vec).limit(fetchN);
        if (plan.whereClause) q = q.where(plan.whereClause);
        vectorRows = await q.toArray();
      } catch (e: any) {
        // Fall back to filter-only if vector search fails
        if (plan.whereClause) {
          const rows = await this.lanceTable.query().where(plan.whereClause).limit(fetchN).toArray();
          return rows;
        }
        throw e;
      }

      try {
        let fq = this.lanceTable.search(plan.semanticQuery).limit(fetchN);
        if (plan.whereClause) fq = fq.where(plan.whereClause);
        ftsRows = await fq.toArray();
      } catch { /* FTS index may not exist yet */ }
    } else if (plan.whereClause) {
      let q = this.lanceTable.query().where(plan.whereClause);
      if (!plan.topN) {
        // list intent — return all, sorted by date desc
        const rows = await q.toArray();
        const toNum = (d: any) => typeof d === 'bigint' ? Number(d) : (d || 0);
        return rows.sort((a: any, b: any) => toNum(b.date) - toNum(a.date));
      }
      q = q.limit(fetchN);
      return await q.toArray();
    }

    // Merge with RRF
    const withIds = (rows: any[]) => rows.map(r => ({ ...r, id: `${r.mailspring_id}-${r.chunk_index}` }));
    return rrf(withIds(vectorRows), withIds(ftsRows));
  }

  private deduplicateToThreads(rows: any[], topN: number | null): SearchResult[] {
    const seen = new Map<string, SearchResult>();
    for (const row of rows) {
      const tid = row.thread_id || row.mailspring_id;
      if (!seen.has(tid)) {
        // LanceDB returns Int64 fields as BigInt — convert to number
        const date = typeof row.date === 'bigint' ? Number(row.date) : (row.date || 0);
        seen.set(tid, {
          threadId:  tid,
          subject:   row.subject || '',
          fromAddr:  row.from_addr || '',
          date,
          labels:    row.labels || [],
          accountId: row.account_id || '',
          messageId: row.message_id || '',
          snippet:   (row.chunk_text || '').slice(0, 200).replace(/\n/g, ' '),
          score:     row._distance ?? 0,
        });
      }
      if (topN !== null && seen.size >= topN) break;
    }
    return [...seen.values()];
  }

  private async synthesize(query: string, intent: string, results: SearchResult[], ctx: UserContext): Promise<string> {
    const isSummarize = intent === 'summarize';
    const userName = ctx.name || 'the user';
    const userContext = buildUserContextBlock(ctx);
    const system = isSummarize
      ? `You are ${userName}'s email assistant.\n${userContext}\n\nProduce a structured digest with sections:\n## ACTION REQUIRED\n## IMPORTANT\n## DAILY DIGEST\nCite emails as [Subject](mailspring://plugins?action=open-message&id=MESSAGE_ID).`
      : `You are an email assistant for ${userName}.\n${userContext}\n\nAnswer the question directly using the provided emails.\nCite sources as [Subject · Date · From].\nToday is ${ctx.today}.`;

    const context = results.slice(0, isSummarize ? 50 : 5).map((r, i) =>
      `[${i+1}] ${r.subject} | From: ${r.fromAddr} | ${new Date(r.date).toISOString().slice(0,10)} | ${r.snippet}`
    ).join('\n');

    return this.llm.complete(system, `Question: ${query}\n\nEmails:\n${context}`);
  }
}
