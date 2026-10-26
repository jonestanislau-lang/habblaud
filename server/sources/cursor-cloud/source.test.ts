// Integração da fonte dos agentes na nuvem do Cursor: API falsa (server/test/cursor-cloud-fake.ts), AccountsService e
// Office de verdade, relógio manual.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentInfo, Notice } from '../../../shared/types';
import { AccountsService } from '../../accounts/service';
import type { CursorCloudConfig } from '../../config';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { fakeAgent, FakeCursorApi, fakeRun } from '../../test/cursor-cloud-fake';
import { CURSOR_CLOUD_ACCOUNT, CursorCloudSource, isActiveRun, MAX_RUN_FETCHES, parseRepoUrl, prNumberOf } from './source';

setQuiet(true);

const KEY = 'cursor_test_key_nao_e_real';
const T0 = Date.parse('2026-10-26T11:05:00.000Z');
const HOUR = 3_600_000;

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function setup(o: { config?: Partial<CursorCloudConfig> } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'habblaud-cursor-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  let clock = T0;
  const now = () => clock;
  const late: { office?: Office } = {};
  const accounts = new AccountsService({ dirs: [], home, env: {}, now, onChange: () => late.office?.markDirty() });
  const office = new Office({
    names: new NameStore(null),
    version: 'teste',
    startedAt: clock,
    accounts: (s) => accounts.list(s),
    sources: () => [],
    accountName: (id) => accounts.find(id)?.detected.name,
    now,
  });
  late.office = office;
  const api = new FakeCursorApi();
  const config: CursorCloudConfig = { apiKey: KEY, baseUrl: 'https://api.cursor.test', pollMs: 30_000, idleMs: 2 * HOUR, rooms: {}, ...o.config };
  const source = new CursorCloudSource({ accounts, office, config, now, fetch: api.fetch, timing: { backlogMs: 0 } });
  cleanups.unshift(() => source.stop());
  const notices: Notice[] = [];
  const t = {
    api,
    office,
    source,
    accounts,
    notices,
    advance(ms: number) {
      clock += ms;
    },
    async poll() {
      await source.poll();
      office.tick();
      notices.push(...office.commit().notices);
    },
    async boot() {
      office.beginBoot();
      await source.poll();
      office.endBoot();
      office.tick();
      notices.push(...office.commit().notices);
    },
    agents(): AgentInfo[] {
      return office.commit().snapshot.agents;
    },
    agent(id: string): AgentInfo | undefined {
      return office.commit().snapshot.agents.find((a) => a.id === `${CURSOR_CLOUD_ACCOUNT}:${id}`);
    },
    roomName(a: AgentInfo | undefined): string | undefined {
      return office.commit().snapshot.rooms.find((r) => r.id === a?.roomId)?.name;
    },
  };
  return t;
}

/** Deixa as promessas do stream andarem (o fake entrega os eventos em microtarefas). */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

const iso = (ms: number) => new Date(ms).toISOString();

describe('fonte do Cursor (nuvem): presença', () => {
  it('execução rodando = trabalhando na sala do repositório; encerrada há pouco = ocioso; antiga ou arquivado = fora', async () => {
    const t = setup();
    t.api.agents = [
      fakeAgent('bc-run', { status: 'ACTIVE', updatedAt: iso(T0 - 60_000) }),
      fakeAgent('bc-idle', { updatedAt: iso(T0 - 10 * 60_000), repos: [{ url: 'https://github.com/jonas/outro-repo' }] }),
      fakeAgent('bc-old', { updatedAt: iso(T0 - 1 * HOUR) }),
      fakeAgent('bc-arch', { status: 'ARCHIVED', updatedAt: iso(T0 - 60_000) }),
    ];
    t.api.runs.set('run-bc-run', fakeRun('run-bc-run', { status: 'RUNNING', updatedAt: iso(T0 - 60_000) }));
    t.api.runs.set('run-bc-idle', fakeRun('run-bc-idle', { status: 'FINISHED', updatedAt: iso(T0 - 10 * 60_000), durationMs: 90_000 }));
    // O agente foi mexido há 1 h (updatedAt pode ser só um "toque"), mas a execução acabou há 3 h: fora.
    t.api.runs.set('run-bc-old', fakeRun('run-bc-old', { status: 'FINISHED', updatedAt: iso(T0 - 3 * HOUR) }));
    t.api.runs.set('run-bc-arch', fakeRun('run-bc-arch', { status: 'RUNNING' }));
    await t.boot();

    const run = t.agent('bc-run');
    expect(run?.provider).toBe('cursor');
    expect(run?.status).toBe('working');
    expect(run?.account).toBe(CURSOR_CLOUD_ACCOUNT);
    expect(run?.title).toBe('Agente bc-run');
    expect(run?.url).toBe('https://cursor.com/agents/bc-run');
    expect(t.roomName(run)).toBe('mercadohub');
    const idle = t.agent('bc-idle');
    expect(idle?.status).toBe('idle');
    expect(t.roomName(idle)).toBe('outro-repo');
    expect(t.agent('bc-old')).toBeUndefined();
    expect(t.agent('bc-arch')).toBeUndefined();
    // Conta própria, sem chave no snapshot.
    const snap = t.office.commit().snapshot;
    expect(snap.accounts.find((a) => a.id === CURSOR_CLOUD_ACCOUNT)?.provider).toBe('cursor');
    expect(JSON.stringify(snap)).not.toContain(KEY);
    expect(t.source.sources()[0]).toMatchObject({ provider: 'cursor', sessions: 2, ok: true });
  });

  it('execução presa em CREATING com o agente IDLE não fica trabalhando para sempre', async () => {
    const t = setup({ config: { idleMs: 30 * 24 * HOUR } });
    t.api.agents = [fakeAgent('bc-stuck', { status: 'IDLE', updatedAt: iso(T0 - 60_000) })];
    t.api.runs.set('run-bc-stuck', fakeRun('run-bc-stuck', { status: 'CREATING', createdAt: iso(T0 - 13 * 24 * HOUR), updatedAt: iso(T0 - 13 * 24 * HOUR) }));
    await t.boot();
    const a = t.agent('bc-stuck');
    expect(a?.status).toBe('idle');
    // A execução não é relida a cada rodada.
    const before = t.api.requests.filter((r) => r.path.includes('/runs/')).length;
    t.advance(30_000);
    await t.poll();
    expect(t.api.requests.filter((r) => r.path.includes('/runs/')).length).toBe(before);
  });

  it('só faz GET, com a chave só no Authorization (Basic) e sem pedir arquivados', async () => {
    const t = setup();
    t.api.agents = [fakeAgent('bc-1', { status: 'ACTIVE', updatedAt: iso(T0) })];
    t.api.runs.set('run-bc-1', fakeRun('run-bc-1'));
    t.api.push('run-bc-1', 'tool_call', { callId: 'c1', name: 'read_file', status: 'running', args: { path: 'README.md' } }, '1-0');
    await t.boot();
    await settle();
    expect(t.api.requests.length).toBeGreaterThan(0);
    expect(t.api.writes()).toEqual([]);
    const auth = `Basic ${Buffer.from(`${KEY}:`).toString('base64')}`;
    for (const r of t.api.requests) {
      expect(r.headers.authorization).toBe(auth);
      expect(r.path).not.toContain(KEY);
      expect(JSON.stringify(r.query)).not.toContain(KEY);
    }
    expect(t.api.requests[0]!.query).toMatchObject({ includeArchived: 'false' });
  });

  it('execução que termina: ocioso com "Concluiu" no histórico; passada a janela, sai do escritório', async () => {
    const t = setup();
    t.api.agents = [fakeAgent('bc-1', { status: 'ACTIVE', updatedAt: iso(T0) })];
    t.api.runs.set('run-bc-1', fakeRun('run-bc-1', { status: 'RUNNING', updatedAt: iso(T0) }));
    t.api.fail.set('stream', { status: 410 });
    await t.boot();
    expect(t.agent('bc-1')?.status).toBe('working');

    t.advance(30_000);
    t.api.agents = [fakeAgent('bc-1', { status: 'IDLE', updatedAt: iso(T0 + 30_000) })];
    t.api.runs.set('run-bc-1', fakeRun('run-bc-1', { status: 'FINISHED', updatedAt: iso(T0 + 30_000), durationMs: 45_000 }));
    await t.poll();
    const a = t.agent('bc-1');
    expect(a?.status).toBe('idle');
    expect(a?.activity?.kind).toBe('done');

    t.advance(2 * HOUR + 60_000);
    await t.poll();
    expect(t.agent('bc-1')?.status ?? 'offline').toBe('offline');
  });

  it('execução nova num agente encerrado: volta a trabalhar (relê a execução nova)', async () => {
    const t = setup();
    t.api.agents = [fakeAgent('bc-1', { updatedAt: iso(T0 - 60_000) })];
    t.api.runs.set('run-bc-1', fakeRun('run-bc-1', { status: 'FINISHED', updatedAt: iso(T0 - 60_000) }));
    t.api.fail.set('stream', { status: 410 });
    await t.boot();
    expect(t.agent('bc-1')?.status).toBe('idle');
    t.advance(30_000);
    t.api.agents = [fakeAgent('bc-1', { status: 'ACTIVE', latestRunId: 'run-2', updatedAt: iso(T0 + 30_000) })];
    t.api.runs.set('run-2', fakeRun('run-2', { agentId: 'bc-1', status: 'CREATING', createdAt: iso(T0 + 29_000), updatedAt: iso(T0 + 30_000) }));
    await t.poll();
    expect(t.agent('bc-1')?.status).toBe('working');
    expect(t.agent('bc-1')?.recent.some((r) => r.kind === 'prompt' && r.id.endsWith('#run:run-2'))).toBe(true);
  });

  it('esperando trabalho em segundo plano = status "shell"', async () => {
    const t = setup();
    t.api.agents = [fakeAgent('bc-1', { status: 'ACTIVE', updatedAt: iso(T0) })];
    t.api.runs.set('run-bc-1', fakeRun('run-bc-1', { status: 'WAITING_FOR_BACKGROUND_WORK', updatedAt: iso(T0) }));
    t.api.fail.set('stream', { status: 410 });
    await t.boot();
    const a = t.agent('bc-1');
    expect(a?.status).toBe('shell');
    expect(a?.shells?.[0]?.background).toBe(true);
  });

  it('agente que some da lista (apagado) sai do escritório', async () => {
    const t = setup();
    t.api.agents = [fakeAgent('bc-1', { updatedAt: iso(T0 - 60_000) })];
    t.api.runs.set('run-bc-1', fakeRun('run-bc-1', { status: 'FINISHED', updatedAt: iso(T0 - 60_000) }));
    await t.boot();
    expect(t.agent('bc-1')?.status).toBe('idle');
    t.advance(30_000);
    t.api.agents = [];
    await t.poll();
    expect(t.agent('bc-1')?.status ?? 'offline').toBe('offline');
  });

  it('HABBLAUD_CURSOR_CLOUD_ROOMS: o agente entra na sala local do repositório', async () => {
    const t = setup({ config: { rooms: { 'jonas/mercadohub': '/home/jonas/dev/mercadohub-local' } } });
    t.api.agents = [fakeAgent('bc-1', { status: 'ACTIVE', updatedAt: iso(T0) })];
    t.api.runs.set('run-bc-1', fakeRun('run-bc-1'));
    t.api.fail.set('stream', { status: 410 });
    await t.boot();
    expect(t.agent('bc-1')?.roomId).toBe('/home/jonas/dev/mercadohub-local');
  });

  it('lê no máximo MAX_RUN_FETCHES execuções por rodada (o resto fica para a próxima)', async () => {
    const t = setup();
    const n = MAX_RUN_FETCHES + 3;
    t.api.agents = Array.from({ length: n }, (_, i) => fakeAgent(`bc-${i}`, { updatedAt: iso(T0 - i * 1000) }));
    for (let i = 0; i < n; i++) t.api.runs.set(`run-bc-${i}`, fakeRun(`run-bc-${i}`, { status: 'FINISHED', updatedAt: iso(T0 - i * 1000) }));
    await t.boot();
    const runReads = () => t.api.requests.filter((r) => r.path.includes('/runs/')).length;
    expect(runReads()).toBe(MAX_RUN_FETCHES);
    expect(t.agents().filter((a) => a.provider === 'cursor')).toHaveLength(MAX_RUN_FETCHES);
    t.advance(30_000);
    await t.poll();
    expect(runReads()).toBe(n);
    expect(t.agents().filter((a) => a.provider === 'cursor')).toHaveLength(n);
    // Execução encerrada não é relida.
    t.advance(30_000);
    await t.poll();
    expect(runReads()).toBe(n);
  });
});

describe('fonte do Cursor (nuvem): PR', () => {
  it('PR que aparece depois do boot: festa (aviso) uma vez; o PR já existente no boot não', async () => {
    const t = setup();
    t.api.agents = [fakeAgent('bc-1', { status: 'ACTIVE', updatedAt: iso(T0) }), fakeAgent('bc-2', { updatedAt: iso(T0 - 60_000) })];
    t.api.runs.set('run-bc-1', fakeRun('run-bc-1'));
    t.api.runs.set(
      'run-bc-2',
      fakeRun('run-bc-2', { status: 'FINISHED', updatedAt: iso(T0 - 60_000), git: { branches: [{ repoUrl: 'https://github.com/jonas/mercadohub', branch: 'cursor/a', prUrl: 'https://github.com/jonas/mercadohub/pull/7' }] } }),
    );
    t.api.fail.set('stream', { status: 410 });
    await t.boot();
    expect(t.notices).toEqual([]);
    expect(t.agent('bc-2')?.recent.some((r) => r.id.includes('#gh:'))).toBe(true);

    t.advance(30_000);
    t.api.agents = [fakeAgent('bc-1', { status: 'IDLE', updatedAt: iso(T0 + 30_000) }), fakeAgent('bc-2', { updatedAt: iso(T0 - 60_000) })];
    t.api.runs.set(
      'run-bc-1',
      fakeRun('run-bc-1', { status: 'FINISHED', updatedAt: iso(T0 + 30_000), git: { branches: [{ repoUrl: 'https://github.com/jonas/mercadohub', branch: 'cursor/b', prUrl: 'https://github.com/jonas/mercadohub/pull/8' }] } }),
    );
    await t.poll();
    expect(t.notices.filter((n) => n.text.includes('#8'))).toHaveLength(1);
    expect(t.agent('bc-1')?.gitBranch).toBe('cursor/b');

    t.advance(30_000);
    await t.poll();
    expect(t.notices.filter((n) => n.text.includes('#8'))).toHaveLength(1);
  });

  it('agente que entra depois do boot já com um PR antigo: só histórico, sem festa', async () => {
    const t = setup();
    t.api.agents = [];
    await t.boot();
    t.advance(30_000);
    t.api.agents = [fakeAgent('bc-1', { status: 'ACTIVE', latestRunId: 'run-2', updatedAt: iso(T0 + 30_000) })];
    t.api.runs.set(
      'run-2',
      fakeRun('run-2', { status: 'RUNNING', createdAt: iso(T0 - HOUR), updatedAt: iso(T0 + 30_000), git: { branches: [{ repoUrl: 'github.com/jonas/mercadohub', prUrl: 'https://github.com/jonas/mercadohub/pull/5' }] } }),
    );
    t.api.fail.set('stream', { status: 410 });
    await t.poll();
    expect(t.agent('bc-1')?.status).toBe('working');
    expect(t.notices.filter((n) => n.text.includes('#5'))).toEqual([]);
  });
});

describe('fonte do Cursor (nuvem): stream ao vivo', () => {
  it('ferramentas e resposta viram atividades; o resultado encerra a execução', async () => {
    const t = setup();
    t.api.agents = [fakeAgent('bc-1', { status: 'ACTIVE', updatedAt: iso(T0) })];
    t.api.runs.set('run-bc-1', fakeRun('run-bc-1'));
    await t.boot();
    t.api.push('run-bc-1', 'status', { runId: 'run-bc-1', status: 'RUNNING' });
    t.api.push('run-bc-1', 'tool_call', { callId: 'c1', name: 'read_file', status: 'running', args: { path: 'src/app.ts' } }, '1-0');
    t.api.push('run-bc-1', 'tool_call', { callId: 'c1', name: 'read_file', status: 'completed', args: { path: 'src/app.ts' } }, '2-0');
    t.api.push('run-bc-1', 'tool_call', { callId: 'c2', name: 'run_terminal_cmd', status: 'running', args: { command: 'npm test' } }, '3-0');
    t.api.push('run-bc-1', 'assistant', { text: 'Pronto, ' }, '4-0');
    t.api.push('run-bc-1', 'interaction_update', { type: 'text-delta' }, '4-1');
    t.api.push('run-bc-1', 'assistant', { text: 'os testes passaram.' }, '5-0');
    await settle();
    let a = t.agent('bc-1');
    expect(a?.recent.some((r) => r.tool === 'Read' && /app\.ts/.test(r.text + (r.detail ?? '')))).toBe(true);
    expect(a?.recent.some((r) => r.tool === 'Bash')).toBe(true);
    expect(a?.stats.toolCalls).toBe(2);

    t.advance(5_000);
    t.api.push('run-bc-1', 'result', { runId: 'run-bc-1', status: 'FINISHED', durationMs: 12_000 }, '6-0');
    t.api.push('run-bc-1', 'done', {}, '7-0');
    t.api.end('run-bc-1');
    await settle();
    a = t.agent('bc-1');
    expect(a?.status).toBe('idle');
    expect(a?.recent.find((r) => r.id.includes('#say:'))?.detail).toBe('Pronto, os testes passaram.');
    expect(a?.activity?.kind).toBe('done');
    expect(t.api.writes()).toEqual([]);
  });

  it('stream expirado (410): segue só com a leitura periódica', async () => {
    const t = setup();
    t.api.agents = [fakeAgent('bc-1', { status: 'ACTIVE', updatedAt: iso(T0) })];
    t.api.runs.set('run-bc-1', fakeRun('run-bc-1'));
    t.api.fail.set('stream', { status: 410 });
    await t.boot();
    await settle();
    const streams = () => t.api.requests.filter((r) => r.path.endsWith('/stream')).length;
    expect(streams()).toBe(1);
    t.advance(30_000);
    await t.poll();
    await settle();
    expect(streams()).toBe(1);
    expect(t.agent('bc-1')?.status).toBe('working');
  });
});

describe('fonte do Cursor (nuvem): erros', () => {
  it('429 com Retry-After: não pede nada até o prazo passar', async () => {
    const t = setup();
    t.api.agents = [fakeAgent('bc-1', { updatedAt: iso(T0 - 60_000) })];
    t.api.runs.set('run-bc-1', fakeRun('run-bc-1', { status: 'FINISHED', updatedAt: iso(T0 - 60_000) }));
    t.api.fail.set('list', { status: 429, retryAfter: '120' });
    await t.boot();
    const n = t.api.requests.length;
    t.advance(60_000);
    await t.poll();
    expect(t.api.requests.length).toBe(n);
    t.api.fail.delete('list');
    t.advance(61_000);
    await t.poll();
    expect(t.api.requests.length).toBeGreaterThan(n);
    expect(t.agent('bc-1')?.status).toBe('idle');
  });

  it('chave recusada (401): fonte com erro, sem agentes e sem a chave na mensagem', async () => {
    const t = setup();
    t.api.fail.set('list', { status: 401 });
    await t.boot();
    const [info] = t.source.sources();
    expect(info?.ok).toBe(false);
    expect(info?.error).toContain('401');
    expect(info?.error).not.toContain(KEY);
    expect(t.agents().filter((a) => a.provider === 'cursor')).toEqual([]);
  });
});

describe('fonte do Cursor (nuvem): utilitários', () => {
  it('parseRepoUrl, prNumberOf e isActiveRun', () => {
    expect(parseRepoUrl('https://github.com/jonas/mercadohub')).toEqual({ host: 'github.com', owner: 'jonas', repo: 'mercadohub' });
    expect(parseRepoUrl('github.com/jonas/mercadohub.git')).toEqual({ host: 'github.com', owner: 'jonas', repo: 'mercadohub' });
    expect(parseRepoUrl('git@github.com:jonas/x.git')).toEqual({ host: 'github.com', owner: 'jonas', repo: 'x' });
    expect(parseRepoUrl('nada')).toBeUndefined();
    expect(prNumberOf('https://github.com/jonas/mercadohub/pull/76')).toBe(76);
    expect(prNumberOf('https://github.com/jonas/mercadohub')).toBeUndefined();
    expect(isActiveRun({ id: 'r', status: 'RUNNING' })).toBe(true);
    expect(isActiveRun({ id: 'r', status: 'WAITING_FOR_BACKGROUND_WORK' })).toBe(true);
    expect(isActiveRun({ id: 'r', status: 'FINISHED' })).toBe(false);
  });
});
