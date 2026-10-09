import { z } from 'zod';
import type { ChatgptAuthTokensRefreshResponse } from '@repellet/agent-protocol';
const cacheSchema = z.object({
  auth_mode: z.literal('chatgpt').optional(),
  tokens: z.object({
    access_token: z.string().min(1),
    account_id: z.string().min(1),
    refresh_token: z.string().min(1),
    id_token: z.string().min(1),
  }),
});
/** Accepts legacy Codex caches and Pi's openai-codex OAuth credential shape without exposing secrets. */
export function readAuthCache(contents: string): ChatgptAuthTokensRefreshResponse {
  try {
    const value = JSON.parse(contents);
    let access: string, account: string, refresh: string | undefined, idToken: string | undefined;
    if (value?.tokens) {
      const parsed = cacheSchema.parse(value);
      access = parsed.tokens.access_token;
      account = parsed.tokens.account_id;
      refresh = parsed.tokens.refresh_token;
      idToken = parsed.tokens.id_token;
    } else {
      const token = value?.['openai-codex'] ?? value?.openaiCodex ?? value;
      access = token?.access ?? token?.accessToken ?? token?.access_token;
      account = token?.accountId ?? token?.account_id ?? 'openai-codex';
      refresh = token?.refresh ?? token?.refreshToken ?? token?.refresh_token;
      idToken = token?.idToken ?? token?.id_token;
      if (typeof access !== 'string' || !access) throw new Error('missing access token');
    }
    const claims = JSON.parse(Buffer.from(access!.split('.')[1] || '', 'base64url').toString());
    if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now()) throw new Error('expired');
    const auth = claims['https://api.openai.com/auth'];
    if (auth?.chatgpt_account_id && auth.chatgpt_account_id !== account)
      throw new Error('account mismatch');
    return {
      accessToken: access!,
      chatgptAccountId: account!,
      chatgptPlanType: typeof auth?.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type : null,
    };
  } catch {
    throw Object.assign(
      new Error(
        'ChatGPT credentials are expired or incompatible. Reconnect ChatGPT in Agent settings.',
      ),
      { statusCode: 401 },
    );
  }
}

/** Converts an existing central cache, including expired access tokens that Pi can refresh. */
export function legacyPiCredential(contents: string) {
  try {
    const value = JSON.parse(contents);
    if (!value?.tokens || value['openai-codex']) return null;
    const { access_token: access, refresh_token: refresh, account_id: accountId } = value.tokens;
    if (![access, refresh, accountId].every((value) => typeof value === 'string' && value))
      throw new Error();
    const claims = JSON.parse(Buffer.from(access.split('.')[1], 'base64url').toString());
    if (!Number.isFinite(claims.exp)) throw new Error();
    const claimedAccount = claims['https://api.openai.com/auth']?.chatgpt_account_id;
    if (claimedAccount && claimedAccount !== accountId) throw new Error();
    return { type: 'oauth' as const, access, refresh, accountId, expires: claims.exp * 1000 };
  } catch {
    throw new Error('ChatGPT credentials are incompatible. Reconnect in Agent settings.');
  }
}
