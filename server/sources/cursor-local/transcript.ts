// Conversas locais do Cursor (editor e cursor-agent): ~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl.
// O editor e a CLI gravam o mesmo JSONL, uma mensagem por linha:
//   {"role":"user","message":{"content":[{"type":"text","text":"<user_query>…</user_query>"}]}}
//   {"role":"assistant","message":{"content":[{"type":"text","text":"…"},{"type":"tool_use","name":"Read","input":{…}}]}}
//   {"type":"turn_ended","status":"success"|"error","error":"…"}
// Não há horários nem resultados das ferramentas: o "quando" vem do mtime do arquivo (source.ts).
//
// O <slug> é o caminho da pasta aberta com tudo que não é letra/número virando "-" (C:\Users\eu\Área de Trabalho\app
// -> c-Users-eu-rea-de-Trabalho-app): não dá para voltar ao caminho. O caminho real sai dos argumentos das
// ferramentas (o primeiro caminho absoluto cujo prefixo gera o mesmo slug).
import type { TerminalEntry } from '../../../shared/types';
import { maskSecrets } from '../../../shared/activity';
import { marked, prepare, TEXT_MAX, toolView, type TerminalParser } from '../terminal';
import { cursorToolName, normalizeCursorInput } from '../cursor-cloud/activity';
import { tr } from '../../../shared/i18n';

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

/** Uma linha do transcript, já interpretada. */
export type CursorLine =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; texts: string[]; tools: Array<{ name: string; input: Rec }> }
  | { kind: 'end'; ok: boolean; error?: string };

/** Interpreta uma linha do JSONL; linhas inválidas ou de outro formato devolvem undefined. */
export function parseCursorLine(line: string): CursorLine | undefined {
  const t = line.trim();
  if (!t.startsWith('{')) return undefined;
  let o: Rec | undefined;
  try {
    o = rec(JSON.parse(t));
  } catch {
    return undefined;
  }
  if (!o) return undefined;
  if (o.type === 'turn_ended') {
    const error = str(o.error);
    return { kind: 'end', ok: o.status !== 'error', ...(error ? { error } : {}) };
  }
  const content = rec(o.message)?.content;
  const blocks: unknown[] = Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : [];
  if (o.role === 'user') {
    const text = blocks
      .map((b) => (rec(b)?.type === 'text' ? str(rec(b)?.text) : undefined))
      .filter((x): x is string => !!x)
      .join('\n');
    return { kind: 'user', text: userQuery(text) };
  }
  if (o.role === 'assistant') {
    const texts: string[] = [];
    const tools: Array<{ name: string; input: Rec }> = [];
    for (const b of blocks) {
      const r = rec(b);
      if (r?.type === 'text' && str(r.text)) texts.push(String(r.text).trim());
      else if (r?.type === 'tool_use' && str(r.name)) tools.push({ name: String(r.name), input: rec(r.input) ?? {} });
    }
    return { kind: 'assistant', texts, tools };
  }
  return undefined;
}

/** O pedido do usuário: o que está dentro de <user_query> (o resto é contexto injetado pelo Cursor). */
export function userQuery(text: string): string {
  const m = /<user_query>([\s\S]*?)(?:<\/user_query>|$)/.exec(text);
  return (m ? m[1]! : text).trim();
}

/** Slug do Cursor para um caminho (C:\Users\eu\app -> c-Users-eu-app; /home/eu/app -> home-eu-app). */
export function cursorSlug(path: string): string {
  return path
    .replace(/^([A-Za-z]):/, (_, d: string) => d.toLowerCase())
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Caminho como este processo o enxerga: no Linux/WSL (e no container), C:\x\y vira /mnt/c/x/y e \\wsl.localhost\<distro>\x
 * (ou \\wsl$\<distro>\x) vira /x — assim a sala é a mesma das sessões do Claude Code e do Codex abertas na pasta pelo WSL.
 * No Windows, fica como está.
 */
export function localPath(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return path;
  const p = path.replace(/\\/g, '/');
  const wsl = /^\/\/wsl(?:\.localhost|\$)\/[^/]+(\/.*)?$/i.exec(p);
  if (wsl) return (wsl[1] ?? '/').replace(/\/+$/, '') || '/';
  const drive = /^([A-Za-z]):(?:\/(.*))?$/.exec(p);
  if (drive) return `/mnt/${drive[1]!.toLowerCase()}${drive[2] ? `/${drive[2].replace(/\/+$/, '')}` : ''}`;
  return p.replace(/\/+$/, '') || '/';
}

/**
 * Pasta do projeto a partir de um caminho absoluto usado numa ferramenta: o prefixo do caminho cujo slug é `slug`
 * (comparação sem maiúsculas). Devolve o prefixo com as barras originais trocadas por "/" (C:/Users/eu/app), ou undefined.
 */
export function projectDirFromPath(slug: string, path: string): string | undefined {
  const p = path.trim().replace(/\\/g, '/');
  const want = slug.toLowerCase();
  let head: string;
  let rest: string;
  const drive = /^([A-Za-z]:)\/(.*)$/.exec(p);
  const wsl = /^(\/\/wsl(?:\.localhost|\$)\/[^/]+)\/(.*)$/i.exec(p);
  if (drive) [head, rest] = [drive[1]!, drive[2]!];
  else if (wsl) [head, rest] = [wsl[1]!, wsl[2]!];
  else if (p.startsWith('/')) [head, rest] = ['', p.slice(1)];
  else return undefined;
  const segs = rest.split('/').filter(Boolean);
  for (let i = segs.length; i >= 1; i--) {
    const prefix = `${head}/${segs.slice(0, i).join('/')}`;
    // Em \\wsl.localhost\<distro>\home\eu o slug é o do caminho dentro da distro (home-eu).
    const forSlug = wsl ? `/${segs.slice(0, i).join('/')}` : prefix;
    if (cursorSlug(forSlug).toLowerCase() === want) return prefix;
  }
  if (drive && cursorSlug(head).toLowerCase() === want) return `${head}/`;
  return undefined;
}

/** Caminhos absolutos citados nos argumentos de uma ferramenta (arquivo, pasta, diretório de trabalho). */
export function toolPaths(input: Rec): string[] {
  const out: string[] = [];
  for (const k of ['working_directory', 'cwd', 'target_directory', 'path', 'file_path', 'target_file', 'targetFile', 'filePath', 'directory']) {
    const v = str(input[k]);
    if (v && (/^[A-Za-z]:[\\/]/.test(v) || v.startsWith('/') || v.startsWith('\\\\'))) out.push(v);
  }
  return out;
}

/** Pasta do projeto de `slug` a partir de uma linha do transcript (undefined se ela não cita caminho do projeto). */
export function projectDirFromLine(slug: string, line: CursorLine | undefined): string | undefined {
  if (line?.kind !== 'assistant') return undefined;
  for (const t of line.tools) for (const p of toolPaths(t.input)) {
    const dir = projectDirFromPath(slug, p);
    if (dir) return dir;
  }
  return undefined;
}

/**
 * Terminal (só leitura) de uma conversa local do Cursor: prompts, respostas e chamadas de ferramenta (o transcript
 * não guarda os resultados). Sem horários no arquivo: `at` vem de quem cria o parser (o mtime do arquivo).
 */
export function createCursorTerminalParser(at: () => number, cwd?: string): TerminalParser {
  let n = 0;
  return {
    push(raw: string): TerminalEntry[] {
      const line = parseCursorLine(raw);
      if (!line) return [];
      const id = `c${++n}`;
      const when = at();
      if (line.kind === 'user') {
        if (!line.text) return [];
        return [{ kind: 'user', id, at: when, text: marked(prepare(line.text, TEXT_MAX)) }];
      }
      if (line.kind === 'end') {
        if (line.ok) return [];
        return [{ kind: 'system', id, at: when, text: maskSecrets(line.error ?? tr('A resposta terminou com erro')).slice(0, 300), level: 'error' }];
      }
      const out: TerminalEntry[] = [];
      line.texts.forEach((t, i) => out.push({ kind: 'assistant', id: `${id}.t${i}`, at: when, text: marked(prepare(t, TEXT_MAX)) }));
      line.tools.forEach((t, i) => {
        const view = toolView(cursorToolName(t.name), normalizeCursorInput(t.input), cwd);
        out.push({ kind: 'tool', id: `${id}.u${i}`, at: when, tool: cursorToolName(t.name), ...view });
      });
      return out;
    },
  };
}
