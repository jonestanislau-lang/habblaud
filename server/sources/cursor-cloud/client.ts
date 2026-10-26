// Cliente da API dos agentes na nuvem do Cursor (Cloud Agents, https://api.cursor.com/v1). A fonte só observa: este
// cliente faz APENAS GETs (lista de agentes, uma execução, o stream SSE de uma execução). Nada aqui cria, manda
// mensagem, cancela, arquiva ou apaga agentes. A chave vai só no cabeçalho Authorization (nunca em log ou erro).
import { tr } from '../../../shared/i18n';

/** Timeout dos GETs (o stream não tem: a fonte detecta a conexão parada pelo stall do readSse). */
const REQUEST_TIMEOUT_MS = 45_000;
/** Evento SSE maior que isto (sem fim de bloco) é tratado como erro: o stream é largado. */
const MAX_EVENT_CHARS = 4 * 1024 * 1024;

export type CursorAgentStatus = 'ACTIVE' | 'IDLE' | 'ARCHIVED' | (string & {});
export type CursorRunStatus = 'CREATING' | 'RUNNING' | 'WAITING_FOR_BACKGROUND_WORK' | 'FINISHED' | 'ERROR' | 'CANCELLED' | 'EXPIRED' | (string & {});

/** Agente como a API o devolve (só os campos que a fonte usa). */
export interface CursorAgent {
  id: string;
  name?: string;
  status?: CursorAgentStatus;
  /** Repositórios do agente (`https://github.com/dono/repo`); a lista já traz, o detalhe também. */
  repos?: Array<{ url?: string; startingRef?: string }>;
  /** Página do agente no Cursor (https://cursor.com/agents/bc-...). */
  url?: string;
  createdAt?: string;
  updatedAt?: string;
  latestRunId?: string;
}

export interface CursorRunBranch {
  /** `github.com/dono/repo` ou `https://github.com/dono/repo`. */
  repoUrl?: string;
  branch?: string;
  prUrl?: string;
}

/** Execução (run) de um agente. */
export interface CursorRun {
  id: string;
  agentId?: string;
  status?: CursorRunStatus;
  createdAt?: string;
  updatedAt?: string;
  durationMs?: number;
  git?: { branches?: CursorRunBranch[] };
}

/** Resposta HTTP que não é 2xx. `retryAfterMs` vem do Retry-After (429). Nada do corpo entra na mensagem. */
export class CursorHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(`HTTP ${status}`);
  }
}

/** O stream ficou mudo por tempo demais (conexão morta). */
export class CursorStallError extends Error {
  constructor() {
    super('stall');
  }
}

export interface CursorClientOptions {
  apiKey: string;
  /** Base da API, sem barra no fim (https://api.cursor.com). */
  baseUrl: string;
  fetch?: typeof fetch;
}

/** Um evento do stream de uma execução: o nome (`event:`), o id (`id:`) e o JSON de `data:`. */
export interface SseEvent {
  event: string;
  id?: string;
  data: unknown;
}

export class CursorCloudClient {
  private readonly fetchImpl: typeof fetch;
  private readonly auth: string;

  constructor(private readonly opts: CursorClientOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.auth = `Basic ${Buffer.from(`${opts.apiKey}:`).toString('base64')}`;
  }

  /** Uma página da lista de agentes (mais recentes primeiro). */
  async listAgents(o: { limit?: number; cursor?: string } = {}): Promise<{ items: CursorAgent[]; nextCursor?: string }> {
    const query: Record<string, string> = { limit: String(o.limit ?? 100), includeArchived: 'false' };
    if (o.cursor) query.cursor = o.cursor;
    const body = (await (await this.get('/v1/agents', query)).json()) as { items?: unknown; nextCursor?: unknown };
    const items = Array.isArray(body.items) ? (body.items as CursorAgent[]).filter((a) => a && typeof a.id === 'string') : [];
    return typeof body.nextCursor === 'string' && body.nextCursor ? { items, nextCursor: body.nextCursor } : { items };
  }

  /** Uma execução de um agente; undefined se a API não a conhece (404). */
  async run(agentId: string, runId: string): Promise<CursorRun | undefined> {
    try {
      const body = (await (await this.get(`/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`)).json()) as CursorRun;
      return body && typeof body.id === 'string' ? body : undefined;
    } catch (err) {
      if (err instanceof CursorHttpError && err.status === 404) return undefined;
      throw err;
    }
  }

  /** Abre o stream SSE de uma execução (resolve com o corpo quando a API responde). 410 = stream expirado. */
  async openRunStream(agentId: string, runId: string, signal: AbortSignal, lastEventId?: string): Promise<ReadableStream<Uint8Array>> {
    const path = `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/stream`;
    const res = await this.get(path, undefined, { signal, accept: 'text/event-stream', timeout: false, lastEventId });
    if (!res.body) throw new Error(tr('resposta sem corpo'));
    return res.body;
  }

  private async get(
    path: string,
    query?: Record<string, string>,
    o: { signal?: AbortSignal; accept?: string; timeout?: boolean; lastEventId?: string } = {},
  ): Promise<Response> {
    const url = new URL(this.opts.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { Accept: o.accept ?? 'application/json', Authorization: this.auth };
    if (o.lastEventId) headers['Last-Event-ID'] = o.lastEventId;
    const timeout = o.timeout === false ? undefined : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = o.signal && timeout ? AbortSignal.any([o.signal, timeout]) : (o.signal ?? timeout);
    const res = await this.fetchImpl(url, { method: 'GET', headers, ...(signal ? { signal } : {}) });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new CursorHttpError(res.status, res.status === 429 ? retryAfterMs(res.headers.get('retry-after')) : undefined);
    }
    return res;
  }
}

/** Retry-After em segundos ou data HTTP; undefined se ausente ou inválido. */
export function retryAfterMs(raw: string | null, now = Date.now()): number | undefined {
  if (!raw) return undefined;
  const secs = Number(raw.trim());
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/**
 * Lê um stream SSE e chama `onEvent` com cada evento (nome, id e o JSON de `data:`; comentários e JSON inválido são
 * ignorados). Resolve quando o stream acaba; lança se ficar mudo por `stallMs`.
 */
export async function readSse(body: ReadableStream<Uint8Array>, onEvent: (ev: SseEvent) => void, stallMs: number): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const chunk = await readWithStall(reader, stallMs);
      if (chunk.done) return;
      buf += decoder.decode(chunk.value, { stream: true }).replace(/\r\n?/g, '\n');
      let end: number;
      while ((end = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, end);
        buf = buf.slice(end + 2);
        let event = 'message';
        let id: string | undefined;
        const data: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
          else if (line.startsWith('event:')) event = line.slice(6).trim() || 'message';
          else if (line.startsWith('id:')) id = line.slice(3).trim() || undefined;
        }
        if (!data.length) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data.join('\n'));
        } catch {
          continue;
        }
        onEvent(id ? { event, id, data: parsed } : { event, data: parsed });
      }
      if (buf.length > MAX_EVENT_CHARS) throw new Error(tr('evento grande demais'));
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

async function readWithStall(reader: ReadableStreamDefaultReader<Uint8Array>, stallMs: number): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = reader.read();
  read.catch(() => undefined);
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CursorStallError()), stallMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([read, stalled]);
  } finally {
    clearTimeout(timer);
  }
}
