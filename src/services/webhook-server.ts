// Webhook HTTP server — receives GitHub webhooks, verifies signatures, dispatches to handler.
// Uses node:http (no external deps).

import http from 'node:http';
import { log } from '../utils/logger.js';
import { handleWebhookEvent } from './webhook-handler.js';
import { verifyWebhookSignature } from './webhook-verify.js';

export interface WebhookServerOptions {
  secret: string;
  port: number;
  enqueue: (issueNumber: number) => boolean;
  queue?: { size(): number; isRunning(): boolean };
}

export interface WebhookServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  port: number;
}

function jsonResponse(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(json);
}

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

function readBody(req: http.IncomingMessage): Promise<{ ok: true; body: string } | { ok: false; status: number }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        rejected = true;
        req.resume(); // drain remaining data without storing
        resolve({ ok: false, status: 413 });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!rejected) {
        resolve({ ok: true, body: Buffer.concat(chunks).toString('utf8') });
      }
    });
    req.on('error', () => {
      if (!rejected) {
        resolve({ ok: false, status: 400 });
      }
    });
  });
}

export function createWebhookServer(options: WebhookServerOptions): WebhookServer {
  const { secret, enqueue, queue } = options;
  let assignedPort = options.port;
  let httpServer: http.Server | undefined;

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    // GET /health
    if (url === '/health' && method === 'GET') {
      jsonResponse(res, 200, {
        status: 'ok',
        queueSize: queue?.size() ?? 0,
        running: queue?.isRunning() ?? false,
      });
      return;
    }

    // /webhook route
    if (url === '/webhook') {
      if (method !== 'POST') {
        res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
      }

      const bodyResult = await readBody(req);
      if (!bodyResult.ok) {
        jsonResponse(res, bodyResult.status, { error: 'Payload too large' });
        return;
      }
      const body = bodyResult.body;
      const signature = (req.headers['x-hub-signature-256'] as string) ?? '';

      if (!verifyWebhookSignature(body, signature, secret)) {
        jsonResponse(res, 401, { error: 'Invalid signature' });
        return;
      }

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(body) as Record<string, unknown>;
      } catch {
        jsonResponse(res, 400, { error: 'Invalid JSON' });
        return;
      }

      const eventType = (req.headers['x-github-event'] as string) ?? '';
      const result = handleWebhookEvent(eventType, payload, enqueue);

      log.info(`Webhook ${eventType}: ${result.action}${result.issueNumber ? ` #${result.issueNumber}` : ''}`);
      jsonResponse(res, 200, result as unknown as Record<string, unknown>);
      return;
    }

    // Unknown route
    jsonResponse(res, 404, { error: 'Not found' });
  }

  return {
    get port(): number {
      return assignedPort;
    },

    start(): Promise<void> {
      return new Promise((resolve, reject) => {
        httpServer = http.createServer((req, res) => {
          handleRequest(req, res).catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            log.error(`Webhook server error: ${message}`);
            if (!res.headersSent) {
              jsonResponse(res, 500, { error: 'Internal server error' });
            }
          });
        });

        httpServer.listen(assignedPort, '127.0.0.1', () => {
          const addr = httpServer?.address();
          if (addr && typeof addr === 'object') {
            assignedPort = addr.port;
          }
          log.info(`Webhook server listening on port ${assignedPort}`);
          resolve();
        });

        httpServer.on('error', reject);
      });
    },

    stop(): Promise<void> {
      return new Promise((resolve) => {
        if (!httpServer) {
          resolve();
          return;
        }
        httpServer.close(() => resolve());
      });
    },
  };
}
