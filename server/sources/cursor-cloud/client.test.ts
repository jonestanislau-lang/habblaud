import { describe, expect, it } from 'vitest';
import { FakeCursorApi, fakeAgent, fakeRun } from '../../test/cursor-cloud-fake';
import { CursorCloudClient, CursorHttpError, CursorStallError, readSse, retryAfterMs, type SseEvent } from './client';

const KEY = 'chave_de_teste';

function client(api: FakeCursorApi) {
  return new CursorCloudClient({ apiKey: KEY, baseUrl: 'https://api.cursor.test', fetch: api.fetch });
}

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
      c.close();
    },
  });
}

describe('cliente da API do Cursor (nuvem)', () => {
  it('lista agentes com Basic auth, só GET, sem arquivados; página seguinte pelo cursor', async () => {
    const api = new FakeCursorApi();
    api.pageSize = 1;
    api.agents = [fakeAgent('bc-1'), fakeAgent('bc-2')];
    const c = client(api);
    const p1 = await c.listAgents({ limit: 100 });
    expect(p1.items.map((a) => a.id)).toEqual(['bc-1']);
    expect(p1.nextCursor).toBe('1');
    const p2 = await c.listAgents({ cursor: p1.nextCursor });
    expect(p2).toEqual({ items: [expect.objectContaining({ id: 'bc-2' })] });
    expect(api.writes()).toEqual([]);
    expect(api.requests[0]).toMatchObject({ method: 'GET', path: '/v1/agents', query: { limit: '100', includeArchived: 'false' } });
    expect(api.requests[0]!.headers.authorization).toBe(`Basic ${Buffer.from(`${KEY}:`).toString('base64')}`);
    expect(api.requests[1]!.query.cursor).toBe('1');
  });

  it('execução: 404 = undefined; 429 traz o Retry-After; o erro não carrega a chave', async () => {
    const api = new FakeCursorApi();
    api.runs.set('run-1', fakeRun('run-1', { status: 'FINISHED' }));
    const c = client(api);
    expect((await c.run('bc-1', 'run-1'))?.status).toBe('FINISHED');
    expect(await c.run('bc-1', 'nao-existe')).toBeUndefined();
    api.fail.set('run', { status: 429, retryAfter: '7' });
    const err = await c.run('bc-1', 'run-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CursorHttpError);
    expect(err).toMatchObject({ status: 429, retryAfterMs: 7_000 });
    expect(String((err as Error).message)).not.toContain(KEY);
    api.fail.set('list', { status: 401 });
    await expect(c.listAgents()).rejects.toMatchObject({ status: 401 });
  });

  it('stream: GET com Accept text/event-stream e Last-Event-ID', async () => {
    const api = new FakeCursorApi();
    api.push('run-1', 'assistant', { text: 'oi' }, '1-0');
    api.end('run-1');
    const events: SseEvent[] = [];
    const body = await client(api).openRunStream('bc-1', 'run-1', new AbortController().signal, '0-9');
    await readSse(body, (e) => events.push(e), 5_000);
    expect(events).toEqual([{ event: 'assistant', id: '1-0', data: { text: 'oi' } }]);
    const req = api.requests.at(-1)!;
    expect(req).toMatchObject({ method: 'GET', path: '/v1/agents/bc-1/runs/run-1/stream' });
    expect(req.headers.accept).toBe('text/event-stream');
    expect(req.headers['last-event-id']).toBe('0-9');
  });
});

describe('readSse', () => {
  it('junta pedaços, aceita CRLF, ignora comentários e JSON inválido', async () => {
    const events: SseEvent[] = [];
    await readSse(
      streamOf([': ping\n\nevent: sta', 'tus\r\ndata: {"status":"RUNNING"}\r\n\r\n', 'id: 2-0\nevent: tool_call\ndata: {"name":"x"', '}\n\nevent: bad\ndata: {nope\n\n']),
      (e) => events.push(e),
      5_000,
    );
    expect(events).toEqual([
      { event: 'status', data: { status: 'RUNNING' } },
      { event: 'tool_call', id: '2-0', data: { name: 'x' } },
    ]);
  });

  it('stream mudo por tempo demais: CursorStallError', async () => {
    const silent = new ReadableStream<Uint8Array>({ start() {} });
    await expect(readSse(silent, () => undefined, 20)).rejects.toBeInstanceOf(CursorStallError);
  });

  it('Retry-After em segundos ou data', () => {
    expect(retryAfterMs('30')).toBe(30_000);
    expect(retryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6_000);
    expect(retryAfterMs(null)).toBeUndefined();
    expect(retryAfterMs('amanhã')).toBeUndefined();
  });
});
