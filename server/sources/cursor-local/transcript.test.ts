import { describe, expect, it } from 'vitest';
import {
  createCursorTerminalParser,
  cursorSlug,
  localPath,
  parseCursorLine,
  projectDirFromLine,
  projectDirFromPath,
  userQuery,
} from './transcript';

const user = (text: string) => JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text }] } });
const assistant = (content: unknown[]) => JSON.stringify({ role: 'assistant', message: { content } });

describe('Cursor (local): transcript', () => {
  it('interpreta pedido, resposta com ferramentas e fim do turno', () => {
    expect(parseCursorLine(user('<user_info>OS</user_info>\n<user_query>\nconserta o login\n</user_query>'))).toEqual({ kind: 'user', text: 'conserta o login' });
    expect(
      parseCursorLine(assistant([{ type: 'text', text: ' Vou ler. ' }, { type: 'tool_use', name: 'Read', input: { path: 'C:\\app\\a.ts' } }])),
    ).toEqual({ kind: 'assistant', texts: ['Vou ler.'], tools: [{ name: 'Read', input: { path: 'C:\\app\\a.ts' } }] });
    expect(parseCursorLine('{"type":"turn_ended","status":"success"}')).toEqual({ kind: 'end', ok: true });
    expect(parseCursorLine('{"type":"turn_ended","status":"error","error":"boom"}')).toEqual({ kind: 'end', ok: false, error: 'boom' });
    expect(parseCursorLine('lixo')).toBeUndefined();
    expect(parseCursorLine('{"role":"system"}')).toBeUndefined();
    expect(userQuery('sem marcação')).toBe('sem marcação');
  });

  it('slug e pasta do projeto: Windows, WSL e Linux', () => {
    expect(cursorSlug('C:\\Users\\jonyy\\OneDrive\\Área de Trabalho\\ot\\MercadoHub')).toBe('c-Users-jonyy-OneDrive-rea-de-Trabalho-ot-MercadoHub');
    expect(projectDirFromPath('c-Users-jonyy-OneDrive-rea-de-Trabalho-ot-MercadoHub', 'C:\\Users\\jonyy\\OneDrive\\Área de Trabalho\\ot\\MercadoHub\\src\\a.ts')).toBe(
      'C:/Users/jonyy/OneDrive/Área de Trabalho/ot/MercadoHub',
    );
    expect(projectDirFromPath('c-Brain', 'c:/Brain/notes.md')).toBe('c:/Brain');
    expect(projectDirFromPath('c-Brain', 'D:\\Brain\\x')).toBeUndefined();
    expect(projectDirFromPath('home-eu-app', '/home/eu/app/src/x.ts')).toBe('/home/eu/app');
    expect(projectDirFromPath('home-eu-app', 'src/x.ts')).toBeUndefined();
    expect(localPath('C:/Users/jonyy/app', 'linux')).toBe('/mnt/c/Users/jonyy/app');
    expect(localPath('\\\\wsl.localhost\\Ubuntu\\home\\eu\\app', 'linux')).toBe('/home/eu/app');
    expect(localPath('/home/eu/app', 'linux')).toBe('/home/eu/app');
    expect(projectDirFromLine('c-app', parseCursorLine(assistant([{ type: 'tool_use', name: 'Shell', input: { command: 'ls', working_directory: 'C:\\app' } }])))).toBe(
      'C:/app',
    );
  });

  it('terminal só de leitura: pedido, resposta, ferramenta e erro', () => {
    const p = createCursorTerminalParser(() => 1_000);
    const a = p.push(user('<user_query>oi</user_query>'));
    expect(a).toMatchObject([{ kind: 'user', at: 1_000 }]);
    const b = p.push(assistant([{ type: 'text', text: 'feito' }, { type: 'tool_use', name: 'Shell', input: { command: 'npm test' } }]));
    expect(b.map((e) => e.kind)).toEqual(['assistant', 'tool']);
    expect(b[1]).toMatchObject({ tool: 'Bash' });
    expect(p.push('{"type":"turn_ended","status":"success"}')).toEqual([]);
    expect(p.push('{"type":"turn_ended","status":"error"}')).toMatchObject([{ kind: 'system', level: 'error' }]);
  });
});
