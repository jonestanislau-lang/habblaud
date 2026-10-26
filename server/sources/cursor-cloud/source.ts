// Fonte de agentes na nuvem do Cursor (AgentSource 'cursor', ver sources/source.ts): lê a API dos Cloud Agents
// (https://api.cursor.com) com a chave do usuário e põe cada agente recente no escritório, na sala do repositório dele.
// - A lista de agentes é lida a cada `pollMs` (padrão 30 s); só a primeira página e as seguintes enquanto ainda há
//   agentes mexidos dentro da janela de presença.
// - De cada agente que importa, a fonte lê a última execução (run) e guarda: execução encerrada não é relida até o
//   agente ganhar outra. No máximo MAX_RUN_FETCHES leituras por rodada (a API limita ~20 pedidos/min por rota).
// - Execução CREATING/RUNNING = trabalhando; WAITING_FOR_BACKGROUND_WORK = esperando o shell (segundo plano);
//   encerrada = ocioso por `idleMs` (padrão 2 h) depois do fim, e então sai do escritório. Arquivado ou apagado sai.
// - Enquanto trabalha, o stream SSE da execução dá as atividades ao vivo (ferramentas, resposta); sem ele (expirado,
//   limite de conexões, erro), a leitura periódica segue valendo.
// - PR novo (prUrl que aparece numa execução) = festa na sala (office.githubEvent 'pr_opened').
// - 429: espera o Retry-After (ou um backoff crescente) antes de pedir de novo.
// A fonte só lê: nunca cria, manda mensagem, cancela, arquiva ou apaga agentes. A chave não vai para log nem snapshot.
import type { ShellJob, SourceInfo } from '../../../shared/types';
import { tr } from '../../../shared/i18n';
import { SPECIAL, truncate } from '../../../shared/activity';
import type { CursorCloudConfig } from '../../config';
import type { AccountsService } from '../../accounts/service';
import { errMsg, log } from '../../log';
import type { Office } from '../../model/office';
import type { AgentSource } from '../source';
import { describeCursorTool } from './activity';
import { CursorCloudClient, CursorHttpError, readSse, type CursorAgent, type CursorRun, type SseEvent } from './client';

/** Execuções ainda andando. */
const ACTIVE_RUN = new Set(['CREATING', 'RUNNING', 'WAITING_FOR_BACKGROUND_WORK']);
/** Leituras de execução por rodada (as que sobram ficam para a próxima). */
export const MAX_RUN_FETCHES = 8;
/** Streams SSE abertos ao mesmo tempo. */
export const MAX_STREAMS = 4;
/** Páginas da lista lidas por rodada (100 agentes cada). */
const MAX_PAGES = 3;
/** Stream sem nenhum byte por tanto tempo (a API manda heartbeat): conexão morta. */
export const STALL_MS = 90_000;
/** Backoff sem Retry-After: começa aqui e dobra até BACKOFF_MAX_MS. */
const BACKOFF_MIN_MS = 60_000;
const BACKOFF_MAX_MS = 15 * 60_000;
/** Chave recusada (401/403): tenta de novo só depois disto. */
const AUTH_RETRY_MS = 10 * 60_000;
/** Eventos do stream que chegam logo depois de abrir são o passado da execução: só histórico, sem feed. */
const BACKLOG_MS = 1_500;

/** Conta única da fonte. */
export const CURSOR_CLOUD_ACCOUNT = 'cursor-cloud';
const ROLE = tr('Agente na nuvem (Cursor)');

export interface CursorCloudTiming {
  pollMs: number;
  idleMs: number;
  stallMs: number;
  backlogMs: number;
}

export interface CursorCloudSourceOptions {
  accounts: AccountsService;
  office: Office;
  config: CursorCloudConfig;
  now?: () => number;
  fetch?: typeof fetch;
  timing?: Partial<CursorCloudTiming>;
}

/** Um agente do Cursor conhecido pela fonte (dentro ou fora do escritório). */
interface Track {
  id: string;
  /** Id no Office. */
  key: string;
  agent: CursorAgent;
  run?: CursorRun;
  /** A execução do `run` precisa ser relida (o stream acabou, ou o agente mudou). */
  stale: boolean;
  inOffice: boolean;
  /** Execuções cujo início e fim já entraram no histórico. */
  startedRuns: Set<string>;
  doneRuns: Set<string>;
  /** PRs já vistos (a festa sai uma vez por PR). */
  prs: Set<string>;
  /** Execuções já aplicadas ao menos uma vez (o PR visto na primeira olhada pode ser antigo). */
  looked: Set<string>;
  stream?: { runId: string; abort: AbortController };
  lastEventId?: string;
  /** Execuções cujo stream expirou (410): ficam só na leitura periódica. */
  noStream: Set<string>;
}

type State = 'starting' | 'online' | 'error';

/** Eventos do stream que contam (os outros são ignorados sem quebrar o trecho atual). */
const STREAM_EVENTS = new Set(['tool_call', 'assistant', 'thinking', 'status', 'result']);

/** Estado de um stream aberto: o trecho atual (tipo do último evento) e a resposta sendo juntada. */
interface StreamState {
  last: string;
  n: number;
  say: string;
  sayAt: number;
  sayBacklog: boolean;
}

export function isActiveRun(run: CursorRun | undefined): boolean {
  return !!run?.status && ACTIVE_RUN.has(run.status);
}

/** `https://github.com/dono/repo(.git)` ou `github.com/dono/repo` → { host, owner, repo }. */
export function parseRepoUrl(raw: string | undefined): { host: string; owner: string; repo: string } | undefined {
  if (!raw) return undefined;
  const m = /^(?:[a-z]+:\/\/)?(?:[^@/]+@)?([^/:]+)[/:]([^/]+)\/([^/#?]+?)(?:\.git)?\/?(?:[#?].*)?$/i.exec(raw.trim());
  return m ? { host: m[1]!.toLowerCase(), owner: m[2]!, repo: m[3]! } : undefined;
}

/** Número do PR numa URL do GitHub (…/pull/76). */
export function prNumberOf(url: string): number | undefined {
  const m = /\/pull\/(\d+)/.exec(url);
  return m ? Number(m[1]) : undefined;
}

function ms(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
}

export class CursorCloudSource implements AgentSource {
  readonly provider = 'cursor' as const;
  private readonly accountId: string;
  private readonly client: CursorCloudClient;
  private readonly now: () => number;
  private readonly timing: CursorCloudTiming;
  private readonly tracks = new Map<string, Track>();
  private state: State = 'starting';
  private error?: string;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private backoffUntil = 0;
  private backoffMs = BACKOFF_MIN_MS;
  private polling: Promise<void> | null = null;

  constructor(private readonly opts: CursorCloudSourceOptions) {
    this.now = opts.now ?? Date.now;
    this.timing = { pollMs: opts.config.pollMs, idleMs: opts.config.idleMs, stallMs: STALL_MS, backlogMs: BACKLOG_MS, ...opts.timing };
    this.client = new CursorCloudClient({ apiKey: opts.config.apiKey, baseUrl: opts.config.baseUrl, fetch: opts.fetch });
    const [entry] = opts.accounts.setProviderAccounts(
      'cursor',
      [
        { dir: opts.config.baseUrl, detected: { id: CURSOR_CLOUD_ACCOUNT, configDir: opts.config.baseUrl, short: 'N', name: 'Cursor Cloud', color: '#7c8cff' } },
      ],
      CURSOR_CLOUD_ACCOUNT,
    );
    this.accountId = entry!.id;
  }

  /** Liga: a primeira leitura (boot, entre beginBoot/endBoot) termina antes de a promessa resolver. */
  async start(): Promise<void> {
    this.stopped = false;
    const { office } = this.opts;
    office.beginBoot();
    try {
      await this.poll();
    } finally {
      office.endBoot();
    }
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const t of this.tracks.values()) this.closeStream(t);
  }

  sources(): SourceInfo[] {
    let sessions = 0;
    for (const t of this.tracks.values()) if (t.inOffice) sessions++;
    const info: SourceInfo = { label: this.accountId, provider: 'cursor', path: this.opts.config.baseUrl, sessions, ok: this.state === 'online' };
    if (this.error && this.state !== 'online') info.error = this.error;
    return [info];
  }

  transcriptPathOf(): string | undefined {
    return undefined;
  }

  /** Uma rodada agora (testes e o boot); rodadas não se sobrepõem. */
  poll(): Promise<void> {
    if (!this.polling) {
      this.polling = this.pollOnce()
        .catch((err) => this.fail(err))
        .finally(() => {
          this.polling = null;
        });
    }
    return this.polling;
  }

  private schedule(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const wait = Math.max(this.timing.pollMs, this.backoffUntil - this.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll().finally(() => this.schedule());
    }, wait);
    this.timer.unref?.();
  }

  private fail(err: unknown): void {
    const now = this.now();
    if (err instanceof CursorHttpError && err.status === 429) {
      const wait = err.retryAfterMs ?? this.backoffMs;
      this.backoffMs = Math.min(BACKOFF_MAX_MS, this.backoffMs * 2);
      this.backoffUntil = now + wait;
      // Limite de pedidos não é queda: os agentes ficam como estão.
      log.warn(tr('Cursor (nuvem): limite de pedidos da API; nova tentativa em {0} s.', [Math.ceil(wait / 1000)]));
      return;
    }
    const msg =
      err instanceof CursorHttpError && (err.status === 401 || err.status === 403) ? tr('chave da API do Cursor recusada (HTTP {0})', [err.status]) : errMsg(err);
    if (err instanceof CursorHttpError && (err.status === 401 || err.status === 403)) this.backoffUntil = now + AUTH_RETRY_MS;
    if (this.error !== msg) log.warn(tr('Cursor (nuvem): falha ao ler os agentes ({0}).', [msg]));
    this.state = 'error';
    this.error = msg;
  }

  private async pollOnce(): Promise<void> {
    if (this.stopped || this.now() < this.backoffUntil) return;
    const now = this.now();
    const horizon = now - this.timing.idleMs - this.timing.pollMs;
    // 1) Lista (mais recentes primeiro): a próxima página só enquanto ainda há agentes mexidos dentro da janela.
    const listed = new Map<string, CursorAgent>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.client.listAgents({ limit: 100, cursor });
      for (const a of res.items) listed.set(a.id, a);
      const last = res.items[res.items.length - 1];
      cursor = res.nextCursor;
      if (!cursor || !last || (ms(last.updatedAt) ?? 0) < horizon) break;
    }
    this.state = 'online';
    delete this.error;
    this.backoffMs = BACKOFF_MIN_MS;

    // 2) Quem importa: ativo, mexido dentro da janela, ou já no escritório.
    const wanted: Track[] = [];
    for (const a of listed.values()) {
      if (a.status === 'ARCHIVED') continue;
      let t = this.tracks.get(a.id);
      const recent = a.status === 'ACTIVE' || (ms(a.updatedAt) ?? 0) >= horizon;
      if (!t && !recent) continue;
      if (!t) {
        t = {
          id: a.id,
          key: `${CURSOR_CLOUD_ACCOUNT}:${a.id}`,
          agent: a,
          stale: true,
          inOffice: false,
          startedRuns: new Set(),
          doneRuns: new Set(),
          prs: new Set(),
          looked: new Set(),
          noStream: new Set(),
        };
        this.tracks.set(a.id, t);
      } else {
        // Execução nova, ou o agente voltou a ficar ativo com a execução guardada já encerrada: relê.
        if (a.latestRunId !== t.agent.latestRunId || (a.status === 'ACTIVE' && !isActiveRun(t.run))) t.stale = true;
        t.agent = a;
      }
      wanted.push(t);
    }

    // 3) Execuções: as que precisam (sem stream ao vivo), ativos primeiro, até MAX_RUN_FETCHES por rodada.
    const need = wanted
      .filter((t) => !!t.agent.latestRunId && (t.stale || t.run?.id !== t.agent.latestRunId || (isActiveRun(t.run) && !t.stream)))
      .sort((x, y) => Number(y.agent.status === 'ACTIVE') - Number(x.agent.status === 'ACTIVE') || (ms(y.agent.updatedAt) ?? 0) - (ms(x.agent.updatedAt) ?? 0))
      .slice(0, MAX_RUN_FETCHES);
    for (const t of need) {
      if (this.stopped) return;
      const run = await this.client.run(t.id, t.agent.latestRunId!);
      if (run) t.run = run;
      t.stale = false;
    }

    // 4) Escritório.
    for (const t of this.tracks.values()) {
      if (!listed.has(t.id) || t.agent.status === 'ARCHIVED') {
        // Arquivado, apagado ou velho demais para a lista: sai.
        this.leave(t);
        this.tracks.delete(t.id);
        continue;
      }
      this.apply(t);
    }
  }

  /** Põe o agente no escritório (ou tira) conforme a execução guardada. */
  private apply(t: Track): void {
    const { office } = this.opts;
    const run = t.run;
    if (!run) return;
    const now = this.now();
    const active = isActiveRun(run);
    const lastAt = ms(run.updatedAt) ?? ms(t.agent.updatedAt) ?? now;
    const present = active || now - lastAt < this.timing.idleMs;
    if (!present) {
      this.leave(t);
      return;
    }
    const status = run.status === 'WAITING_FOR_BACKGROUND_WORK' ? 'shell' : active ? 'working' : 'idle';
    if (!t.inOffice || !office.has(t.key)) {
      office.addMain({
        id: t.key,
        provider: 'cursor',
        account: this.accountId,
        sessionId: t.id,
        cwd: this.roomOf(t.agent),
        role: ROLE,
        startedAt: ms(t.agent.createdAt) ?? now,
        status: status === 'shell' ? 'working' : status,
        ...(t.agent.url ? { url: t.agent.url } : {}),
      });
      t.inOffice = true;
    }
    this.summary(t);
    // Começo da execução: entra no histórico uma vez.
    if (!t.startedRuns.has(run.id)) {
      t.startedRuns.add(run.id);
      if (active) office.setStatus(t.key, 'working');
      office.addActivity(
        t.key,
        { id: `${t.key}#run:${run.id}`, at: ms(run.createdAt) ?? now, kind: 'prompt', icon: '☁️', text: tr('Nova execução na nuvem do Cursor'), ...(t.agent.name ? { detail: truncate(t.agent.name, 300) } : {}) },
        active,
      );
    }
    if (active) {
      if (status === 'shell') {
        const job: ShellJob = { id: `${run.id}:bg`, label: tr('trabalho em segundo plano'), startedAt: lastAt, background: true, kind: 'shell' };
        office.setShells(t.key, [job]);
        office.setStatus(t.key, 'shell');
        office.fillShellActivity(t.key);
      } else {
        office.setShells(t.key, []);
        office.setStatus(t.key, 'working');
        office.fillWorkingActivity(t.key);
      }
      this.openStream(t, run);
    } else {
      this.closeStream(t);
      office.setShells(t.key, []);
      this.finish(t, run);
    }
    this.celebrate(t, run);
  }

  /** Execução encerrada: ocioso, com o fim (ou o erro) no histórico uma vez. */
  private finish(t: Track, run: CursorRun): void {
    const { office } = this.opts;
    const wasWorking = office.get(t.key)?.status === 'working' || office.get(t.key)?.status === 'shell';
    office.setStatus(t.key, 'idle');
    if (t.doneRuns.has(run.id)) return;
    t.doneRuns.add(run.id);
    const at = wasWorking ? this.now() : (ms(run.updatedAt) ?? this.now());
    const took = run.durationMs;
    const base = { id: `${t.key}#end:${run.id}`, at, kind: 'done' as const };
    if (run.status === 'ERROR') office.addActivity(t.key, { ...base, icon: '⚠️', text: tr('A execução terminou com erro'), error: true }, true);
    else if (run.status === 'CANCELLED') office.addActivity(t.key, { ...base, icon: '🛑', text: tr('A execução foi cancelada'), error: true }, true);
    else if (run.status === 'EXPIRED') office.addActivity(t.key, { ...base, icon: '⌛', text: tr('A execução expirou'), error: true }, true);
    else {
      const done = SPECIAL.turnDone(took);
      office.addActivity(t.key, { ...base, ...done, ...(took ? { durationMs: took } : {}) }, true);
    }
  }

  /** PR novo numa execução: festa na sala (ao vivo) ou só histórico (boot, PR antigo). */
  private celebrate(t: Track, run: CursorRun): void {
    // Primeira olhada nesta execução: o PR pode ser de antes (de uma execução anterior, ou de quando o Habblaud estava
    // fechado). Datado do começo (ativa) ou do fim (encerrada): festa só se for mesmo de agora (Office: < 2 min).
    const first = !t.looked.has(run.id);
    t.looked.add(run.id);
    const at = !first ? this.now() : isActiveRun(run) ? (ms(run.createdAt) ?? 0) : (ms(run.updatedAt) ?? 0);
    for (const b of run.git?.branches ?? []) {
      const url = b.prUrl?.trim();
      if (!url || t.prs.has(url)) continue;
      t.prs.add(url);
      const repo = parseRepoUrl(b.repoUrl) ?? parseRepoUrl(url.replace(/\/pull\/.*$/, ''));
      const number = prNumberOf(url);
      this.opts.office.githubEvent(
        t.key,
        { kind: 'pr_opened', url, ...(number !== undefined ? { number } : {}), ...(repo ? { repo: `${repo.owner}/${repo.repo}` } : {}), ...(b.branch ? { branch: b.branch } : {}) },
        { key: url, at },
      );
    }
  }

  /** Título (nome do agente), branch e o último instante conhecido. */
  private summary(t: Track): void {
    const run = t.run;
    const branch = run?.git?.branches?.find((b) => b.branch)?.branch;
    const lastAt = ms(run?.updatedAt) ?? ms(t.agent.updatedAt);
    const prev = this.opts.office.get(t.key);
    this.opts.office.applyTranscript(t.key, {
      ...(t.agent.name ? { title: truncate(t.agent.name, 120) } : {}),
      tasks: [],
      stats: prev?.stats ?? { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
      ...(branch ? { gitBranch: branch } : {}),
      ...(lastAt !== undefined ? { lastAt } : {}),
    });
  }

  private leave(t: Track): void {
    this.closeStream(t);
    if (!t.inOffice) return;
    t.inOffice = false;
    this.opts.office.closeMain(t.key);
  }

  /** Sala do agente: o caminho local configurado para o repositório ou /cloud/<host>/<dono>/<repo>. */
  private roomOf(a: CursorAgent): string {
    const repo = parseRepoUrl(a.repos?.find((r) => r.url)?.url);
    if (!repo) return `/cloud/${CURSOR_CLOUD_ACCOUNT}`;
    const rooms = this.opts.config.rooms ?? {};
    const local = rooms[`${repo.owner}/${repo.repo}`.toLowerCase()] ?? rooms[repo.repo.toLowerCase()];
    return local ?? `/cloud/${repo.host}/${repo.owner}/${repo.repo}`;
  }

  // ---------------------------------------------------------------- stream ao vivo

  private openStream(t: Track, run: CursorRun): void {
    if (t.stream?.runId === run.id || t.noStream.has(run.id) || this.stopped) return;
    this.closeStream(t);
    let open = 0;
    for (const x of this.tracks.values()) if (x.stream) open++;
    if (open >= MAX_STREAMS) return;
    const abort = new AbortController();
    t.stream = { runId: run.id, abort };
    if (t.lastEventId && !t.startedRuns.has(run.id)) delete t.lastEventId;
    void this.follow(t, run.id, abort);
  }

  private closeStream(t: Track): void {
    t.stream?.abort.abort();
    delete t.stream;
  }

  private async follow(t: Track, runId: string, abort: AbortController): Promise<void> {
    const openedAt = this.now();
    const resumed = !!t.lastEventId;
    const state: StreamState = { last: '', n: 0, say: '', sayAt: 0, sayBacklog: false };
    try {
      const body = await this.client.openRunStream(t.id, runId, abort.signal, t.lastEventId);
      await readSse(
        body,
        (ev) => {
          if (abort.signal.aborted || t.stream?.abort !== abort) return;
          if (ev.id) t.lastEventId = ev.id;
          this.onEvent(t, runId, ev, state, !resumed && this.now() - openedAt < this.timing.backlogMs);
        },
        this.timing.stallMs,
      );
    } catch (err) {
      if (abort.signal.aborted) return;
      if (err instanceof CursorHttpError && (err.status === 410 || err.status === 404)) t.noStream.add(runId);
      // 400 = Last-Event-ID recusado: a próxima tentativa abre do começo.
      else if (err instanceof CursorHttpError && err.status === 400) delete t.lastEventId;
      else if (err instanceof CursorHttpError && err.status === 429) {
        // Sem stream por um tempo: a leitura periódica segue.
        t.noStream.add(runId);
      }
      // Outras falhas (rede, stall): a próxima rodada relê a execução e refaz o stream.
    } finally {
      if (!abort.signal.aborted) this.flushSay(t, runId, state);
      if (t.stream?.abort === abort) {
        delete t.stream;
        // O stream acabou: a próxima rodada relê a execução (pode ter terminado, ou o stream é refeito).
        t.stale = true;
      }
    }
  }

  private onEvent(t: Track, runId: string, ev: SseEvent, state: StreamState, backlog: boolean): void {
    const { office } = this.opts;
    if (!t.inOffice || !office.has(t.key)) return;
    // heartbeat, interaction_update (a versão "SDK" dos mesmos eventos), error e done não mudam o trecho.
    if (!STREAM_EVENTS.has(ev.event)) return;
    const data = (ev.data && typeof ev.data === 'object' ? ev.data : {}) as Record<string, unknown>;
    const now = this.now();
    const opts = backlog ? { feed: false } : {};
    const stretch = ev.event !== state.last;
    if (stretch) {
      // Fim de um trecho de resposta: entra com o texto inteiro (os eventos 'assistant' são pedaços).
      if (state.last === 'assistant') this.flushSay(t, runId, state);
      state.n++;
    }
    state.last = ev.event;
    switch (ev.event) {
      case 'tool_call': {
        if (data.status !== 'running' && data.status !== undefined) return;
        const name = typeof data.name === 'string' ? data.name : 'tool';
        const callId = typeof data.callId === 'string' ? data.callId : `${state.n}`;
        const { desc, tool } = describeCursorTool(name, data.args);
        office.addActivity(t.key, { id: `${t.key}#tool:${runId}:${callId}`, at: now, ...desc, tool }, true, opts);
        this.bumpTools(t);
        return;
      }
      case 'assistant': {
        if (stretch) {
          state.say = '';
          state.sayAt = now;
          state.sayBacklog = backlog;
        }
        if (typeof data.text === 'string' && state.say.length < 2_000) state.say += data.text;
        return;
      }
      case 'thinking':
        if (stretch) office.addActivity(t.key, { id: `${t.key}#think:${runId}:${state.n}`, at: now, ...SPECIAL.think() }, true, { filler: true });
        return;
      case 'status':
      case 'result': {
        const status = typeof data.status === 'string' ? data.status : undefined;
        if (!status || !t.run || t.run.id !== runId) return;
        const next: CursorRun = { ...t.run, status, updatedAt: new Date(now).toISOString() };
        if (typeof data.durationMs === 'number') next.durationMs = data.durationMs;
        const git = data.git as CursorRun['git'] | undefined;
        if (git && Array.isArray(git.branches)) next.git = git;
        t.run = next;
        if (!isActiveRun(next)) t.stale = true;
        this.apply(t);
        return;
      }
      default:
        return;
    }
  }

  /** Põe no histórico a resposta juntada do trecho atual (uma vez). */
  private flushSay(t: Track, runId: string, state: StreamState): void {
    if (state.last !== 'assistant' || !state.sayAt) return;
    const text = state.say.trim();
    const at = state.sayAt;
    state.say = '';
    state.sayAt = 0;
    if (!t.inOffice || !this.opts.office.has(t.key)) return;
    this.opts.office.addActivity(
      t.key,
      { id: `${t.key}#say:${runId}:${state.n}`, at, ...SPECIAL.respond(text ? truncate(text, 300) : undefined) },
      true,
      state.sayBacklog ? { feed: false } : {},
    );
  }

  private bumpTools(t: Track): void {
    const info = this.opts.office.get(t.key);
    if (!info) return;
    this.opts.office.applyTranscript(t.key, {
      ...(info.title ? { title: info.title } : {}),
      tasks: [],
      stats: { ...info.stats, toolCalls: info.stats.toolCalls + 1 },
      ...(info.model ? { model: info.model } : {}),
      ...(info.gitBranch ? { gitBranch: info.gitBranch } : {}),
    });
  }
}
