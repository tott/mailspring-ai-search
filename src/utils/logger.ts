/**
 * Logger for mailspring-ai-search.
 *
 * Follows Mailspring conventions:
 * - All log output prefixed with [ai-search] for easy filtering in DevTools
 * - Errors reported via AppEnv.reportError() with pluginIds set, so Mailspring
 *   can attribute crashes to this plugin in its error dialog
 * - Debug output only emitted in devMode (launch Mailspring with --dev flag)
 * - In devMode, opens DevTools console automatically on error (AppEnv behaviour)
 *
 * Usage:
 *   import { logger } from '../utils/logger';
 *   logger.debug('Indexer started', { account, total });
 *   logger.info('Indexed 100 messages');
 *   logger.warn('Embedding failed for message', { messageId, error });
 *   logger.error('Fatal indexer error', error);
 */

const PLUGIN_ID = 'mailspring-ai-search';
const PREFIX = `[${PLUGIN_ID}]`;

/* global AppEnv */
declare const AppEnv: any;

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  level: LogLevel;
  message: string;
  data?: unknown;
  timestamp: string;
  error?: Error;
}

class Logger {
  private history: LogEntry[] = [];
  private readonly maxHistory = 500;

  private isDevMode(): boolean {
    try {
      return AppEnv?.isDevMode() ?? (process.env.NODE_ENV === 'development');
    } catch {
      return false;
    }
  }

  private record(entry: LogEntry): void {
    this.history.push(entry);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
  }

  /**
   * Debug: only logged in --dev mode. Use for verbose tracing.
   */
  debug(message: string, data?: unknown): void {
    if (!this.isDevMode()) return;
    const entry: LogEntry = { level: 'debug', message, data, timestamp: new Date().toISOString() };
    this.record(entry);
    if (data !== undefined) {
      console.debug(`${PREFIX} ${message}`, data);
    } else {
      console.debug(`${PREFIX} ${message}`);
    }
  }

  /**
   * Info: normal operational messages. Always logged.
   */
  info(message: string, data?: unknown): void {
    const entry: LogEntry = { level: 'info', message, data, timestamp: new Date().toISOString() };
    this.record(entry);
    if (data !== undefined) {
      console.log(`${PREFIX} ${message}`, data);
    } else {
      console.log(`${PREFIX} ${message}`);
    }
  }

  /**
   * Warn: unexpected but recoverable. Always logged.
   */
  warn(message: string, data?: unknown): void {
    const entry: LogEntry = { level: 'warn', message, data, timestamp: new Date().toISOString() };
    this.record(entry);
    if (data !== undefined) {
      console.warn(`${PREFIX} ${message}`, data);
    } else {
      console.warn(`${PREFIX} ${message}`);
    }
  }

  /**
   * Error: reports to AppEnv.reportError() so Mailspring tracks the crash
   * and attributes it to this plugin. Also logs to DevTools console.
   */
  error(message: string, error?: Error | unknown, extra?: Record<string, unknown>): void {
    const err = error instanceof Error ? error : new Error(String(error ?? message));
    const entry: LogEntry = { level: 'error', message, error: err, timestamp: new Date().toISOString() };
    this.record(entry);
    console.error(`${PREFIX} ${message}`, err);

    // Report to Mailspring's error system with plugin attribution
    try {
      AppEnv?.reportError(err, {
        pluginIds: [PLUGIN_ID],
        context: message,
        ...extra,
      });
    } catch {
      // AppEnv may not be available in all contexts (e.g., worker threads)
    }
  }

  /**
   * Returns recent log history — useful for the debug panel.
   */
  getHistory(): ReadonlyArray<LogEntry> {
    return this.history;
  }

  /**
   * Dump recent log history to console — call from DevTools for quick debugging.
   * Usage: `require('./lib/utils/logger').logger.dump()`
   */
  dump(): void {
    console.group(`${PREFIX} Log history (last ${this.history.length} entries)`);
    for (const entry of this.history) {
      const line = `[${entry.timestamp.slice(11, 23)}] ${entry.level.toUpperCase()} ${entry.message}`;
      switch (entry.level) {
        case 'debug': console.debug(line, entry.data ?? ''); break;
        case 'info':  console.log(line, entry.data ?? '');   break;
        case 'warn':  console.warn(line, entry.data ?? '');  break;
        case 'error': console.error(line, entry.error ?? entry.data ?? ''); break;
      }
    }
    console.groupEnd();
  }
}

export const logger = new Logger();
