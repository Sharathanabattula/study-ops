import Anthropic from '@anthropic-ai/sdk';

/** A real SDK client whose HTTP layer is replaced, so request bodies are exactly what the SDK sends. */
export function recordingClient(setClient, respond) {
  const requests = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url: String(url), headers: new Headers(init.headers), body });
    const reply = respond(body, requests.length);
    const message = { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn', stop_details: null, usage: { input_tokens: 10, output_tokens: 10 }, content: [{ type: 'text', text: reply }] };
    if (body.stream) {
      const events = [
        { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_details: null }, usage: { output_tokens: 10 } },
        { type: 'message_stop' },
      ];
      const sse = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify(message), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  setClient(new Anthropic({ apiKey: 'test-key', fetch, maxRetries: 0 }));
  return requests;
}
