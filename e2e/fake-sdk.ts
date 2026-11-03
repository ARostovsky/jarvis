// Scripted stand-in for the SDK's query(), loaded by the server when JARVIS_FAKE_SDK points here. No API, no network, no cost.
// Each incoming user message is a script, one command per line; other lines (board notes, reports) are ignored:
//   say <text>              assistant text
//   sleep <ms>              keeps the turn running
//   write <path> <content>  Write tool: really writes the file (path relative to the session cwd)
//   bash <command>          Bash tool: really runs the command in the session cwd
//   tool <name> <json>      calls an in-process MCP tool through an MCP client, e.g. tool mcp__jarvis__notes_message {"message":"x"}
//   option <name>           says "<name>=<the query option as JSON>", e.g. option resume
//   perm <name> <json>      asks options.canUseTool for a tool call, as the real SDK does for a call it cannot decide (AskUserQuestion always),
//                           then says "allow <updated input as JSON>" or "deny <message>"; runs nothing
// The message /compact (what the server sends for COMPACT) compacts instead: a compact_boundary, then an empty success result.
// Context: each other turn adds 30k tokens. getContextUsage 'full' counts what the session holds now; 'summary' reports the last
// response's usage, which after a compact is still the pre-compact size, as in the real SDK.
// Messages come in the real SDK's order: system init, then per tool an assistant tool_use, the tool runs, a user tool_result; then the result.
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import type { query as sdkQuery, Query, SDKAssistantMessage, SDKMessage, SDKResultMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// Typed against the real SDK: a change in its message shapes breaks npm run check here, not only in production.
type Assistant = SDKAssistantMessage['message'];
type Usage = Assistant['usage'];

export const query: typeof sdkQuery = ({ prompt, options = {} }) => {
  if (typeof prompt === 'string') throw new Error('fake sdk: only streaming input, as the server uses');
  const inbox = prompt;
  const session_id = options.resume ?? randomUUID();
  const cwd = options.cwd ?? process.cwd();
  // The real SDK rejects with this when its abortController fires (stop, archive).
  const aborted = new Promise<never>((_, reject) => {
    const fail = () => reject(new Error('Claude Code process aborted by user'));
    if (options.abortController?.signal.aborted) fail();
    options.abortController?.signal.addEventListener('abort', fail);
  });
  aborted.catch(() => {});
  let n = 0;
  let tokens = 0, lastUsage = 0;
  const base = { session_id, parent_tool_use_id: null };
  const assistant = (content: Assistant['content']): SDKAssistantMessage =>
    ({ ...base, uuid: randomUUID(), type: 'assistant', message: { id: `msg_fake_${++n}`, type: 'message', role: 'assistant', model: 'claude-fake', content, stop_reason: null, stop_sequence: null, container: null, context_management: null, diagnostics: null, stop_details: null, usage: {} as Usage } });
  const result = (tool_use_id: string, text: string, is_error = false): SDKUserMessage =>
    ({ ...base, uuid: randomUUID(), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id, content: text, is_error }] } });

  // One MCP client per in-process server, connected on first use: callTool runs the server's own input validation, as in the real SDK.
  const clients = new Map<string, Promise<Client>>();
  async function mcp(name: string, args: Record<string, unknown>) {
    const [, server, toolName] = /^mcp__(.+?)__(.+)$/.exec(name) ?? [];
    const cfg = options.mcpServers?.[server];
    if (cfg?.type !== 'sdk') throw new Error(`fake sdk: no in-process MCP server for ${name}`);
    if (!clients.has(server)) {
      const [ours, theirs] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'fake-sdk', version: '0' });
      clients.set(server, cfg.instance.connect(theirs).then(() => client.connect(ours)).then(() => client));
    }
    const out = await (await clients.get(server)!).callTool({ name: toolName, arguments: args });
    return { text: (out.content as { text?: string }[]).map((c) => c.text ?? '').join('\n'), is_error: !!out.isError };
  }

  const end = (text: string): SDKResultMessage =>
    ({ ...base, uuid: randomUUID(), type: 'result', subtype: 'success', result: text, stop_reason: 'end_turn', total_cost_usd: 0, is_error: false, num_turns: 1, duration_ms: 0, duration_api_ms: 0, usage: {} as SDKResultMessage['usage'], modelUsage: {}, permission_denials: [] });

  async function* compact(): AsyncGenerator<SDKMessage> {
    const pre = tokens;
    tokens = 3_000;
    yield { ...base, uuid: randomUUID(), type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: pre, post_tokens: tokens } };
    yield end('');
  }

  async function* turn(script: string): AsyncGenerator<SDKMessage> {
    const texts: string[] = [];
    function* say(text: string) {
      texts.push(text);
      yield assistant([{ type: 'text', text, citations: null }]);
    }
    yield { ...base, uuid: randomUUID(), type: 'system', subtype: 'init', cwd, model: 'claude-fake', tools: [], mcp_servers: [], permissionMode: options.permissionMode ?? 'default', apiKeySource: 'none', claude_code_version: 'fake', slash_commands: [], output_style: 'default', skills: [], plugins: [] };
    if (script.trim() === '/compact') return yield* compact();
    for (const line of script.split('\n')) {
      const [, cmd, rest = ''] = /^(\w+)\s*(.*)$/.exec(line.trim()) ?? [];
      const id = `toolu_fake_${++n}`;
      if (cmd === 'say') {
        yield* say(rest);
      } else if (cmd === 'option') {
        yield* say(`${rest}=${JSON.stringify(options[rest as keyof typeof options])}`);
      } else if (cmd === 'sleep') {
        await Promise.race([new Promise((r) => setTimeout(r, Number(rest))), aborted]);
      } else if (cmd === 'write') {
        const [, path, content = ''] = /^(\S+)\s?(.*)$/.exec(rest) ?? [];
        const file_path = resolve(cwd, path);
        yield assistant([{ type: 'tool_use', id, name: 'Write', input: { file_path, content } }]);
        mkdirSync(dirname(file_path), { recursive: true });
        writeFileSync(file_path, content);
        yield result(id, `File created successfully at: ${file_path}`);
      } else if (cmd === 'bash') {
        // The server snapshots notes when it sees the tool_use, so the command runs only after that message is consumed.
        yield assistant([{ type: 'tool_use', id, name: 'Bash', input: { command: rest, description: 'fake' } }]);
        // Async: the fake runs inside the server, and a blocking command would freeze it.
        const r = await promisify(exec)(rest, { cwd }).then((o) => ({ text: o.stdout, is_error: false }), (e: Error) => ({ text: e.message, is_error: true }));
        yield result(id, r.text, r.is_error);
      } else if (cmd === 'tool') {
        const [, name, json = '{}'] = /^(\S+)\s?(.*)$/.exec(rest) ?? [];
        const input = JSON.parse(json);
        yield assistant([{ type: 'tool_use', id, name, input }]);
        const r = await mcp(name, input).catch((e: Error) => ({ text: e.message, is_error: true }));
        yield result(id, r.text, r.is_error);
      } else if (cmd === 'perm') {
        const [, name, json = '{}'] = /^(\S+)\s?(.*)$/.exec(rest) ?? [];
        const input = JSON.parse(json);
        yield assistant([{ type: 'tool_use', id, name, input }]);
        if (!options.canUseTool) throw new Error('fake sdk: perm needs options.canUseTool');
        const signal = options.abortController?.signal ?? new AbortController().signal;
        const r = await Promise.race([options.canUseTool(name, input, { signal, toolUseID: id, requestId: randomUUID() }), aborted]);
        if (r?.behavior === 'allow') {
          yield result(id, 'allowed');
          yield* say(`allow ${JSON.stringify(r.updatedInput ?? input)}`);
        } else {
          yield result(id, r?.message ?? 'no decision', true);
          yield* say(`deny ${r?.message}`);
        }
      }
    }
    lastUsage = tokens += 30_000;
    yield end(texts.join('\n'));
  }

  async function* run(): AsyncGenerator<SDKMessage, void> {
    const input = inbox[Symbol.asyncIterator]();
    for (;;) {
      const next = await Promise.race([input.next(), aborted]);
      if (next.done) return;
      const c = next.value.message.content;
      yield* turn(typeof c === 'string' ? c : c.map((b) => (b.type === 'text' ? b.text : '')).join('\n'));
    }
  }

  // Only what the server calls; the cast stands in for the many other control methods of a real Query.
  const q: Pick<Query, 'getContextUsage' | 'setModel' | 'applyFlagSettings'> & AsyncGenerator<SDKMessage, void> = Object.assign(run(), {
    getContextUsage: async (o?: { detail?: 'summary' | 'full' }) => ({ totalTokens: o?.detail === 'full' ? tokens : lastUsage, maxTokens: 200_000 }) as Awaited<ReturnType<Query['getContextUsage']>>,
    setModel: async () => {},
    applyFlagSettings: async () => {},
  });
  return q as Query;
};
