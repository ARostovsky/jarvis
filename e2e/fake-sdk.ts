// Scripted stand-in for the SDK's query(), loaded by the server when JARVIS_FAKE_SDK points here. No API, no network, no cost.
// Each incoming user message is a script, one command per line; other lines (board notes, reports) are ignored:
//   say <text>              assistant text
//   sleep <ms>              keeps the turn running
//   write <path> <content>  Write tool: really writes the file (path relative to the session cwd)
//   bash <command>          Bash tool: really runs the command in the session cwd
//   tool <name> <json>      calls an in-process MCP tool through an MCP client, e.g. tool mcp__jarvis__notes_message {"message":"x"}
// Messages come in the real SDK's order: system init, then per tool an assistant tool_use, the tool runs, a user tool_result; then the result.
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

type Block = Record<string, unknown>;

export function query({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) {
  const session_id: string = options.resume ?? randomUUID();
  const cwd: string = options.cwd;
  // The real SDK rejects with this when its abortController fires (stop, archive).
  const aborted = new Promise<never>((_, reject) => {
    const fail = () => reject(new Error('Claude Code process aborted by user'));
    if (options.abortController?.signal.aborted) fail();
    options.abortController?.signal.addEventListener('abort', fail);
  });
  aborted.catch(() => {});
  let n = 0;
  const base = { session_id, uuid: '', parent_tool_use_id: null };
  const assistant = (content: Block[]) => ({ ...base, uuid: randomUUID(), type: 'assistant', message: { id: `msg_fake_${++n}`, type: 'message', role: 'assistant', model: 'claude-fake', content, stop_reason: null, usage: {} } });
  const result = (tool_use_id: string, text: string, is_error = false) =>
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

  async function* turn(script: string) {
    const texts: string[] = [];
    yield { ...base, uuid: randomUUID(), type: 'system', subtype: 'init', cwd, model: 'claude-fake', tools: [], mcp_servers: [], permissionMode: options.permissionMode, apiKeySource: 'none', claude_code_version: 'fake', slash_commands: [], output_style: 'default', skills: [], plugins: [] };
    for (const line of script.split('\n')) {
      const [, cmd, rest = ''] = /^(\w+)\s*(.*)$/.exec(line.trim()) ?? [];
      const id = `toolu_fake_${++n}`;
      if (cmd === 'say') {
        texts.push(rest);
        yield assistant([{ type: 'text', text: rest }]);
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
      }
    }
    yield { ...base, uuid: randomUUID(), type: 'result', subtype: 'success', result: texts.join('\n'), total_cost_usd: 0, is_error: false, num_turns: 1, duration_ms: 0, duration_api_ms: 0, usage: {}, modelUsage: {}, permission_denials: [] };
  }

  async function* run() {
    const input = prompt[Symbol.asyncIterator]();
    for (;;) {
      const next = await Promise.race([input.next(), aborted]);
      if (next.done) return;
      const c = next.value.message.content;
      yield* turn(typeof c === 'string' ? c : c.map((b: Block) => b.text ?? '').join('\n'));
    }
  }

  return Object.assign(run(), {
    getContextUsage: async () => ({ totalTokens: 0, maxTokens: 200_000 }),
    setModel: async () => {},
    applyFlagSettings: async () => {},
    interrupt: async () => {},
    close: () => {},
  });
}
