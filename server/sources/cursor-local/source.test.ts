// Integração da fonte dos agentes locais do Cursor: pasta temporária com transcripts, AccountsService e Office de
// verdade, relógio manual (o mtime dos arquivos é ajustado com utimes).
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentInfo } from '../../../shared/types';
import { AccountsService } from '../../accounts/service';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { CURSOR_LOCAL_ACCOUNT, CursorLocalSource } from './source';

setQuiet(true);

const T0 = Date.parse('2026-10-26T11:05:00.000Z');
const MIN = 60_000;
const SLUG = 'c-Users-jonyy-ot-MercadoHub';
const ID = '0b6c1f9e-1111-2222-3333-444455556666';

const user = (q: string) => JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: `<user_query>\n${q}\n</user_query>` }] } }) + '\n';
const tool = (name: string, input: unknown) => JSON.stringify({ role: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } }) + '\n';
const say = (text: string) => JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n';
const end = (ok = true) => JSON.stringify({ type: 'turn_ended', status: ok ? 'success' : 'error' }) + '\n';

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'habblaud-cursor-local-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = mkdtempSync(join(tmpdir(), 'habblaud-cursor-home-'));
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
  const source = new CursorLocalSource({ accounts, office, dirs: [root], now, platform: 'linux' });
  cleanups.unshift(() => source.stop());
  const file = (slug = SLUG, id = ID) => {
    const d = join(root, 'projects', slug, 'agent-transcripts', id);
    mkdirSync(d, { recursive: true });
    return join(d, `${id}.jsonl`);
  };
  const t = {
    root,
    accounts,
    office,
    source,
    file,
    advance(ms: number) {
      clock += ms;
    },
    write(path: string, text: string, mtime = clock) {
      appendFileSync(path, text);
      utimesSync(path, mtime / 1000, mtime / 1000);
    },
    async poll() {
      await source.poll();
      office.tick();
      office.commit();
    },
    async boot() {
      office.beginBoot();
      await source.poll();
      office.endBoot();
      office.tick();
      office.commit();
    },
    agent(id = ID): AgentInfo | undefined {
      return office.commit().snapshot.agents.find((a) => a.id === `cursor-local:${id}`);
    },
    room(a: AgentInfo | undefined) {
      return office.commit().snapshot.rooms.find((r) => r.id === a?.roomId);
    },
  };
  return t;
}

describe('fonte do Cursor (local)', () => {
  it('conversa recente entra na sala do projeto (caminho tirado das ferramentas), com título e números', async () => {
    const t = setup();
    const f = t.file();
    t.write(f, user('arruma o checkout') + tool('Read', { path: 'C:\\Users\\jonyy\\ot\\MercadoHub\\src\\a.ts' }) + say('Pronto.') + end(), T0 - 5 * MIN);
    await t.boot();
    const a = t.agent();
    expect(a?.provider).toBe('cursor');
    expect(a?.account).toBe(CURSOR_LOCAL_ACCOUNT);
    expect(a?.status).toBe('idle');
    expect(a?.title).toBe('arruma o checkout');
    expect(a?.stats?.toolCalls).toBe(1);
    expect(t.room(a)?.path).toBe('/mnt/c/Users/jonyy/ot/MercadoHub');
    expect(t.source.transcriptPathOf(`cursor-local:${ID}`)).toBe(f);
    expect(t.source.sources()[0]).toMatchObject({ provider: 'cursor', sessions: 1, ok: true });
    const acc = t.accounts.list(new Map()).find((x) => x.id === CURSOR_LOCAL_ACCOUNT);
    expect(acc).toMatchObject({ short: 'R', name: 'Cursor', provider: 'cursor' });
  });

  it('turno ao vivo: trabalhando enquanto não chega o turn_ended; depois ocioso com "terminou"', async () => {
    const t = setup();
    const f = t.file();
    t.write(f, user('primeiro') + end(), T0 - 2 * MIN);
    await t.boot();
    expect(t.agent()?.status).toBe('idle');

    t.advance(10_000);
    t.write(f, user('roda os testes') + tool('Shell', { command: 'npm test', working_directory: 'C:\\Users\\jonyy\\ot\\MercadoHub' }));
    await t.poll();
    expect(t.agent()?.status).toBe('working');
    expect(t.agent()?.activity?.tool).toBe('Bash');

    t.advance(20_000);
    t.write(f, say('Todos passaram.') + end());
    await t.poll();
    expect(t.agent()?.status).toBe('idle');
    expect(t.agent()?.stats?.toolCalls).toBe(1);
  });

  it('turno sem fim e arquivo parado há mais de 10 min = ocioso; parado há mais de 30 min = sai', async () => {
    const t = setup();
    const f = t.file();
    t.write(f, user('algo'), T0 - MIN);
    await t.boot();
    expect(t.agent()?.status).toBe('working');
    t.advance(11 * MIN);
    await t.poll();
    expect(t.agent()?.status).toBe('idle');
    t.advance(25 * MIN);
    await t.poll();
    expect(t.agent()?.status ?? 'offline').toBe('offline');
    // Voltou a mexer: entra de novo.
    t.write(f, user('de novo'));
    await t.poll();
    expect(t.agent()?.status).toBe('working');
  });

  it('conversa antiga fica fora; projeto sem caminho nas ferramentas usa outra conversa dele ou /cursor/<slug>', async () => {
    const t = setup();
    t.write(t.file(SLUG, 'velha'), user('x') + tool('Read', { path: 'C:\\Users\\jonyy\\ot\\MercadoHub\\b.ts' }) + end(), T0 - 2 * 60 * MIN);
    t.write(t.file(SLUG, 'nova'), user('pergunta') + say('resposta') + end(), T0 - MIN);
    t.write(t.file('c-Brain', 'b1'), user('oi') + end(), T0 - MIN);
    await t.boot();
    expect(t.agent('velha')).toBeUndefined();
    expect(t.room(t.agent('nova'))?.path).toBe('/mnt/c/Users/jonyy/ot/MercadoHub');
    expect(t.room(t.agent('b1'))?.path).toBe('/cursor/c-Brain');
  });

  it('linha pela metade espera o resto; arquivo apagado sai do escritório', async () => {
    const t = setup();
    const f = t.file();
    t.write(f, user('a') + end(), T0 - MIN);
    await t.boot();
    const half = user('segunda');
    t.write(f, half.slice(0, 20));
    await t.poll();
    expect(t.agent()?.status).toBe('idle');
    t.write(f, half.slice(20));
    await t.poll();
    expect(t.agent()?.status).toBe('working');
    rmSync(f);
    await t.poll();
    expect(t.agent()?.status ?? 'offline').toBe('offline');
    expect(t.source.transcriptPathOf(`cursor-local:${ID}`)).toBeUndefined();
  });
});
