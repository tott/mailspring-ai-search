/**
 * LLM provider abstraction for query planning and answer synthesis.
 */

import { LLMConfig } from '../config/types';
import { getCredential } from '../config/config-store';

export interface LLMProvider {
  complete(system: string, user: string): Promise<string>;
  readonly providerId: string;
}

// ── Shared HTTP helper ────────────────────────────────────────────────────────

function httpsPost(url: string, headers: Record<string, string>, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const lib = require(url.startsWith('https') ? 'https' : 'http');
    const parsed = new URL(url);
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (url.startsWith('https') ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
    }, (res: any) => {
      let data = '';
      res.on('data', (chunk: any) => (data += chunk));
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Anthropic ─────────────────────────────────────────────────────────────────

class AnthropicProvider implements LLMProvider {
  readonly providerId = 'anthropic';
  constructor(private model: string, private apiKey: string, private maxTokens: number) {}

  async complete(system: string, user: string): Promise<string> {
    const body = JSON.stringify({
      model: this.model,
      max_tokens: this.maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const raw = await httpsPost('https://api.anthropic.com/v1/messages', {
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
    }, body);
    const parsed = JSON.parse(raw);
    if (parsed.error) throw new Error(parsed.error.message);
    const text = parsed.content?.[0]?.text;
    if (!text) throw new Error(`Unexpected response shape from Anthropic: ${JSON.stringify(parsed).slice(0, 200)}`);
    return text.trim();
  }
}

// ── AWS Bedrock ───────────────────────────────────────────────────────────────

class BedrockProvider implements LLMProvider {
  readonly providerId = 'bedrock';
  constructor(
    private model: string,
    private region: string,
    private maxTokens: number,
    private bearerToken?: string,
    private accessKeyId?: string,
    private secretAccessKey?: string,
  ) {}

  async complete(system: string, user: string): Promise<string> {
    const endpoint = `https://bedrock-runtime.${this.region}.amazonaws.com/model/${encodeURIComponent(this.model)}/invoke`;
    const body = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: this.maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    });

    const headers: Record<string, string> = {};
    if (this.bearerToken) {
      headers['Authorization'] = `Bearer ${this.bearerToken}`;
    } else if (this.accessKeyId && this.secretAccessKey) {
      try {
        const aws4 = require('aws4');
        const url = new URL(endpoint);
        const signed = aws4.sign({
          host: url.hostname, path: url.pathname, method: 'POST',
          service: 'bedrock', region: this.region, body,
          headers: { 'Content-Type': 'application/json' },
        }, { accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey });
        Object.assign(headers, signed.headers);
      } catch {
        throw new Error('aws4 package required for IAM auth');
      }
    }

    const raw = await httpsPost(endpoint, headers, body);
    const parsed = JSON.parse(raw);
    if (parsed.message) throw new Error(parsed.message);
    const bedrockText = parsed.content?.[0]?.text;
    if (!bedrockText) throw new Error(`Unexpected Bedrock response: ${JSON.stringify(parsed).slice(0, 200)}`);
    return bedrockText.trim();
  }
}

// ── OpenAI ────────────────────────────────────────────────────────────────────

class OpenAIProvider implements LLMProvider {
  readonly providerId = 'openai';
  constructor(
    private model: string,
    private apiKey: string,
    private maxTokens: number,
    private baseUrl = 'https://api.openai.com/v1',
  ) {}

  async complete(system: string, user: string): Promise<string> {
    const body = JSON.stringify({
      model: this.model,
      max_tokens: this.maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    const raw = await httpsPost(`${this.baseUrl}/chat/completions`, {
      Authorization: `Bearer ${this.apiKey}`,
    }, body);
    const parsed = JSON.parse(raw);
    if (parsed.error) throw new Error(parsed.error.message);
    const openaiText = parsed.choices?.[0]?.message?.content;
    if (!openaiText) throw new Error(`Unexpected OpenAI response: ${JSON.stringify(parsed).slice(0, 200)}`);
    return openaiText.trim();
  }
}

// ── Ollama ────────────────────────────────────────────────────────────────────

class OllamaProvider implements LLMProvider {
  readonly providerId = 'ollama';
  constructor(private model: string, private baseUrl: string, private maxTokens: number) {}

  async complete(system: string, user: string): Promise<string> {
    const body = JSON.stringify({
      model: this.model,
      stream: false,
      options: { num_predict: this.maxTokens },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    const raw = await httpsPost(`${this.baseUrl.replace(/\/$/, '')}/api/chat`, {}, body);
    const parsed = JSON.parse(raw);
    if (parsed.error) throw new Error(parsed.error);
    const ollamaText = parsed.message?.content;
    if (!ollamaText) throw new Error(`Unexpected Ollama response: ${JSON.stringify(parsed).slice(0, 200)}`);
    return ollamaText.trim();
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export async function createLLMProvider(config: LLMConfig): Promise<LLMProvider> {
  switch (config.provider) {
    case 'anthropic': {
      const key = config.apiKey || (await getCredential('anthropic-api-key')) || '';
      if (!key) throw new Error('Anthropic API key not configured.');
      return new AnthropicProvider(config.model, key, config.maxTokens);
    }

    case 'bedrock': {
      const bearerToken = config.bearerToken || (await getCredential('aws-bearer-token-bedrock'));
      const accessKeyId = config.accessKeyId || (await getCredential('aws-access-key-id'));
      const secretAccessKey = config.secretAccessKey || (await getCredential('aws-secret-access-key'));
      if (!bearerToken && !accessKeyId) throw new Error('AWS credentials not configured.');
      return new BedrockProvider(
        config.model, config.region, config.maxTokens,
        bearerToken ?? undefined, accessKeyId ?? undefined, secretAccessKey ?? undefined,
      );
    }

    case 'openai': {
      const key = config.apiKey || (await getCredential('openai-api-key')) || '';
      if (!key) throw new Error('OpenAI API key not configured.');
      return new OpenAIProvider(config.model, key, config.maxTokens, config.baseUrl);
    }

    case 'ollama':
      return new OllamaProvider(config.model, config.baseUrl, config.maxTokens);

    default:
      throw new Error(`Unknown LLM provider: ${(config as any).provider}`);
  }
}
