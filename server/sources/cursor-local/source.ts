// Fonte dos agentes LOCAIS do Cursor (AgentSource 'cursor', ver sources/source.ts): as conversas do editor e do
// cursor-agent, lidas dos arquivos em <pasta do Cursor>/projects/<slug>/agent-transcripts/ (formato em transcript.ts).
// - A cada `pollMs` (padrão 3 s) lista os transcripts e lê só o que foi acrescentado (o começo de um arquivo novo, só o
//   fim: TAIL_BYTES). Funciona com as pastas do Windows vistas do WSL ou montadas no Docker (/mnt/c/...), sem SQLite.
// - Não há horários no arquivo: presença e status vêm do mtime. Arquivo mexido há menos de `idleMs` (padrão 30 min) =
//   agente no escritório; última linha do turno sem o turn_ended e mexido há menos de `stallMs` = trabalhando; senão,
//   ocioso. Depois de `idleMs` parado, sai.
// - Sala: a pasta do projeto, achada nos caminhos absolutos dos argumentos das ferramentas (o slug não volta a ser
//   caminho); sem nenhum, /cursor/<slug>.
// - Só observação: nada é escrito na pasta do Cursor; sem mensagens nem terminal interativo (o terminal só mostra a
//   conversa).
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { SourceInfo } from '../../../shared/types';
import { tr } from '../../../shared/i18n';
import { describePrompt, SPECIAL, truncate } from '../../../shared/activity';
import type { AccountsService } from '../../accounts/service';
import { errMsg, log } from '../../log';
import type { Office } from '../../model/office';
import type { AgentSource } from '../source';
import type { TerminalParser } from '../terminal';
import { describeCursorTool } from '../cursor-cloud/activity';
import { createCursorTerminalParser, localPath, parseCursorLine, projectDirFromLine, type CursorLine } from './transcript';

export const CURSOR_LOCAL_ACCOUNT = '.cursor';
export const POLL_MS = 3_000;
export const IDLE_MS = 30 * 60_000;
export const STALL_MS = 10 * 60_000;
/** Arquivo visto pela primeira vez: lê só o fim dele (o histórico recente). */
export const TAIL_BYTES = 512 * 1024;
/** Para achar a pasta de um projeto: quantos transcripts dele (os mais recentes) e quanto do começo de cada um. */
const RESOLVE_FILES = 4;
const RESOLVE_BYTES = 256 * 1024;
/** Projeto sem caminho achado: tenta de novo depois disto. */
const RESOLVE_RETRY_MS = 5 * 60_000;
const ROLE = tr('Agente local (Cursor)');

export interface CursorLocalTiming {
  pollMs: number;
  idleMs: number;
  stallMs: number;
}

export interface CursorLocalSourceOptions {
  accounts: AccountsService;
  office: Office;
  /** Pastas do Cursor (as que têm projects/; files.ts). */
  dirs: string[];
  now?: () => number;
  timing?: Partial<CursorLocalTiming>;
  platform?: NodeJS.Platform;
}

interface Track {
  key: string;
  id: string;
  root: string;
  slug: string;
  path: string;
  /** Bytes já lidos (início da próxima leitura). */
  offset: number;
  /** Linha incompleta no fim da última leitura. */
  partial: string;
  size: number;
  mtimeMs: number;
  /** Já leu alguma vez (o começo de um arquivo novo é histórico). */
  read: boolean;
  inOffice: boolean;
  /** Última linha relevante: o turno está aberto (user/assistant) ou fechado (end). */
  last?: 'user' | 'assistant' | 'end';
  turnStart?: number;
  title?: string;
  toolCalls: number;
  subagents: number;
}

interface Project {
  /** Pasta como aparece no transcript (C:/Users/eu/app) e como este processo a enxerga (/mnt/c/Users/eu/app). */
  dir?: string;
  cwd?: string;
  triedAt?: number;
}

/** Linha lida com a posição dela no arquivo (o id das atividades). */
interface Parsed {
  at: number;
  pos: number;
  line: CursorLine;
}

export class CursorLocalSource implements AgentSource {
  readonly provider = 'cursor' as const;
  private readonly accountId: string;
  private readonly now: () => number;
  private readonly timing: CursorLocalTiming;
  private readonly platform: NodeJS.Platform;
  private readonly tracks = new Map<string, Track>();
  private readonly projects = new Map<string, Project>();
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private polling: Promise<void> | null = null;
  private error?: string;

  constructor(private readonly opts: CursorLocalSourceOptions) {
    this.now = opts.now ?? Date.now;
    this.platform = opts.platform ?? process.platform;
    this.timing = { pollMs: POLL_MS, idleMs: IDLE_MS, stallMs: STALL_MS, ...opts.timing };
    const [entry] = opts.accounts.setProviderAccounts(
      'cursor',
      [{ dir: opts.dirs[0] ?? '', detected: { id: CURSOR_LOCAL_ACCOUNT, configDir: opts.dirs[0] ?? '', short: 'R', name: 'Cursor', color: '#9aa4ff' } }],
      'cursor-local',
    );
    this.accountId = entry!.id;
  }

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
  }

  sources(): SourceInfo[] {
    let sessions = 0;
    for (const t of this.tracks.values()) if (t.inOffice) sessions++;
    return this.opts.dirs.map((dir, i) => {
      const info: SourceInfo = { label: this.accountId, provider: 'cursor', path: dir, sessions: i === 0 ? sessions : 0, ok: !this.error };
      if (this.error) info.error = this.error;
      return info;
    });
  }

  transcriptPathOf(agentId: string): string | undefined {
    const t = this.tracks.get(agentId);
    return t?.inOffice ? t.path : undefined;
  }

  terminalParser(agentId: string): TerminalParser | undefined {
    const t = this.tracks.get(agentId);
    if (!t) return undefined;
    return createCursorTerminalParser(() => t.mtimeMs, this.projects.get(this.projectKey(t))?.dir);
  }

  /** Uma rodada agora (testes e o boot); rodadas não se sobrepõem. */
  poll(): Promise<void> {
    if (!this.polling) {
      this.polling = this.pollOnce()
        .then(() => {
          this.error = undefined;
        })
        .catch((err) => {
          this.error = errMsg(err);
          log.warn(tr('Cursor (local): falha ao ler as conversas: {0}', [this.error]));
        })
        .finally(() => {
          this.polling = null;
        });
    }
    return this.polling;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll().finally(() => this.schedule());
    }, this.timing.pollMs);
    this.timer.unref?.();
  }

  private projectKey(t: Pick<Track, 'root' | 'slug'>): string {
    return `${t.root}\u0000${t.slug}`;
  }

  private async pollOnce(): Promise<void> {
    const seen = new Set<string>();
    for (const root of this.opts.dirs) {
      const projectsDir = join(root, 'projects');
      for (const slug of await listDirs(projectsDir)) {
        const tdir = join(projectsDir, slug, 'agent-transcripts');
        for (const f of await listTranscripts(tdir)) {
          const key = `cursor-local:${f.id}`;
          if (seen.has(key)) continue;
          const st = await stat(f.path).catch(() => undefined);
          if (!st?.isFile()) continue;
          seen.add(key);
          let t = this.tracks.get(key);
          if (!t || t.path !== f.path) {
            if (t) this.leave(t);
            t = { key, id: f.id, root, slug, path: f.path, offset: 0, partial: '', size: 0, mtimeMs: 0, read: false, inOffice: false, toolCalls: 0, subagents: 0 };
            this.tracks.set(key, t);
          }
          await this.update(t, st.size, st.mtimeMs);
        }
      }
    }
    for (const t of [...this.tracks.values()]) {
      if (seen.has(t.key)) continue;
      this.leave(t);
      this.tracks.delete(t.key);
    }
  }

  private async update(t: Track, size: number, mtimeMs: number): Promise<void> {
    const now = this.now();
    if (now - mtimeMs > this.timing.idleMs) {
      // Parado: sai. O arquivo não é lido (nem guardado): se voltar a mexer, entra com o fim dele.
      this.leave(t);
      t.read = false;
      t.offset = 0;
      t.partial = '';
      t.mtimeMs = mtimeMs;
      t.size = size;
      return;
    }
    const changed = !t.read || size !== t.size || mtimeMs !== t.mtimeMs;
    t.mtimeMs = mtimeMs;
    let lines: Parsed[] = [];
    let history = !t.read;
    if (changed) {
      if (t.read && size < t.offset) {
        // Arquivo recriado/encurtado: relê o fim.
        t.read = false;
        history = true;
      }
      lines = await this.readNew(t, size, history ? mtimeMs : now);
      t.size = size;
    }
    const project = await this.project(t, lines);
    if (!t.inOffice || !this.opts.office.has(t.key)) this.enter(t, project);
    for (const p of lines) this.event(t, p, !history && !this.opts.office.isBooting());
    this.settle(t);
  }

  /** Lê de `t.offset` até `size` (arquivo novo: só o fim) e devolve as linhas completas interpretadas. */
  private async readNew(t: Track, size: number, at: number): Promise<Parsed[]> {
    let start = t.read ? t.offset : Math.max(0, size - TAIL_BYTES);
    if (!t.read) t.partial = '';
    const fresh = !t.read;
    t.read = true;
    if (size <= start) {
      t.offset = size;
      return [];
    }
    const buf = await readRange(t.path, start, size - start);
    let text = buf.toString('utf8');
    if (fresh && start > 0) {
      // Começou no meio de uma linha: pula até a próxima.
      const nl = text.indexOf('\n');
      if (nl < 0) {
        t.offset = size;
        return [];
      }
      start += Buffer.byteLength(text.slice(0, nl + 1));
      text = text.slice(nl + 1);
    }
    t.offset = size;
    const all = t.partial + text;
    let pos = start - Buffer.byteLength(t.partial);
    const pieces = all.split('\n');
    let tail = pieces.pop() ?? '';
    const out: Parsed[] = [];
    for (const piece of pieces) {
      const line = parseCursorLine(piece);
      if (line) out.push({ at, pos, line });
      pos += Buffer.byteLength(piece) + 1;
    }
    // Última linha sem "\n": vale se já é um JSON completo.
    if (tail.trim()) {
      const line = parseCursorLine(tail);
      if (line) {
        out.push({ at, pos, line });
        tail = '';
      }
    }
    t.partial = tail;
    return out;
  }

  /** Pasta do projeto: dos caminhos nas linhas novas, do cache ou dos outros transcripts do projeto. */
  private async project(t: Track, lines: Parsed[]): Promise<Project> {
    const key = this.projectKey(t);
    const p = this.projects.get(key) ?? {};
    this.projects.set(key, p);
    if (p.dir) return p;
    for (const l of lines) {
      const dir = projectDirFromLine(t.slug, l.line);
      if (dir) return this.resolved(p, dir);
    }
    const now = this.now();
    if (p.triedAt !== undefined && now - p.triedAt < RESOLVE_RETRY_MS) return p;
    p.triedAt = now;
    const files = await listTranscripts(join(t.root, 'projects', t.slug, 'agent-transcripts'));
    const dated = await Promise.all(files.map(async (f) => ({ f, m: (await stat(f.path).catch(() => undefined))?.mtimeMs ?? 0 })));
    dated.sort((a, b) => b.m - a.m);
    for (const { f } of dated.slice(0, RESOLVE_FILES)) {
      const size = (await stat(f.path).catch(() => undefined))?.size ?? 0;
      if (!size) continue;
      const buf = await readRange(f.path, 0, Math.min(size, RESOLVE_BYTES)).catch(() => undefined);
      for (const raw of buf?.toString('utf8').split('\n') ?? []) {
        const dir = projectDirFromLine(t.slug, parseCursorLine(raw));
        if (dir) return this.resolved(p, dir);
      }
    }
    return p;
  }

  private resolved(p: Project, dir: string): Project {
    p.dir = dir;
    p.cwd = localPath(dir, this.platform);
    return p;
  }

  private enter(t: Track, project: Project): void {
    this.opts.office.addMain({
      id: t.key,
      provider: 'cursor',
      account: this.accountId,
      sessionId: t.id,
      cwd: project.cwd ?? `/cursor/${t.slug}`,
      role: ROLE,
      startedAt: t.mtimeMs,
      status: 'idle',
    });
    t.inOffice = true;
  }

  private event(t: Track, p: Parsed, live: boolean): void {
    const { office } = this.opts;
    const id = `${t.key}#${p.pos}`;
    const line = p.line;
    if (line.kind === 'user') {
      if (!line.text) return;
      t.last = 'user';
      t.turnStart = p.at;
      if (!t.title) t.title = truncate(line.text.replace(/\s+/g, ' '), 120);
      if (live) office.setStatus(t.key, 'working');
      office.addActivity(t.key, { id, at: p.at, ...describePrompt(line.text) }, true, { feed: live });
      return;
    }
    if (line.kind === 'assistant') {
      t.last = 'assistant';
      if (live && office.get(t.key)?.status !== 'working') office.setStatus(t.key, 'working');
      line.texts.forEach((text, i) => office.addActivity(t.key, { id: `${id}:t${i}`, at: p.at, ...SPECIAL.respond(truncate(text, 300)) }, true, { feed: live }));
      line.tools.forEach((call, i) => {
        const { desc, tool } = describeCursorTool(call.name, call.input);
        t.toolCalls++;
        if (tool === 'Agent') t.subagents++;
        office.addActivity(t.key, { id: `${id}:u${i}`, at: p.at, ...desc, tool }, true, { feed: live });
      });
      return;
    }
    // Fim do turno.
    const wasOpen = t.last !== 'end';
    t.last = 'end';
    if (live) office.setStatus(t.key, 'idle');
    if (!wasOpen && !line.error) return;
    if (!line.ok) {
      office.addActivity(t.key, { id, at: p.at, ...SPECIAL.error(undefined, line.error ? truncate(line.error, 300) : undefined), error: true }, true, { feed: live });
      return;
    }
    const took = live && t.turnStart !== undefined ? Math.max(0, p.at - t.turnStart) : undefined;
    office.addActivity(t.key, { id, at: p.at, ...SPECIAL.turnDone(took), ...(took ? { durationMs: took } : {}) }, true, { feed: live });
  }

  /** Status pelo fim do turno e pelo mtime; título e números. */
  private settle(t: Track): void {
    const { office } = this.opts;
    if (!t.inOffice || !office.has(t.key)) return;
    const open = t.last === 'user' || t.last === 'assistant';
    const working = open && this.now() - t.mtimeMs < this.timing.stallMs;
    const cur = office.get(t.key)?.status;
    if (working) {
      if (cur !== 'working') office.setStatus(t.key, 'working');
      office.fillWorkingActivity(t.key);
    } else if (cur !== 'idle') office.setStatus(t.key, 'idle');
    const prev = office.get(t.key);
    office.applyTranscript(t.key, {
      ...(t.title ? { title: t.title } : {}),
      tasks: [],
      // O transcript local não traz tokens.
      stats: { ...(prev?.stats ?? { tokensIn: 0, tokensOut: 0 }), toolCalls: t.toolCalls, subagents: t.subagents },
      lastAt: t.mtimeMs,
    });
  }

  private leave(t: Track): void {
    if (!t.inOffice) return;
    t.inOffice = false;
    t.last = undefined;
    t.title = undefined;
    t.toolCalls = 0;
    t.subagents = 0;
    this.opts.office.closeMain(t.key);
  }
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/** Transcripts de um projeto: <id>/<id>.jsonl (atual) ou <id>.jsonl solto (versões antigas). Sem os dos subagentes. */
async function listTranscripts(dir: string): Promise<Array<{ id: string; path: string }>> {
  let ents;
  try {
    ents = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Array<{ id: string; path: string }> = [];
  for (const e of ents) {
    if (e.isDirectory()) out.push({ id: e.name, path: join(dir, e.name, `${e.name}.jsonl`) });
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push({ id: e.name.slice(0, -'.jsonl'.length), path: join(dir, e.name) });
  }
  return out;
}

async function readRange(path: string, start: number, length: number): Promise<Buffer> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}
