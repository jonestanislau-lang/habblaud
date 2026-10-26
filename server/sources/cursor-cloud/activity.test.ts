import { describe, expect, it } from 'vitest';
import { cursorToolName, describeCursorTool } from './activity';

describe('ferramentas do Cursor (nuvem) no formato do escritório', () => {
  it('nomes do Cursor viram os do Claude Code', () => {
    expect(cursorToolName('read_file')).toBe('Read');
    expect(cursorToolName('run_terminal_cmd')).toBe('Bash');
    expect(cursorToolName('edit_file')).toBe('Edit');
    expect(cursorToolName('grep_search')).toBe('Grep');
    expect(cursorToolName('codebase_search')).toBe('Grep');
    expect(cursorToolName('list_dir')).toBe('LS');
    expect(cursorToolName('web_search')).toBe('WebSearch');
    expect(cursorToolName('mcp')).toBe('mcp');
  });

  it('argumentos do Cursor (path, target_file, query, cmd) viram os que o descritivo lê', () => {
    const read = describeCursorTool('read_file', { path: 'src/app.ts' });
    expect(read.tool).toBe('Read');
    expect(`${read.desc.text} ${read.desc.detail ?? ''}`).toContain('app.ts');
    const edit = describeCursorTool('edit_file', { target_file: 'README.md' });
    expect(`${edit.desc.text} ${edit.desc.detail ?? ''}`).toContain('README.md');
    const bash = describeCursorTool('run_terminal_cmd', { command: 'npm test' });
    expect(bash.tool).toBe('Bash');
    expect(`${bash.desc.text} ${bash.desc.detail ?? ''}`).toContain('npm test');
    const grep = describeCursorTool('grep', { query: 'TODO' });
    expect(`${grep.desc.text} ${grep.desc.detail ?? ''}`).toContain('TODO');
  });

  it('ferramenta desconhecida e argumentos ausentes ou estranhos não quebram', () => {
    expect(describeCursorTool('mcp', undefined).desc.text).toContain('mcp');
    expect(describeCursorTool('read_file', 'texto').tool).toBe('Read');
    expect(describeCursorTool('read_file', null).desc.text).toBeTruthy();
  });
});
