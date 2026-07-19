/**
 * Configuration types for mailspring-ai-search.
 * All sensitive values (API keys, tokens) are stored via Mailspring's
 * secure keychain integration, never in plain config files.
 */

export type EmbeddingProvider =
  | 'openai'
  | 'bedrock-titan'
  | 'ollama'
  | 'local-onnx';   // @huggingface/transformers WASM, zero-setup CPU

export type LLMProvider =
  | 'anthropic'
  | 'bedrock'
  | 'openai'
  | 'ollama';

export interface OpenAIEmbeddingConfig {
  provider: 'openai';
  model: 'text-embedding-3-small' | 'text-embedding-3-large' | string;
  apiKey: string;     // stored in keychain
  baseUrl?: string;   // optional custom endpoint (Azure OpenAI, etc.)
  dimensions?: number;
}

export interface BedrockEmbeddingConfig {
  provider: 'bedrock-titan';
  model: 'amazon.titan-embed-text-v2:0' | 'amazon.titan-embed-text-v1' | string;
  region: string;
  /** Bearer token auth (AWS SSO / identity-based). Stored in keychain. */
  bearerToken?: string;
  /** IAM access key. Stored in keychain. */
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}

export interface OllamaEmbeddingConfig {
  provider: 'ollama';
  model: 'nomic-embed-text' | 'mxbai-embed-large' | 'bge-m3' | string;
  baseUrl: string;  // default: http://localhost:11434
}

export interface LocalOnnxEmbeddingConfig {
  provider: 'local-onnx';
  model: 'Xenova/bge-base-en-v1.5' | 'Xenova/bge-small-en-v1.5' | string;
  // No credentials needed — runs in-process via @huggingface/transformers
}

export type EmbeddingConfig =
  | OpenAIEmbeddingConfig
  | BedrockEmbeddingConfig
  | OllamaEmbeddingConfig
  | LocalOnnxEmbeddingConfig;

// ── LLM configs ───────────────────────────────────────────────────────────────

export interface AnthropicLLMConfig {
  provider: 'anthropic';
  model: 'claude-haiku-4-5-20251001' | 'claude-sonnet-5' | string;
  apiKey: string;   // stored in keychain
  maxTokens: number;
}

export interface BedrockLLMConfig {
  provider: 'bedrock';
  model: 'us.anthropic.claude-sonnet-4-6' | 'us.anthropic.claude-haiku-4-5-20251001' | string;
  region: string;
  bearerToken?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  maxTokens: number;
}

export interface OpenAILLMConfig {
  provider: 'openai';
  model: 'gpt-4o-mini' | 'gpt-4o' | string;
  apiKey: string;
  baseUrl?: string;
  maxTokens: number;
}

export interface OllamaLLMConfig {
  provider: 'ollama';
  model: 'llama3.2' | 'qwen2.5:3b' | string;
  baseUrl: string;
  maxTokens: number;
}

export type LLMConfig =
  | AnthropicLLMConfig
  | BedrockLLMConfig
  | OpenAILLMConfig
  | OllamaLLMConfig;

// ── User context passed to LLM prompts ───────────────────────────────────────

export interface UserContext {
  /** Full name of the mailbox owner */
  name: string;
  /** Primary email address */
  email: string;
  /** City/timezone hint for date-relative queries (e.g. "Berlin, Germany") */
  location?: string;
  /** Current date ISO string — injected at runtime, not stored in config */
  today?: string;
  /** Current time ISO string */
  now?: string;
}

// ── Main plugin config ────────────────────────────────────────────────────────

export interface PluginConfig {
  embedding: EmbeddingConfig;
  llm: LLMConfig;

  /** User context for LLM prompts */
  userContext: UserContext;

  /** Path to LanceDB database directory */
  dbPath: string;

  /** Indexing behaviour */
  indexing: {
    /** Chunk size in characters (~600 tokens) */
    chunkSize: number;
    /** Whether to index attachment content */
    indexAttachments: boolean;
    /** Maximum attachment size in bytes to attempt extraction */
    maxAttachmentBytes: number;
    /** Accounts to index (empty = all accounts) */
    accountFilter: string[];
  };

  /** Search behaviour */
  search: {
    defaultTopN: number;
    hybridRrfK: number;
  };
}

export const DEFAULT_USER_CONTEXT: UserContext = {
  name: '',
  email: '',
  location: '',
};

export const DEFAULT_CONFIG: PluginConfig = {
  userContext: DEFAULT_USER_CONTEXT,
  embedding: {
    provider: 'ollama',
    model: 'bge-m3',
    baseUrl: 'http://localhost:11434',
  },
  llm: {
    provider: 'ollama',
    model: 'llama3.2',
    baseUrl: 'http://localhost:11434',
    maxTokens: 1024,
  },
  dbPath: '',  // resolved at runtime to ~/.local/share/mailspring-ai-search/
  indexing: {
    chunkSize: 2400,
    indexAttachments: true,
    maxAttachmentBytes: 10 * 1024 * 1024, // 10MB
    accountFilter: [],
  },
  search: {
    defaultTopN: 10,
    hybridRrfK: 60,
  },
};
