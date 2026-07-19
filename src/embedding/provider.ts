/**
 * Embedding provider abstraction.
 * All providers implement the same interface: embed(texts) → float32[][]
 */

import { EmbeddingConfig } from '../config/types';
import { getCredential } from '../config/config-store';

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  /** Actual output dimensions — populated by calling embed() or warmup() */
  dimensions: number;
  readonly providerId: string;
  /** Call once before using dimensions — resolves actual model dimensions */
  warmup(): Promise<void>;
}

// ── OpenAI ────────────────────────────────────────────────────────────────────

class OpenAIEmbedder implements EmbeddingProvider {
  readonly providerId = 'openai';
  dimensions: number;
  private model: string;
  private apiKey: string;
  private baseUrl: string;

  constructor(model: string, apiKey: string, baseUrl = 'https://api.openai.com/v1', dimensions?: number) {
    this.model = model;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.dimensions = dimensions ?? (model.includes('large') ? 3072 : 1536);
  }

  async warmup(): Promise<void> {
    // Dimensions known from model name — verify by embedding once
    const vecs = await this.embed(['warmup']);
    if (vecs[0]) this.dimensions = vecs[0].length;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const https = require('https');
    const body = JSON.stringify({
      model: this.model,
      input: texts,
      ...(this.dimensions !== 1536 && this.dimensions !== 3072
        ? { dimensions: this.dimensions }
        : {}),
    });

    return new Promise((resolve, reject) => {
      const url = new URL(`${this.baseUrl}/embeddings`);
      const req = https.request({
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res: any) => {
        let data = '';
        res.on('data', (chunk: any) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) return reject(new Error(parsed.error.message));
            resolve(parsed.data.map((d: any) => d.embedding));
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}

// ── AWS Bedrock Titan ─────────────────────────────────────────────────────────

class BedrockTitanEmbedder implements EmbeddingProvider {
  readonly providerId = 'bedrock-titan';
  dimensions = 1024; // titan-embed-text-v2 default
  private model: string;
  private region: string;
  private bearerToken?: string;
  private accessKeyId?: string;
  private secretAccessKey?: string;

  constructor(model: string, region: string, opts: {
    bearerToken?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
  }) {
    this.model = model;
    this.region = region;
    this.bearerToken = opts.bearerToken;
    this.accessKeyId = opts.accessKeyId;
    this.secretAccessKey = opts.secretAccessKey;
    // v2 supports 256/512/1024
    if (model.includes('v2')) this.dimensions = 1024;
    else this.dimensions = 1536;
  }

  async warmup(): Promise<void> {
    const vec = await this._embedOne('warmup');
    if (vec) this.dimensions = vec.length;
  }

  async embed(texts: string[]): Promise<number[][]> {
    // Bedrock Titan processes one text at a time
    const results: number[][] = [];
    for (const text of texts) {
      const embedding = await this._embedOne(text);
      results.push(embedding);
    }
    return results;
  }

  private async _embedOne(text: string): Promise<number[]> {
    const https = require('https');
    const endpoint = `https://bedrock-runtime.${this.region}.amazonaws.com/model/${encodeURIComponent(this.model)}/invoke`;
    const body = JSON.stringify({ inputText: text });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(body)),
    };

    if (this.bearerToken) {
      headers['Authorization'] = `Bearer ${this.bearerToken}`;
    } else if (this.accessKeyId && this.secretAccessKey) {
      // SigV4 signing — use aws4 if available, else basic auth header
      try {
        const aws4 = require('aws4');
        const url = new URL(endpoint);
        const signed = aws4.sign({
          host: url.hostname,
          path: url.pathname,
          method: 'POST',
          service: 'bedrock',
          region: this.region,
          body,
          headers,
        }, { accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey });
        Object.assign(headers, signed.headers);
      } catch {
        throw new Error('aws4 package required for IAM auth: npm install aws4');
      }
    }

    const url = new URL(endpoint);
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'POST',
        headers,
      }, (res: any) => {
        let data = '';
        res.on('data', (chunk: any) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.message) return reject(new Error(parsed.message));
            resolve(parsed.embedding);
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}

// ── Ollama ────────────────────────────────────────────────────────────────────

class OllamaEmbedder implements EmbeddingProvider {
  readonly providerId = 'ollama';
  dimensions = 0; // set after first embed() call — do not use before calling embed()
  private model: string;
  private baseUrl: string;

  constructor(model: string, baseUrl: string) {
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async embed(texts: string[]): Promise<number[][]> {
    const http = require(this.baseUrl.startsWith('https') ? 'https' : 'http');
    const body = JSON.stringify({ model: this.model, input: texts });
    const url = new URL(`${this.baseUrl}/api/embed`);

    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: url.hostname,
        port: url.port || (this.baseUrl.startsWith('https') ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res: any) => {
        let data = '';
        res.on('data', (chunk: any) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) return reject(new Error(parsed.error));
            const embeddings = parsed.embeddings;
            if (embeddings?.[0]) this.dimensions = embeddings[0].length;
            resolve(embeddings);
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  async warmup(): Promise<void> {
    // Embed once to discover real dimensions (bge-m3=1024, nomic=768, etc.)
    const vecs = await this.embed(['warmup']);
    if (vecs[0]) this.dimensions = vecs[0].length;
  }
}

// ── Local ONNX via @huggingface/transformers ──────────────────────────────────

class LocalOnnxEmbedder implements EmbeddingProvider {
  readonly providerId = 'local-onnx';
  dimensions = 768;
  private model: string;
  private pipeline: any = null;

  constructor(model: string) {
    this.model = model;
  }

  private async getPipeline() {
    if (!this.pipeline) {
      let transformers: any;
      try {
        transformers = await import('@huggingface/transformers' as any);
      } catch {
        throw new Error(
          'Local ONNX embeddings require @huggingface/transformers. ' +
          'Run: npm install @huggingface/transformers in the plugin directory, ' +
          'or switch to Ollama or a cloud embedding provider in Settings.'
        );
      }
      const { pipeline, env } = transformers;
      env.allowLocalModels = false;
      this.pipeline = await pipeline('feature-extraction', this.model, { quantized: true });
    }
    return this.pipeline;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const pipe = await this.getPipeline();
    const output = await pipe(texts, { pooling: 'mean', normalize: true });
    const result: number[][] = [];
    for (let i = 0; i < texts.length; i++) {
      result.push(Array.from(output[i].data as Float32Array));
    }
    if (result[0]) this.dimensions = result[0].length;
    return result;
  }

  async warmup(): Promise<void> {
    const vecs = await this.embed(['warmup']);
    if (vecs[0]) this.dimensions = vecs[0].length;
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export async function createEmbeddingProvider(config: EmbeddingConfig): Promise<EmbeddingProvider> {
  switch (config.provider) {
    case 'openai': {
      const key = config.apiKey || (await getCredential('openai-api-key')) || '';
      if (!key) throw new Error('OpenAI API key not configured. Set it in AI Search settings.');
      return new OpenAIEmbedder(config.model, key, config.baseUrl, config.dimensions);
    }

    case 'bedrock-titan': {
      const bearerToken = config.bearerToken || (await getCredential('aws-bearer-token-bedrock'));
      const accessKeyId = config.accessKeyId || (await getCredential('aws-access-key-id'));
      const secretAccessKey = config.secretAccessKey || (await getCredential('aws-secret-access-key'));
      if (!bearerToken && !accessKeyId) {
        throw new Error('AWS credentials not configured. Set bearer token or IAM keys in AI Search settings.');
      }
      return new BedrockTitanEmbedder(config.model, config.region, {
        bearerToken: bearerToken ?? undefined,
        accessKeyId: accessKeyId ?? undefined,
        secretAccessKey: secretAccessKey ?? undefined,
      });
    }

    case 'ollama':
      return new OllamaEmbedder(config.model, config.baseUrl);

    case 'local-onnx':
      return new LocalOnnxEmbedder(config.model);

    default:
      throw new Error(`Unknown embedding provider: ${(config as any).provider}`);
  }
}
