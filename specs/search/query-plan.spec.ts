/**
 * Tests for query plan parsing in SearchEngine.
 * The parsePlan method is private, so we test it via the exported class
 * using a mock LLM that returns known responses.
 */

import { SearchEngine } from '../../src/search/search-engine';

// Minimal stubs — SearchEngine constructor only stores these
const mockEmbedder = {
  embed: jest.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
  dimensions: 768,
  providerId: 'test',
};

const mockLlm = {
  complete: jest.fn(),
  providerId: 'test',
};

// Build a chainable mock that always returns [] from toArray()
const chainable = (): any => {
  const obj: any = {};
  ['where', 'limit', 'select'].forEach(m => { obj[m] = jest.fn().mockReturnValue(obj); });
  obj.toArray = jest.fn().mockResolvedValue([]);
  return obj;
};

const mockTable = {
  vectorSearch: jest.fn().mockReturnValue(chainable()),
  search: jest.fn().mockReturnValue(chainable()),
  query: jest.fn().mockReturnValue(chainable()),
  countRows: jest.fn().mockResolvedValue(1000),
};

const mockConfig = {
  userContext: { name: 'Test User', email: 'test@example.com' },
  embedding: { provider: 'local-onnx' as const, model: 'test' },
  llm: { provider: 'ollama' as const, model: 'test', baseUrl: '', maxTokens: 100 },
  dbPath: '/tmp/test',
  indexing: { chunkSize: 2400, indexAttachments: false, maxAttachmentBytes: 0, accountFilter: [] },
  search: { defaultTopN: 10, hybridRrfK: 60 },
};

describe('SearchEngine — query plan parsing', () => {
  let engine: SearchEngine;

  beforeEach(() => {
    // Recreate chainable mocks fresh for each test
    mockTable.vectorSearch = jest.fn().mockReturnValue(chainable());
    mockTable.search = jest.fn().mockReturnValue(chainable());
    mockTable.query = jest.fn().mockReturnValue(chainable());
    engine = new SearchEngine(mockTable as any, mockEmbedder as any, mockLlm as any, mockConfig);
    jest.clearAllMocks();
    // Re-apply after clearAllMocks
    mockTable.vectorSearch = jest.fn().mockReturnValue(chainable());
    mockTable.search = jest.fn().mockReturnValue(chainable());
    mockTable.query = jest.fn().mockReturnValue(chainable());
    engine = new SearchEngine(mockTable as any, mockEmbedder as any, mockLlm as any, mockConfig);
  });

  it('executes a list query with date filter', async () => {
    mockLlm.complete.mockResolvedValueOnce(JSON.stringify({
      intent: 'list',
      whereClause: "date >= 1753228800000 AND date < 1753315200000",
      semanticQuery: null,
      topN: null,
      explanation: 'Date filter for today',
    }));

    const response = await engine.search('emails from today');
    expect(response.plan.intent).toBe('list');
    expect(response.plan.whereClause).toContain('date >=');
    expect(response.plan.semanticQuery).toBeNull();
  });

  it('executes a semantic answer query', async () => {
    mockLlm.complete.mockResolvedValueOnce(JSON.stringify({
      intent: 'answer',
      whereClause: "from_addr LIKE '%aws%'",
      semanticQuery: 'invoice billing',
      topN: 5,
      explanation: 'AWS sender + billing topic',
    }));
    // Second call is synthesis
    mockLlm.complete.mockResolvedValueOnce('No AWS invoices found.');

    const response = await engine.search('AWS invoices');
    expect(response.plan.intent).toBe('answer');
    expect(response.plan.semanticQuery).toBe('invoice billing');
  });

  it('parses plan from markdown code block', async () => {
    mockLlm.complete.mockResolvedValueOnce(
      '```json\n' + JSON.stringify({ intent: 'summarize', whereClause: null, semanticQuery: null, topN: null, explanation: 'summary' }) + '\n```'
    );

    const response = await engine.search('summarize today');
    expect(response.plan.intent).toBe('summarize');
  });

  it('falls back to semantic search when LLM returns invalid JSON', async () => {
    mockLlm.complete.mockResolvedValueOnce('Sorry, I cannot help with that.');

    const response = await engine.search('some query');
    // Fallback plan should still have a semantic query
    expect(response.plan.semanticQuery).toBe('some query');
    expect(response.plan.intent).toBe('answer');
  });

  it('retries with broadened query on 0 results', async () => {
    // First plan returns empty results
    mockLlm.complete.mockResolvedValueOnce(JSON.stringify({
      intent: 'answer',
      whereClause: "subject LIKE '%very specific term%'",
      semanticQuery: 'very specific',
      topN: 5,
      explanation: 'specific query',
    }));
    // Retry plan
    mockLlm.complete.mockResolvedValueOnce(JSON.stringify({
      intent: 'answer',
      whereClause: null,
      semanticQuery: 'specific',
      topN: 10,
      explanation: 'broadened query',
    }));

    const response = await engine.search('very specific term');
    expect(response.retried).toBe(true);
  });
});
