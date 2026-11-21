// Scripted stand-in for the SDK's query(), loaded by the server when JARVIS_FAKE_SDK points here. No API, no network, no cost.
// Each incoming user message is a script, one command per line; other lines (board notes, reports) are ignored:
//   say <text>              assistant text; with includePartialMessages first streamed word by word as text deltas
//   pace <ms>               pause after each text delta of the later say lines, so the stream can be watched
//   sleep <ms>              keeps the turn running
//   slowinterrupt <ms>      the result of an interrupted turn takes this long
//   write <path> <content>  Write tool: really writes the file (path relative to the session cwd)
//   bash <command>          Bash tool: really runs the command in the session cwd
//   tool <name> <json>      calls an in-process MCP tool through an MCP client, e.g. tool mcp__jarvis__notes_message {"message":"x"}
//   echo                    says the whole message as received, board notes and intercom prefix included; a message containing
//                           "[context reset]" (the server's seed for a reset arbiter) is echoed without this line
//   result                  says the text of the last tool command's result, error text included
//   usage <tokens>          the later assistant messages report this many input tokens
//   window <tokens>         the context window getContextUsage reports (default 200000)
//   trailing                a session_state_changed idle message follows this turn's result, as the CLI sends with state events on
//   fold                    the sends that wait now run inside this turn: one result for several sends
//   later <ms> <script>     a turn nobody sent starts after <ms> (the SDK runs one on a background task), so a result comes without a push; it opens
//                           with a system/status requesting message and its first stream message follows 1500 ms later
//   savedelay <ms> [fold]   later turns that carry the server's save-notes request last <ms> (with fold, sends that arrive meanwhile run inside it)
//   savefail <subtype>      later turns that carry the server's save-notes request end with this error result (savefail off clears it)
//   resetusage <tokens>     the turn on a reset seed starts with this many tokens; shared by all sessions of the process, 0 switches it off
//   cost <usd>              the result reports this total_cost_usd
//   fail <subtype>          ends the turn with an error result, e.g. fail error_during_execution; the session lives on
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
import type { query as sdkQuery, Query, SDKAssistantMessage, SDKMessage, SDKPartialAssistantMessage, SDKResultError, SDKResultMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// Typed against the real SDK: a change in its message shapes breaks npm run check here, not only in production.
type Assistant = SDKAssistantMessage['message'];
type Usage = Assistant['usage'];

// Shared by all sessions of the process: set by the commands savedelay, savefail and resetusage.
const laterIds = new Set<string>(); // synthetic turns of `later`
let saveDelay = { ms: 0, fold: false }, saveFail = '', resetUsage = 0;

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
  // interrupt(): the turn ends early with an error result that still carries the cost, as in the real SDK.
  // It ends only the running turn and does nothing when idle; queued messages still run.
  let interruptDelay = 0; // slowinterrupt: how long the interrupted result takes
  let interrupted = false, inTurn = false, wake = () => {};
  let woken = Promise.resolve();
  let n = 0;
  let windowSize = 200_000, tokens = 0, lastUsage = 0, usageTokens = 0, costUsd = 0;
  const base = { session_id, parent_tool_use_id: null };
  const assistant = (content: Assistant['content']): SDKAssistantMessage =>
    ({ ...base, uuid: randomUUID(), type: 'assistant', message: { id: `msg_fake_${++n}`, type: 'message', role: 'assistant', model: 'claude-fake', content, stop_reason: null, stop_sequence: null, container: null, context_management: null, diagnostics: null, stop_details: null, usage: { input_tokens: usageTokens } as Usage } });
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

  // The real SDK reads sends as they come and reports how many still wait: read the inbox eagerly to count them.
  const waiting: SDKUserMessage[] = [];
  let arrived = () => {}, inboxDone = false;
  void (async () => { for await (const m of inbox) (waiting.push(m), arrived()); inboxDone = true; arrived(); })();
  async function nextMessage() {
    while (!waiting.length) {
      if (inboxDone) return undefined;
      await Promise.race([new Promise<void>((r) => (arrived = r)), aborted]);
    }
    return waiting.shift();
  }

  const end = (text: string): SDKResultMessage =>
    ({ ...base, uuid: randomUUID(), type: 'result', subtype: 'success', result: text, stop_reason: 'end_turn', total_cost_usd: costUsd, is_error: false, queued_turn_count: waiting.length, num_turns: 1, duration_ms: 0, duration_api_ms: 0, usage: {} as SDKResultMessage['usage'], modelUsage: {}, permission_denials: [] });

  async function* compact(): AsyncGenerator<SDKMessage> {
    const pre = tokens;
    tokens = 3_000;
    yield { ...base, uuid: randomUUID(), type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: pre, post_tokens: tokens } };
    yield end('');
  }

  async function* turn(script: string): AsyncGenerator<SDKMessage> {
    const texts: string[] = [];
    let pace = 0;
    let last = ''; // result of the last `tool` command
    let trailing = false;
    const sleep = (ms: number) => Promise.race([new Promise((r) => setTimeout(r, ms)), woken, aborted]);
    async function* say(text: string): AsyncGenerator<SDKMessage> {
      texts.push(text);
      if (options.includePartialMessages) {
        const stream = (event: SDKPartialAssistantMessage['event']): SDKPartialAssistantMessage => ({ ...base, uuid: randomUUID(), type: 'stream_event', event });
        yield stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: null } });
        for (const chunk of text.split(/(?=\s)/).filter(Boolean)) {
          yield stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } });
          if (pace) await sleep(pace);
        }
        yield stream({ type: 'content_block_stop', index: 0 });
      }
      yield assistant([{ type: 'text', text, citations: null }]);
    }
    yield { ...base, uuid: randomUUID(), type: 'system', subtype: 'init', cwd, model: 'claude-fake', tools: [], mcp_servers: [], permissionMode: options.permissionMode ?? 'default', apiKeySource: 'none', claude_code_version: 'fake', slash_commands: [], output_style: 'default', skills: [], plugins: [] };
    if (script.trim() === '/compact') return yield* compact();
    const seed = script.includes('[context reset]');
    const lines = seed ? ['echo'] : script.split('\n');
    if (seed && resetUsage) usageTokens = resetUsage;
    const save = script.includes('The server resets your context after this turn');
    if (saveDelay.ms && save) lines.unshift(`sleep ${saveDelay.ms}`, ...(saveDelay.fold ? ['fold'] : []));
    if (saveFail && save) lines.push(`fail ${saveFail}`);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (interrupted) await new Promise((r) => setTimeout(r, interruptDelay));
      if (interrupted) return interrupted = false, yield { ...base, uuid: randomUUID(), type: 'result', subtype: 'error_during_execution', errors: [], stop_reason: null, total_cost_usd: costUsd, is_error: true, num_turns: 1, duration_ms: 0, duration_api_ms: 0, usage: {} as SDKResultMessage['usage'], modelUsage: {}, permission_denials: [] };
      const [, cmd, rest = ''] = /^(\w+)\s*(.*)$/.exec(line.trim()) ?? [];
      const id = `toolu_fake_${++n}`;
      if (cmd === 'say') {
        yield* say(rest);
      } else if (cmd === 'echo') {
        yield* say(script);
      } else if (cmd === 'option') {
        yield* say(`${rest}=${JSON.stringify(options[rest as keyof typeof options])}`);
      } else if (cmd === 'fail') {
        lastUsage = tokens += 30_000;
        const subtype = rest as SDKResultError['subtype'];
        return yield { ...base, uuid: randomUUID(), type: 'result', subtype, errors: [`fake ${rest}`], stop_reason: null, total_cost_usd: 0, is_error: true, num_turns: 1, duration_ms: 0, duration_api_ms: 0, usage: {} as SDKResultMessage['usage'], modelUsage: {}, permission_denials: [] };
      } else if (cmd === 'usage') {
        usageTokens = Number(rest);
      } else if (cmd === 'trailing') {
        trailing = true;
      } else if (cmd === 'fold') {
        for (const w of waiting.splice(0)) lines.push(...(typeof w.message.content === 'string' ? w.message.content : '').split('\n'));
      } else if (cmd === 'later') {
        const [, ms, text = ''] = /^(\d+)\s+(.*)$/.exec(rest) ?? [];
        setTimeout(() => {
          const uuid = randomUUID();
          laterIds.add(uuid);
          waiting.push({ ...base, uuid, type: 'user', message: { role: 'user', content: text.replace(/\\n/g, '\n') } });
          arrived();
        }, Number(ms));
      } else if (cmd === 'savedelay') {
        const [ms, fold] = rest.split(/\s+/);
        saveDelay = { ms: Number(ms), fold: fold === 'fold' };
      } else if (cmd === 'savefail') {
        saveFail = rest === 'off' ? '' : rest;
      } else if (cmd === 'resetusage') {
        resetUsage = Number(rest);
      } else if (cmd === 'window') {
        windowSize = Number(rest);
      } else if (cmd === 'cost') {
        costUsd = Number(rest);
      } else if (cmd === 'slowinterrupt') {
        interruptDelay = Number(rest);
      } else if (cmd === 'pace') {
        pace = Number(rest);
      } else if (cmd === 'sleep') {
        await sleep(Number(rest));
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
        last = r.text;
        yield result(id, r.text, r.is_error);
      } else if (cmd === 'result') {
        yield* say(last);
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
    if (trailing) yield { ...base, uuid: randomUUID(), type: 'system', subtype: 'session_state_changed', state: 'idle' };
  }

  async function* run(): AsyncGenerator<SDKMessage, void> {
    for (;;) {
      const next = await nextMessage();
      if (!next) return;
      const c = next.message.content;
      interrupted = false, inTurn = true, woken = new Promise<void>((res) => (wake = res));
      try {
        if (next.uuid && laterIds.has(next.uuid)) { // like the real SDK: a status message first, then the model's first output a while later
          yield { ...base, uuid: randomUUID(), type: 'system', subtype: 'status', status: 'requesting' };
          await new Promise((r) => setTimeout(r, 1500));
        }
        yield* turn(typeof c === 'string' ? c : c.map((b) => (b.type === 'text' ? b.text : '')).join('\n'));
      } finally { inTurn = false; }
    }
  }

  // Only what the server calls; the cast stands in for the many other control methods of a real Query.
  const q: Pick<Query, 'getContextUsage' | 'interrupt' | 'setModel' | 'applyFlagSettings'> & AsyncGenerator<SDKMessage, void> = Object.assign(run(), {
    getContextUsage: async (o?: { detail?: 'summary' | 'full' }) => ({ totalTokens: o?.detail === 'full' ? tokens : lastUsage, maxTokens: windowSize }) as Awaited<ReturnType<Query['getContextUsage']>>,
    interrupt: async () => void (inTurn && ((interrupted = true), wake())),
    setModel: async () => {},
    applyFlagSettings: async () => {},
  });
  return q as Query;
};
