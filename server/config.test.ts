import { describe, expect, it } from 'vitest';
import { DEFAULT_CURSOR_API_URL, parseCursorCloudConfig, parseCursorRooms } from './config';

describe('config: agentes na nuvem do Cursor', () => {
  it('sem chave: desligado e sem aviso', () => {
    expect(parseCursorCloudConfig({})).toEqual({});
    expect(parseCursorCloudConfig({ CURSOR_API_KEY: '  ' })).toEqual({});
  });

  it('CURSOR_API_KEY (ou HABBLAUD_CURSOR_API_KEY, que vence) liga com os padrões', () => {
    expect(parseCursorCloudConfig({ CURSOR_API_KEY: 'k1' }).config).toEqual({ apiKey: 'k1', baseUrl: DEFAULT_CURSOR_API_URL, pollMs: 30_000, idleMs: 2 * 3_600_000, rooms: {} });
    expect(parseCursorCloudConfig({ CURSOR_API_KEY: 'k1', HABBLAUD_CURSOR_API_KEY: 'k2' }).config?.apiKey).toBe('k2');
  });

  it('HABBLAUD_CURSOR_CLOUD=0 desliga (com aviso, sem a chave)', () => {
    const r = parseCursorCloudConfig({ CURSOR_API_KEY: 'segredo', HABBLAUD_CURSOR_CLOUD: '0' });
    expect(r.config).toBeUndefined();
    expect(r.warning).toBeTruthy();
    expect(r.warning).not.toContain('segredo');
    expect(parseCursorCloudConfig({ CURSOR_API_KEY: 'k', HABBLAUD_CURSOR_CLOUD: '1' }).config).toBeTruthy();
  });

  it('intervalo (mínimo 10 s), janela de ocioso e URL da API (https, ou http só local)', () => {
    const base = { CURSOR_API_KEY: 'k' };
    expect(parseCursorCloudConfig({ ...base, HABBLAUD_CURSOR_CLOUD_POLL_SECONDS: '2' }).config?.pollMs).toBe(10_000);
    expect(parseCursorCloudConfig({ ...base, HABBLAUD_CURSOR_CLOUD_POLL_SECONDS: '60' }).config?.pollMs).toBe(60_000);
    expect(parseCursorCloudConfig({ ...base, HABBLAUD_CURSOR_CLOUD_IDLE_HOURS: '0.5' }).config?.idleMs).toBe(1_800_000);
    expect(parseCursorCloudConfig({ ...base, HABBLAUD_CURSOR_API_URL: 'http://127.0.0.1:9999/' }).config?.baseUrl).toBe('http://127.0.0.1:9999');
    expect(parseCursorCloudConfig({ ...base, HABBLAUD_CURSOR_API_URL: 'http://exemplo.com' }).warning).toBeTruthy();
    expect(parseCursorCloudConfig({ ...base, HABBLAUD_CURSOR_API_URL: 'lixo' }).config).toBeUndefined();
  });

  it('HABBLAUD_CURSOR_CLOUD_ROOMS: repo (ou dono/repo) → pasta local', () => {
    expect(parseCursorRooms('Jonas/MercadoHub=/home/j/mercadohub, outro=/srv/outro,semigual,x=relativo')).toEqual({
      'jonas/mercadohub': '/home/j/mercadohub',
      outro: '/srv/outro',
    });
    expect(parseCursorRooms(undefined)).toEqual({});
    expect(parseCursorCloudConfig({ CURSOR_API_KEY: 'k', HABBLAUD_CURSOR_CLOUD_ROOMS: 'r=/p' }).config?.rooms).toEqual({ r: '/p' });
  });
});
