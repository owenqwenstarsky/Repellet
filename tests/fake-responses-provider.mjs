import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
/** Exercises real Codex's Responses transport and built-in tools without upstream billing. */
export async function fakeResponsesProvider() {
  const requests = [];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/custom/v1/responses') {
      response.writeHead(404);
      response.end('Responses endpoint required');
      return;
    }
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    requests.push({
      path: request.url,
      model: body.model,
      authorizationPresent: !!request.headers.authorization,
      toolNames: (body.tools || []).map((tool) => ({
        type: tool.type,
        name: tool.name,
        tools: tool.tools?.map((nested) => nested.name),
      })),
    });
    const input = JSON.stringify(body.input);
    const tools = body.tools || [];
    const command =
      tools.find((tool) => tool.name === 'exec_command') ||
      tools.find((tool) => tool.name === 'shell');
    const patchTool = tools.find((tool) => tool.name === 'apply_patch');
    const hasOutput = (body.input || []).some(
      (item) =>
        ['function_call_output', 'custom_tool_call_output'].includes(item.type) &&
        item.call_id?.startsWith('repellet_fixture_call_'),
    );
    const writeFile = input.includes('create agent file');
    const patchFile = input.includes('apply agent patch');
    const ordered = input.includes('ordered commentary');
    const content = ordered
      ? 'Ordered final answer.'
      : 'Codex is connected to Repellet. Your conversation is saved.';
    const output =
      patchFile && (patchTool || command) && !hasOutput
        ? {
            type: patchTool?.type === 'custom' ? 'custom_tool_call' : 'function_call',
            id: 'ctc_' + randomUUID(),
            call_id: 'repellet_fixture_call_' + randomUUID(),
            name: (patchTool || command).name,
            ...(patchTool?.type === 'custom'
              ? {
                  input:
                    '*** Begin Patch\n*** Add File: agent-patch.txt\n+patched by agent\n*** End Patch',
                }
              : {
                  arguments: JSON.stringify(
                    patchTool
                      ? {
                          input:
                            '*** Begin Patch\n*** Add File: agent-patch.txt\n+patched by agent\n*** End Patch',
                        }
                      : {
                          cmd: "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: agent-patch.txt\n+patched by agent\n*** End Patch\nPATCH",
                          workdir: '/workspace',
                        },
                  ),
                }),
          }
        : writeFile && command && !hasOutput
          ? {
              type: 'function_call',
              id: 'fc_' + randomUUID(),
              call_id: 'repellet_fixture_call_' + randomUUID(),
              name: command.name,
              arguments: JSON.stringify(
                command.name === 'shell'
                  ? {
                      command: [
                        '/bin/bash',
                        '-c',
                        "printf 'created by agent\\n' > agent-result.txt; test -z \"$REPELLET_AGENT_API_KEY\" && printf 'PROVIDER_KEY_HIDDEN\\n'",
                      ],
                      workdir: '/workspace',
                    }
                  : {
                      cmd: "printf 'created by agent\\n' > agent-result.txt; test -z \"$REPELLET_AGENT_API_KEY\" && printf 'PROVIDER_KEY_HIDDEN\\n'",
                      workdir: '/workspace',
                    },
              ),
            }
          : {
              type: 'message',
              id: 'msg_' + randomUUID(),
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: content, annotations: [] }],
            };
    const outputItems =
      ordered && output.type !== 'message'
        ? [
            {
              type: 'message',
              id: 'msg_' + randomUUID(),
              role: 'assistant',
              phase: 'commentary',
              status: 'completed',
              content: [{ type: 'output_text', text: 'Checking the project.', annotations: [] }],
            },
            output,
          ]
        : [output];
    const result = {
      id: 'resp_' + randomUUID(),
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: 'completed',
      model: body.model,
      output: outputItems,
      usage: {
        input_tokens: 10,
        output_tokens: 10,
        total_tokens: 20,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    };
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (type, data) =>
      response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send('response.created', { response: { ...result, status: 'in_progress', output: [] } });
    for (const [outputIndex, output] of outputItems.entries()) {
      const content = output.type === 'message' ? output.content[0].text : '';
      send('response.output_item.added', {
        output_index: outputIndex,
        item:
          output.type === 'message'
            ? { ...output, status: 'in_progress', content: [] }
            : output.type === 'custom_tool_call'
              ? { ...output, input: '' }
              : { ...output, arguments: '' },
      });
      if (output.type === 'message') {
        send('response.content_part.added', {
          item_id: output.id,
          output_index: outputIndex,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        });
        send('response.output_text.delta', {
          item_id: output.id,
          output_index: outputIndex,
          content_index: 0,
          delta: content,
        });
        send('response.output_text.done', {
          item_id: output.id,
          output_index: outputIndex,
          content_index: 0,
          text: content,
        });
        send('response.content_part.done', {
          item_id: output.id,
          output_index: outputIndex,
          content_index: 0,
          part: output.content[0],
        });
      } else if (output.type === 'custom_tool_call') {
        send('response.custom_tool_call_input.delta', {
          item_id: output.id,
          output_index: outputIndex,
          delta: output.input,
        });
        send('response.custom_tool_call_input.done', {
          item_id: output.id,
          output_index: outputIndex,
          input: output.input,
        });
      } else {
        send('response.function_call_arguments.delta', {
          item_id: output.id,
          output_index: outputIndex,
          delta: output.arguments,
        });
        send('response.function_call_arguments.done', {
          item_id: output.id,
          output_index: outputIndex,
          arguments: output.arguments,
        });
      }
      if (input.includes('hold for steering'))
        await new Promise((resolve) => setTimeout(resolve, 5000));
      send('response.output_item.done', { output_index: outputIndex, item: output });
    }
    send('response.completed', { response: result });
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
  const port = server.address().port;
  return {
    server,
    requests,
    url: `http://host.docker.internal:${port}/custom/v1`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
