import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import extension from './upstream/websearch/extension.ts';
import { resolveSearchConfig } from './upstream/websearch/config.ts';
import { search } from './upstream/websearch/core.ts';

/** Resolve both account and proxy auth through Pi's private, request-time runtime. */
export default function websearch(pi: ExtensionAPI) {
  extension({
    ...pi,
    registerTool(tool: any) {
      if (tool.name !== 'web_search') return pi.registerTool(tool);
      pi.registerTool({
        ...tool,
        async execute(_id: string, params: any, signal: AbortSignal, _update: any, ctx: any) {
          try {
            let config;
            if (ctx.model?.provider === 'repellet') {
              const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
              if (!auth.ok || !auth.apiKey)
                throw new Error(
                  'Reconnect the custom provider in Agent settings to search the web.',
                );
              config = {
                backend: 'cliproxyapi' as const,
                baseUrl: auth.baseUrl || ctx.model.baseUrl,
                apiKey: auth.apiKey,
                model: ctx.model.id,
              };
            } else {
              config = await resolveSearchConfig(ctx);
            }
            if (!config)
              throw new Error(
                'Select ChatGPT or configure CLIProxyAPI in Agent settings to search the web.',
              );
            const result = await search(params, config, signal);
            return {
              content: [
                {
                  type: 'text' as const,
                  text:
                    result.text +
                    (result.details.sources.length
                      ? '\n\nSources:\n' +
                        result.details.sources
                          .map((source) => `- ${source.title ?? source.url}: ${source.url}`)
                          .join('\n')
                      : ''),
                },
              ],
              details: result.details,
            };
          } catch (error) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: error instanceof Error ? error.message : 'Web search failed.',
                },
              ],
              details: { error: 'web_search_failed' },
              isError: true,
            };
          }
        },
      });
    },
  });
}
