import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cursorLocalDisabled, cursorRoot, discoverCursorDirs, isWsl, windowsCursorDirs } from './files';

let tmp: string[] = [];
afterEach(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
  tmp = [];
});
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), 'habblaud-cursor-local-'));
  tmp.push(d);
  return d;
}

describe('Cursor (local): pastas', () => {
  it('acha ~/.cursor, aceita a pasta projects e o override HABBLAUD_CURSOR_DIRS', () => {
    const home = dir();
    mkdirSync(join(home, '.cursor', 'projects'), { recursive: true });
    expect(cursorRoot(join(home, '.cursor'))).toBe(join(home, '.cursor'));
    expect(cursorRoot(join(home, '.cursor', 'projects'))).toBe(join(home, '.cursor'));
    expect(cursorRoot(home)).toBeUndefined();
    expect(discoverCursorDirs({}, home, { wsl: false })).toEqual([join(home, '.cursor')]);
    const other = dir();
    mkdirSync(join(other, 'projects'));
    expect(discoverCursorDirs({ HABBLAUD_CURSOR_DIRS: join(other, 'projects') }, home, { wsl: true, usersDir: '/nao/existe' })).toEqual([other]);
    expect(discoverCursorDirs({ HABBLAUD_CURSOR_DIRS: '/nao/existe' }, home, { wsl: false })).toEqual([]);
  });

  it('no WSL acha C:\\Users\\<nome>\\.cursor (sem Public/Default)', () => {
    const users = dir();
    mkdirSync(join(users, 'jonyy', '.cursor', 'projects'), { recursive: true });
    mkdirSync(join(users, 'Public', '.cursor', 'projects'), { recursive: true });
    mkdirSync(join(users, 'outro'), { recursive: true });
    expect(windowsCursorDirs(users)).toEqual([join(users, 'jonyy', '.cursor')]);
    const home = dir();
    expect(discoverCursorDirs({}, home, { wsl: true, usersDir: users })).toEqual([join(users, 'jonyy', '.cursor')]);
    expect(discoverCursorDirs({}, home, { wsl: false, usersDir: users })).toEqual([]);
    expect(isWsl({ WSL_DISTRO_NAME: 'Ubuntu' })).toBe(true);
  });

  it('HABBLAUD_CURSOR=0 desliga', () => {
    expect(cursorLocalDisabled({ HABBLAUD_CURSOR: '0' })).toBe(true);
    expect(cursorLocalDisabled({ HABBLAUD_CURSOR: 'off' })).toBe(true);
    expect(cursorLocalDisabled({})).toBe(false);
  });
});
