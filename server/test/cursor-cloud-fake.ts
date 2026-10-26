// API falsa dos agentes na nuvem do Cursor (só o que a fonte lê): um `fetch` em memória para server/sources/cursor-cloud.
// Guarda cada pedido (método, caminho, cabeçalhos) para os testes conferirem que a fonte só faz GET e manda a chave só
// no Authorization. Os streams SSE são controlados pelo teste (`push`/`end`).
import type { CursorAgent, CursorRun } from '../sources/cursor-cloud/client';

export interface FakeRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
}

interface FakeStream {
  controller?: ReadableStreamDefaultController<Uint8Array>;
  queued: string[];
  ended: boolean;
}

export class FakeCursorApi {
  readonly requests: FakeRequest[] = [];
  /** Agentes na ordem da lista (o teste mantém "mais recentes primeiro"). */
  agents: CursorAgent[] = [];
  readonly runs = new Map<string, CursorRun>();
  /** Status forçado por rota (`list`, `run`, `stream`): 401, 429, 410... */
  readonly fail = new Map<'list' | 'run' | 'stream', { status: number; retryAfter?: string }>();
  /** Tamanho da página da lista (para testar a paginação). */
  pageSize = 100;
  private readonly streams = new Map<string, FakeStream>();

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    this.requests.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers });
    if (method !== 'GET') return json({ error: 'only GET in the fake' }, 405);
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    // /v1/agents
    if (parts.length === 2 && parts[0] === 'v1' && parts[1] === 'agents') {
      const f = this.fail.get('list');
      if (f) return json({}, f.status, f.retryAfter);
      const start = url.searchParams.get('cursor') ? Number(url.searchParams.get('cursor')) : 0;
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), this.pageSize);
      const items = this.agents.slice(start, start + limit);
      const next = start + limit < this.agents.length ? String(start + limit) : undefined;
      return json(next ? { items, nextCursor: next } : { items });
    }
    // /v1/agents/{id}/runs/{runId}[/stream]
    if (parts.length >= 5 && parts[0] === 'v1' && parts[1] === 'agents' && parts[3] === 'runs') {
      const runId = parts[4]!;
      if (parts[5] === 'stream') {
        const f = this.fail.get('stream');
        if (f) return json({}, f.status, f.retryAfter);
        const s = this.stream(runId);
        const body = new ReadableStream<Uint8Array>({
          start: (controller) => {
            s.controller = controller;
            for (const q of s.queued.splice(0)) controller.enqueue(new TextEncoder().encode(q));
            if (s.ended) controller.close();
          },
          cancel: () => {
            delete s.controller;
          },
        });
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      const f = this.fail.get('run');
      if (f) return json({}, f.status, f.retryAfter);
      const run = this.runs.get(runId);
      return run ? json(run) : json({ error: 'not_found' }, 404);
    }
    return json({ error: 'not_found' }, 404);
  };

  /** Manda um evento SSE no stream da execução (guardado até o stream abrir). */
  push(runId: string, event: string, data: unknown, id?: string): void {
    const text = `${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const s = this.stream(runId);
    if (s.controller) s.controller.enqueue(new TextEncoder().encode(text));
    else s.queued.push(text);
  }

  /** Fecha o stream da execução. */
  end(runId: string): void {
    const s = this.stream(runId);
    s.ended = true;
    try {
      s.controller?.close();
    } catch {
      /* já fechado */
    }
  }

  /** Pedidos que não são GET (devem ser zero: a fonte só observa). */
  writes(): FakeRequest[] {
    return this.requests.filter((r) => r.method !== 'GET');
  }

  private stream(runId: string): FakeStream {
    let s = this.streams.get(runId);
    if (!s) this.streams.set(runId, (s = { queued: [], ended: false }));
    return s;
  }
}

function json(body: unknown, status = 200, retryAfter?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (retryAfter !== undefined) headers['retry-after'] = retryAfter;
  return new Response(JSON.stringify(body), { status, headers });
}

/** Agente de exemplo (repo jonas/mercadohub), com a execução `run-<id>`. */
export function fakeAgent(id: string, over: Partial<CursorAgent> = {}): CursorAgent {
  return {
    id,
    name: `Agente ${id}`,
    status: 'IDLE',
    repos: [{ url: 'https://github.com/jonas/mercadohub' }],
    url: `https://cursor.com/agents/${id}`,
    createdAt: '2026-10-26T10:00:00.000Z',
    updatedAt: '2026-10-26T11:00:00.000Z',
    latestRunId: `run-${id}`,
    ...over,
  };
}

export function fakeRun(id: string, over: Partial<CursorRun> = {}): CursorRun {
  return { id, agentId: id.replace(/^run-/, ''), status: 'RUNNING', createdAt: '2026-10-26T11:00:00.000Z', updatedAt: '2026-10-26T11:00:00.000Z', ...over };
}
