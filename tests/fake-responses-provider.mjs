import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
/** Exercises Pi's Responses transport and built-in tools without upstream billing. */
export async function fakeResponsesProvider() {
  const requests = [];
  const searches = [];
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
      reasoningEffort: body.reasoning?.effort,
      authorizationPresent: !!request.headers.authorization,
      agentContextPresent: JSON.stringify([body.instructions, body.input]).includes(
        'REPELLET_AGENT_CONTEXT_MARKER=repellet-agent-context-v1',
      ),
      toolNames: (body.tools || []).map((tool) => ({
        type: tool.type,
        name: tool.name,
        tools: tool.tools?.map((nested) => nested.name),
      })),
    });
    const input = JSON.stringify(body.input);
    const tools = body.tools || [];
    const command =
      tools.find((tool) => tool.name === 'bash') ||
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
    const content = input.includes('echo provider credential')
      ? `Provider returned ${request.headers.authorization?.replace(/^Bearer /, '')}`
      : ordered
        ? 'Ordered final answer.'
        : 'Agent is connected to Repellet. Your conversation is saved.';
    const question = tools.find((tool) => tool.name === 'question');
    const search = tools.find((tool) => tool.name === 'web_search');
    const plan = tools.find((tool) => tool.name === 'plan');
    const planQuestion = tools.find((tool) => tool.name === 'ask_questions');
    const fixtureCall = (name, args) => ({
      type: 'function_call',
      id: 'fc_' + randomUUID(),
      call_id: 'repellet_fixture_call_' + randomUUID(),
      name,
      arguments: JSON.stringify(args),
    });
    const output =
      input.includes('search current Pi docs') && search && !hasOutput
        ? fixtureCall(search.name, {
            query: 'Pi extension documentation',
            search_context_size: 'medium',
          })
        : input.includes('create a reviewed plan') && plan && !hasOutput
          ? fixtureCall(plan.name, {
              plan: '1. Inspect the workspace.\n2. Update app.ts.\n3. Run the tests.',
              todos: [{ text: 'Inspect the workspace' }],
            })
          : input.includes('ask planning choices') && planQuestion && !hasOutput
            ? fixtureCall(planQuestion.name, {
                questions: [
                  {
                    id: 'scope',
                    prompt: 'Which scope?',
                    options: [
                      { value: 'focused', label: 'Focused', description: 'One file' },
                      { value: 'broad', label: 'Broad', description: 'Several files' },
                    ],
                  },
                ],
              })
            : input.includes('attempt a plan write') && command && !hasOutput
              ? fixtureCall(command.name, {
                  command: "printf 'must not be written' > plan-disallowed.txt",
                })
              : input.includes('ask owner') && question && !hasOutput
                ? {
                    type: 'function_call',
                    id: 'fc_' + randomUUID(),
                    call_id: 'repellet_fixture_call_' + randomUUID(),
                    name: 'question',
                    arguments: JSON.stringify({
                      questions: [
                        {
                          id: 'choice',
                          header: 'Choose',
                          question: 'Which option?',
                          options: [{ label: 'First', description: 'Choice one' }],
                        },
                      ],
                    }),
                  }
                : patchFile && (patchTool || command) && !hasOutput
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
                                    ...(command.name === 'bash'
                                      ? {
                                          command:
                                            "printf 'patched by agent\\n' > /workspace/agent-patch.txt",
                                        }
                                      : {
                                          cmd: "printf 'patched by agent\\n' > /workspace/agent-patch.txt",
                                        }),
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
                                ...(command.name === 'bash'
                                  ? {
                                      command:
                                        "printf 'created by agent\\n' > agent-result.txt; test -z \"$REPELLET_AGENT_API_KEY\" && printf 'PROVIDER_KEY_HIDDEN\\n'",
                                    }
                                  : {
                                      cmd: "printf 'created by agent\\n' > agent-result.txt; test -z \"$REPELLET_AGENT_API_KEY\" && printf 'PROVIDER_KEY_HIDDEN\\n'",
                                    }),
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
        const chunks = input.includes('echo provider credential')
          ? content.match(/.{1,9}/g)
          : [content];
        for (const delta of chunks)
          send('response.output_text.delta', {
            item_id: output.id,
            output_index: outputIndex,
            content_index: 0,
            delta,
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
  const websocket = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/custom/v1/responses') return socket.destroy();
    websocket.handleUpgrade(request, socket, head, (client) => {
      client.on('message', (raw) => {
        const body = JSON.parse(raw.toString());
        searches.push({
          body,
          authorizationPresent: !!request.headers.authorization,
          beta: request.headers['openai-beta'],
        });
        if (JSON.stringify(body.input).includes('hold search')) return;
        client.send(
          JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'search_' + randomUUID(),
              status: 'completed',
              output: [
                {
                  type: 'message',
                  role: 'assistant',
                  content: [
                    {
                      type: 'output_text',
                      text: 'Pi supports extensions.',
                      annotations: [
                        {
                          type: 'url_citation',
                          title: 'Pi docs',
                          url: 'https://example.com/pi-docs',
                          start_index: 0,
                          end_index: 23,
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          }),
        );
      });
    });
  });
  await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
  const port = server.address().port;
  return {
    server,
    requests,
    searches,
    url: `http://host.docker.internal:${port}/custom/v1`,
    close: () =>
      new Promise((resolve) => {
        for (const client of websocket.clients) client.terminate();
        websocket.close(() => server.close(resolve));
      }),
  };
}
