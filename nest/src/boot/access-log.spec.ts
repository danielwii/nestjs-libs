import { createAccessLogMiddleware } from './access-log';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import express from 'express';

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// A credential in a path segment (calo's 32-hex invite token) and another in the query string.
const PATH_TOKEN = '5f0c2a9e8d7b46c1a3e2f1d0c9b8a7e6';
const QUERY_TOKEN = 'b1c2d3e4f5a6978877665544332211ff';

describe('access log', () => {
  const lines: string[] = [];
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(createAccessLogMiddleware({ stream: { write: (line: string) => void lines.push(line) } }));
    app.get('/api/invites/:token', (_req, res) => void res.json({ ok: true }));
    // A route inside a mounted router: the template is the mount point plus the route path.
    const members = express.Router();
    members.post('/:token/withdraw-invite', (_req, res) => void res.status(401).end());
    app.use('/api/members', members);
    app.get('/health', (_req, res) => void res.end());
    // What Nest mounts at the global prefix for unknown paths: a catch-all route, which names no endpoint.
    const notFound = express.Router();
    notFound.all('*path', (_req, res) => void res.status(404).end());
    app.use('/api', notFound);

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // morgan writes from the response's finish callback, which can land after the client has read the response
  async function request(method: string, path: string): Promise<string> {
    const before = lines.length;
    await (await fetch(`${baseUrl}${path}`, { method })).arrayBuffer();
    for (let i = 0; i < 50 && lines.length === before; i++) await Bun.sleep(5);
    expect(lines.length).toBe(before + 1);
    return lines.at(-1)!;
  }

  it('writes the route template instead of a token in the path or the query string', async () => {
    const line = await request('GET', `/api/invites/${PATH_TOKEN}?token=${QUERY_TOKEN}`);

    expect(line).toContain('"GET /api/invites/:token HTTP/1.1" 200');
    expect(line).not.toContain(PATH_TOKEN);
    expect(line).not.toContain(QUERY_TOKEN);
  });

  it('includes the mount point of a router and keeps the status of a rejected request', async () => {
    const line = await request('POST', `/api/members/${PATH_TOKEN}/withdraw-invite?token=${QUERY_TOKEN}`);

    expect(line).toContain('"POST /api/members/:token/withdraw-invite HTTP/1.1" 401');
    expect(line).not.toContain(PATH_TOKEN);
    expect(line).not.toContain(QUERY_TOKEN);
  });

  it('writes an unmatched path without its query string, including one answered by a catch-all route', async () => {
    const caughtAll = await request('GET', `/api/unknown/segment?token=${QUERY_TOKEN}&next=1`);
    expect(caughtAll).toContain('"GET /api/unknown/segment HTTP/1.1" 404');
    expect(caughtAll).not.toContain(QUERY_TOKEN);
    expect(caughtAll).not.toContain('?');

    const noRoute = await request('GET', `/outside/segment?token=${QUERY_TOKEN}`);
    expect(noRoute).toContain('"GET /outside/segment HTTP/1.1" 404');
    expect(noRoute).not.toContain(QUERY_TOKEN);
  });

  it('keeps the rest of the combined format and still skips health checks', async () => {
    const line = await request('GET', `/api/invites/${PATH_TOKEN}`);
    expect(line).toMatch(
      /^\S+ xff="-" - - \[[^\]]+\] "GET \/api\/invites\/:token HTTP\/1\.1" 200 \d+ "[\d.]+ ms" "-" "[^"]*"\n$/,
    );

    const before = lines.length;
    await (await fetch(`${baseUrl}/health`)).arrayBuffer();
    await Bun.sleep(20);
    expect(lines.length).toBe(before);
  });
});
