import { z } from 'zod';
import type { ChatgptAuthTokensRefreshResponse } from '@repellet/codex-protocol';
// Codex 0.160.0's file credential cache is the version-specific authentication adapter.
// Never return its refresh token or id token to project processes or clients.
const cacheSchema = z.object({
  auth_mode: z.literal('chatgpt').optional(),
  tokens: z.object({
    access_token: z.string().min(1),
    account_id: z.string().min(1),
    refresh_token: z.string().min(1),
    id_token: z.string().min(1),
  }),
});
export function readAuthCache(contents: string): ChatgptAuthTokensRefreshResponse {
  try {
    const { tokens } = cacheSchema.parse(JSON.parse(contents));
    const claims = JSON.parse(
      Buffer.from(tokens.access_token.split('.')[1] || '', 'base64url').toString(),
    );
    if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now()) throw new Error('expired');
    const auth = claims['https://api.openai.com/auth'];
    if (auth?.chatgpt_account_id && auth.chatgpt_account_id !== tokens.account_id)
      throw new Error('account mismatch');
    return {
      accessToken: tokens.access_token,
      chatgptAccountId: tokens.account_id,
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
