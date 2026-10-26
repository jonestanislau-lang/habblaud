// De qual ferramenta é cada coisa (Claude Code ou Codex) e os textos que mudam com ela. Puro (sem DOM): testado em
// ui/provider.test.ts. No protocolo, `provider` ausente quer dizer Claude Code (shared/types.ts); aqui tudo cai nisso.
//
// Identidade visual do Codex (sem logotipo de ninguém): o chip da conta fica "vazado" (fundo escuro, borda e letra na
// cor da conta, cantos em degrau) e, onde há espaço, um selo de texto "Codex" ao lado do nome.
import type { AccountInfo, OfficeSnapshot, Provider } from '../../../shared/types';
import { shortcutHint } from './model';
import { tr } from '../../../shared/i18n';

/** Nome de cada ferramenta como aparece nos textos. */
export const PROVIDER_NAME: Record<Provider, string> = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' };

/** Ferramenta de um agente, conta, sessão ou pedido (ausente = Claude Code). */
export function providerOf(x: { provider?: Provider } | null | undefined): Provider {
  return x?.provider ?? 'claude';
}

export function isCodex(x: { provider?: Provider } | null | undefined): boolean {
  return x?.provider === 'codex';
}

/** Agente (ou conta) do Cursor, local ou na nuvem: só observação, sem aprovações nem mensagens pelo escritório. */
export function isCursor(x: { provider?: Provider } | null | undefined): boolean {
  return x?.provider === 'cursor';
}

/** Agente na nuvem do Cursor (conta "cursor-cloud"); os locais (editor e cursor-agent) são da conta ".cursor". */
export function isCursorCloud(x: { provider?: Provider; account?: string } | null | undefined): boolean {
  return x?.provider === 'cursor' && looksLikeCursorId(x.account ?? '');
}

/**
 * Tem terminal ao vivo pelo escritório? Os agentes na nuvem do Cursor não (rodam na nuvem, sem conversa local); os
 * locais do Cursor têm o terminal só de leitura (a conversa do arquivo), nunca o interativo.
 */
export function supportsLiveTerminal(provider: Provider, account = ''): boolean {
  return !(provider === 'cursor' && looksLikeCursorId(account));
}

/** Id da conta dos agentes na nuvem do Cursor ("cursor-cloud", "cursor-cloud~2", "demo:cursor-cloud")? */
export function looksLikeCursorId(id: string): boolean {
  return /(?:^|[:/\\])cursor-cloud(?:~\d+)?$/i.test(id);
}

/** Id da conta dos agentes locais do Cursor (".cursor", ".cursor~2", "demo:.cursor")? */
export function looksLikeLocalCursorId(id: string): boolean {
  return /(?:^|[:/\\])\.cursor(?:~\d+)?$/i.test(id);
}

/**
 * O id de conta tem cara de pasta do Codex (".codex", ".codex-trabalho", ".codex~2", "demo:.codex")? Só para quando a
 * conta já não está no snapshot (ex.: histórico, "Meu dia"): com a conta à mão, vale o `provider` dela.
 */
export function looksLikeCodexId(id: string): boolean {
  return /(?:^|[:/\\])\.?codex(?:[-_.~]|$)/i.test(id);
}

/** Ferramenta da conta: a do snapshot; sem ela, a dica de quem chamou ou o jeito do id. */
export function accountProvider(account: Pick<AccountInfo, 'provider'> | undefined, fallbackId = '', hint?: Provider): Provider {
  if (account) return providerOf(account);
  return hint ?? (looksLikeCodexId(fallbackId) ? 'codex' : looksLikeCursorId(fallbackId) || looksLikeLocalCursorId(fallbackId) ? 'cursor' : 'claude');
}

/**
 * Letra do chip de uma conta que não está no snapshot: a primeira letra depois do prefixo da pasta
 * (".claude-conta2" -> "C", ".codex-trabalho" -> "T"). A pasta padrão do Codex (".codex") vira "X"; a do Claude Code,
 * "?" (como antes). Nunca devolve "." nem vazio.
 */
export function fallbackShort(id: string, provider: Provider = accountProvider(undefined, id)): string {
  if (provider === 'cursor') return looksLikeCursorId(id) ? 'N' : 'R';
  const rest = id
    .replace(/^.*:/, '')
    .replace(/~\d+$/, '')
    .replace(/^\.?(?:claude|codex)(?=[-_.]|$)[-_.]?/i, '');
  const letter = /[\p{L}\p{N}]/u.exec(rest)?.[0];
  if (letter) return letter.toUpperCase();
  return provider === 'codex' ? 'X' : '?';
}

/**
 * O selo "Codex" ao lado do nome da conta (não repete quando o nome já diz "Codex"); o "Nuvem" dos agentes na nuvem do
 * Cursor sempre; o "Cursor" dos locais quando o nome não diz "Cursor".
 */
export function showsProviderTag(provider: Provider, accountName = '', accountId = ''): boolean {
  if (provider === 'cursor') return looksLikeCursorId(accountId) || !/cursor/i.test(accountName);
  return provider === 'codex' && !/codex/i.test(accountName);
}

/** Texto e dica do selo de uma ferramenta (o do Codex diz "Codex"; o do Cursor, se o agente roda na nuvem ou aqui). */
export function providerTagText(provider: Provider, accountId = ''): { text: string; title: string } {
  if (provider === 'cursor') {
    if (looksLikeCursorId(accountId)) return { text: tr('Nuvem'), title: tr('Agente na nuvem do Cursor (só observação)') };
    return { text: 'Cursor', title: tr('Agente do Cursor neste computador (só observação)') };
  }
  return { text: 'Codex', title: tr('Agente do Codex (OpenAI)') };
}

/** Rótulo do chip da conta (dica e leitores de tela): "Conta C (dev@x.com)", "Codex · plano Team". */
export function accountChipLabel(account: Pick<AccountInfo, 'name' | 'email' | 'plan' | 'provider'> | undefined, fallbackId: string, provider: Provider): string {
  if (!account) return fallbackId ? `${fallbackId}${provider === 'codex' ? ' · Codex' : ''}` : tr('Conta desconhecida');
  if (provider !== 'codex') return `${account.name}${account.email ? ` (${account.email})` : ''}`;
  const tag = showsProviderTag(provider, account.name) ? ' · Codex' : '';
  return `${account.name}${tag}${account.plan ? tr(' · plano {0}', [account.plan]) : ''}`;
}

/** Contas com cartão de uso. As do Cursor (nuvem e local) ficam de fora: não há uso de plano que o Habblaud leia (e o cartão ofereceria o "Como ativar" do mod). */
export function usageCardAccounts<T extends Pick<AccountInfo, 'provider'>>(accounts: readonly T[]): T[] {
  return accounts.filter((a) => a.provider !== 'cursor');
}

/**
 * Texto do escritório vazio. Os atalhos ("atalhos c ou d") são só das contas do Claude Code, que vêm de aliases do
 * shell (a letra de uma conta do Codex não é um atalho); o Codex só entra quando há uma conta dele.
 */
export function emptyOfficeHint(accounts: readonly Pick<AccountInfo, 'short' | 'provider'>[]): string {
  // As contas do Cursor também não têm atalho.
  const keys = shortcutHint(accounts.filter((a) => !isCodex(a) && !isCursor(a)));
  if (!accounts.some(isCodex)) return tr('Abra o Claude Code em qualquer projeto{0} e veja seu agente chegar.', [keys ? ` (${keys})` : '']);
  return tr('Abra o Claude Code{0} ou o Codex em qualquer projeto e veja seu agente chegar.', [keys ? ` (${keys})` : '']);
}

/** Algum pedido de permissão do Codex esperando: o prazo é curto e o cartão conta os segundos (relógio de 1 s). */
export function hasCodexPermission(snap: Pick<OfficeSnapshot, 'agents'> | null): boolean {
  return !!snap?.agents.some((a) => a.permission && isCodex(a.permission) && a.status !== 'offline' && a.status !== 'done');
}

/** Como ver o Codex ao vivo e aprovar pelo escritório (gaveta de um agente do Codex e ajuda). */
export const CODEX_LIVE_HINT = tr('Para ver o Codex ao vivo e aprovar pelo escritório: `npm run codex:install` e aprove os hooks em `/hooks` no Codex.');

/** Políticas de aprovação do Codex (`approval_policy`), quando o servidor as manda no lugar do modo de permissão. */
const CODEX_APPROVALS: Record<string, string> = {
  untrusted: tr('Pergunta antes de quase tudo'),
  'on-request': tr('Pergunta quando precisa'),
  'on-failure': tr('Pergunta quando um comando falha'),
  never: tr('Nunca pergunta'),
};

/** Aprovação de um agente do Codex em português (valor desconhecido passa como veio). */
export function codexApprovalLabel(policy: string | undefined): string {
  if (!policy) return '—';
  return CODEX_APPROVALS[policy] ?? policy;
}
