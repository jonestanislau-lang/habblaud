// Atividade de uma ferramenta de um agente na nuvem do Cursor no formato do escritório (shared/activity.ts): os nomes
// das ferramentas do Cursor (read_file, run_terminal_cmd, grep...) viram os do Claude Code, para o mesmo texto e
// ícone; o resto cai no descritivo genérico.
import { describeTool, type ActivityDescription } from '../../../shared/activity';

/** Nome normalizado (minúsculas, sem _ - nem espaços) → nome do Claude Code. */
const TOOL_NAMES: Record<string, string> = {
  read: 'Read',
  readfile: 'Read',
  readfilev2: 'Read',
  edit: 'Edit',
  editfile: 'Edit',
  editfilev2: 'Edit',
  strreplace: 'Edit',
  searchreplace: 'Edit',
  multiedit: 'Edit',
  applypatch: 'Edit',
  write: 'Write',
  writefile: 'Write',
  createfile: 'Write',
  shell: 'Bash',
  bash: 'Bash',
  terminal: 'Bash',
  runterminalcmd: 'Bash',
  runterminalcommand: 'Bash',
  runterminalcommandv2: 'Bash',
  grep: 'Grep',
  grepsearch: 'Grep',
  ripgrep: 'Grep',
  codebasesearch: 'Grep',
  semanticsearch: 'Grep',
  semsearch: 'Grep',
  glob: 'Glob',
  globfilesearch: 'Glob',
  filesearch: 'Glob',
  ls: 'LS',
  listdir: 'LS',
  listdirectory: 'LS',
  websearch: 'WebSearch',
  webfetch: 'WebFetch',
  fetch: 'WebFetch',
  todowrite: 'TodoWrite',
  todo: 'TodoWrite',
  updatetodos: 'TodoWrite',
  task: 'Agent',
  subagent: 'Agent',
};

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Nome do Claude Code equivalente ao nome bruto de uma ferramenta do Cursor (ou o próprio nome). */
export function cursorToolName(name: string): string {
  return TOOL_NAMES[name.toLowerCase().replace(/[\s_-]+/g, '')] ?? name;
}

/** Argumentos de uma ferramenta do Cursor com os nomes do Claude Code (file_path, pattern, query, command). */
export function normalizeCursorInput(args: unknown): Record<string, unknown> {
  const input = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  // O Cursor chama o arquivo de target_file / targetFile / path; o comando de command; a busca de query.
  const file = str(input.file_path) ?? str(input.target_file) ?? str(input.targetFile) ?? str(input.filePath) ?? str(input.path);
  const normalized: Record<string, unknown> = { ...input };
  if (file && normalized.file_path === undefined) normalized.file_path = file;
  if (normalized.pattern === undefined) {
    const pattern = str(input.query) ?? str(input.glob_pattern) ?? str(input.globPattern) ?? str(input.regex);
    if (pattern) normalized.pattern = pattern;
  }
  if (normalized.query === undefined && str(input.search_term)) normalized.query = input.search_term;
  if (normalized.command === undefined && str(input.cmd)) normalized.command = input.cmd;
  return normalized;
}

/** Descrição da chamada `name` (nome bruto do Cursor) com os argumentos `args`; `tool` é o nome normalizado. */
export function describeCursorTool(name: string, args: unknown): { desc: ActivityDescription; tool: string } {
  const tool = cursorToolName(name);
  return { desc: describeTool(tool, normalizeCursorInput(args)), tool };
}
