/**
 * Manages plugin configuration via Mailspring's AppEnv.config.
 *
 * Credentials (API keys, tokens) are stored under a dedicated key in
 * AppEnv.config, which persists to ~/.config/Mailspring/config.json.
 * This file is readable by the local user — treat it accordingly.
 * Environment variables take precedence and are recommended for CI/dev.
 */

import { PluginConfig, EmbeddingConfig, LLMConfig, DEFAULT_CONFIG, UserContext, DEFAULT_USER_CONTEXT } from './types';

const CONFIG_KEY = 'mailspring-ai-search';
const CREDENTIALS_KEY = 'mailspring-ai-search-credentials';

/* global AppEnv */
declare const AppEnv: any;

/**
 * Get a stored credential by key.
 * Priority: environment variable → AppEnv.config credentials store.
 */
export async function getCredential(key: string): Promise<string | null> {
  // Environment variable takes precedence (development / CI)
  const envKey = key.toUpperCase().replace(/-/g, '_');
  if (process.env[envKey]) return process.env[envKey]!;

  // AppEnv.config credentials store
  const stored = AppEnv.config.get(CREDENTIALS_KEY) as Record<string, string> | null;
  return stored?.[key] || null;
}

export async function setCredential(key: string, value: string): Promise<void> {
  const stored = (AppEnv.config.get(CREDENTIALS_KEY) as Record<string, string> | null) || {};
  AppEnv.config.set(CREDENTIALS_KEY, { ...stored, [key]: value });
}

function sanitizeModel(model: string): string {
  // Strip context-window suffixes like [1m] that sometimes leak from environment
  return model.replace(/\[.*?\]$/, '').trim();
}

export function loadConfig(): PluginConfig {
  const stored = AppEnv.config.get(CONFIG_KEY) as Partial<PluginConfig> | null;
  if (!stored) return { ...DEFAULT_CONFIG };

  // Auto-populate user context from Mailspring accounts if not manually configured
  let userContext: UserContext = { ...DEFAULT_USER_CONTEXT, ...(stored.userContext || {}) };
  if (!userContext.name || !userContext.email) {
    try {
      const { AccountStore } = require('mailspring-exports');
      const accounts = AccountStore.accounts();
      if (accounts?.length > 0) {
        const primary = accounts[0];
        userContext = {
          ...userContext,
          name: userContext.name || primary.name || '',
          email: userContext.email || primary.emailAddress || '',
        };
      }
    } catch { /* AccountStore not available */ }
  }

  return {
    ...DEFAULT_CONFIG,
    ...stored,
    userContext,
    embedding: {
      ...(((stored.embedding as any)?.provider === 'bedrock-titan') ? { region: 'us-east-1' } : {}),
      ...DEFAULT_CONFIG.embedding,
      ...(stored.embedding || {}),
    } as EmbeddingConfig,
    llm: (() => {
      const m = { ...(((stored.llm as any)?.provider === 'bedrock') ? { region: 'us-east-1' } : {}), ...DEFAULT_CONFIG.llm, ...(stored.llm || {}) } as any;
      if (m.model) m.model = sanitizeModel(m.model);
      return m as LLMConfig;
    })(),
    indexing: { ...DEFAULT_CONFIG.indexing, ...(stored.indexing || {}) },
    search: { ...DEFAULT_CONFIG.search, ...(stored.search || {}) },
  };
}

export function saveConfig(config: PluginConfig): void {
  // Strip inline credentials — they are saved separately via setCredential()
  const safe = JSON.parse(JSON.stringify(config));
  for (const section of ['embedding', 'llm'] as const) {
    if (safe[section]) {
      delete safe[section].apiKey;
      delete safe[section].bearerToken;
      delete safe[section].accessKeyId;
      delete safe[section].secretAccessKey;
      delete safe[section].sessionToken;
    }
  }
  AppEnv.config.set(CONFIG_KEY, safe);
}

export function onConfigChange(cb: () => void): { dispose(): void } {
  return AppEnv.config.onDidChange(CONFIG_KEY, cb);
}

export function resolveDbPath(): string {
  const config = loadConfig();
  if (config.dbPath) return config.dbPath;
  const os = require('os');
  const path = require('path');
  return path.join(os.homedir(), '.local', 'share', 'mailspring-ai-search');
}
