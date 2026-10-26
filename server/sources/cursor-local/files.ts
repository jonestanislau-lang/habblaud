// Onde estão as pastas do Cursor (as que têm projects/<slug>/agent-transcripts): HABBLAUD_CURSOR_DIRS (vírgulas) ou, sem
// ela, CURSOR_CONFIG_DIR e ~/.cursor; no WSL, também C:\Users\<você>\.cursor (em /mnt/c/Users/*/.cursor), onde o editor
// e o cursor-agent do Windows gravam as conversas. Só se lê projects/ (nunca credenciais, configurações nem os SQLite).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { expandHome } from '../../accounts/detect';

function splitList(v: string | undefined): string[] {
  return (v ?? '')
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Pasta do Cursor (a que tem projects/) a partir de um caminho dado: a própria pasta ou, se ele já é o projects/, o pai. */
export function cursorRoot(p: string): string | undefined {
  if (isDir(join(p, 'projects'))) return p;
  if (basename(p) === 'projects' && isDir(p)) return dirname(p);
  return undefined;
}

/** Roda no WSL (onde o C:\ do Windows aparece em /mnt/c)? */
export function isWsl(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.WSL_DISTRO_NAME?.trim() || env.WSL_INTEROP?.trim()) return true;
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

/** As pastas .cursor dos usuários do Windows vistas do WSL (/mnt/c/Users/<nome>/.cursor), menos as contas do sistema. */
export function windowsCursorDirs(usersDir = '/mnt/c/Users'): string[] {
  const out: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(usersDir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (/^(all users|default|default user|public|desktop\.ini)$/i.test(name)) continue;
    const root = cursorRoot(join(usersDir, name, '.cursor'));
    if (root) out.push(root);
  }
  return out;
}

/**
 * Pastas do Cursor a observar. HABBLAUD_CURSOR_DIRS manda (só as que existem e têm projects/); sem ela,
 * CURSOR_CONFIG_DIR, ~/.cursor e, no WSL, /mnt/c/Users/<nome>/.cursor.
 */
export function discoverCursorDirs(
  env: NodeJS.ProcessEnv = process.env,
  home: string = env.HOME || homedir(),
  opts: { wsl?: boolean; usersDir?: string } = {},
): string[] {
  const override = splitList(env.HABBLAUD_CURSOR_DIRS);
  const candidates = override.length ? override : [env.CURSOR_CONFIG_DIR?.trim() ?? '', join(home, '.cursor')].filter(Boolean);
  const found: string[] = [];
  for (const c of candidates) {
    const root = cursorRoot(resolve(expandHome(c, home)));
    if (root) found.push(root);
  }
  if (!override.length && (opts.wsl ?? isWsl(env))) found.push(...windowsCursorDirs(opts.usersDir));
  return [...new Set(found)].filter((p) => existsSync(p));
}

/** HABBLAUD_CURSOR desligado (0, false, off, no). */
export function cursorLocalDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.HABBLAUD_CURSOR?.trim();
  return !!v && /^(0|false|off|no|nao|não)$/i.test(v);
}
