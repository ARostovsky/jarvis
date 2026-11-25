// Read-only token report from workspace event logs, to compare consumption before/after a change.
// result.usage is the main loop's tokens of one turn (not cumulative, no sub-agents or helper calls), so turns are summed; costUsd is cumulative, so its max is taken.
// Usage: node scripts/token-report.ts [dataDir=~/.local/share/jarvis] [--workspace <id>] [--json]
// Logs written before usage was logged have cost and context size only; the token columns then show "-".
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

type Ev = { type: string; agentId?: string; costUsd?: number; tokens?: number; text?: string; name?: string; input?: unknown; categories?: Record<string, { tokens: number; kind: string }>;
  usage?: { input: number; output: number; cacheRead: number; cacheCreate: number }; agent?: { id: string; parentId?: string; lead?: boolean; task?: string } };
export type Row = { agent: string; role: string; turns: number; costUsd: number; input?: number; cacheRead?: number; cacheCreate?: number; output?: number; firstContext?: number; maxContext: number; overhead?: Record<string, number> };

export function readEvents(file: string): Ev[] {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as Ev]; } catch { return []; } }); // torn line: skip
}

const len = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v ?? '')).length;

// Fixed per-spawn overhead = the first context breakdown of a session (system prompt, tools, MCP tools, memory files such as CLAUDE.md, skills), before any messages.
export function report(events: Ev[]) {
  const rows = new Map<string, Row>();
  const sizes: Record<string, { n: number; chars: number }> = {};
  const add = (k: string, chars: number) => { const s = (sizes[k] ??= { n: 0, chars: 0 }); s.n++; s.chars += chars; };
  for (const e of events) {
    const id = e.agentId ?? e.agent?.id;
    if (e.type === 'spawned' && e.agent && !rows.has(e.agent.id)) rows.set(e.agent.id, { agent: e.agent.id, role: !e.agent.parentId ? 'arbiter' : e.agent.lead ? 'lead' : 'agent', turns: 0, costUsd: 0, maxContext: 0 });
    const r = id ? rows.get(id) : undefined;
    if (e.type === 'result' && r) {
      r.turns++;
      r.costUsd = Math.max(r.costUsd, e.costUsd ?? 0); // costUsd is cumulative per agent
      if (e.usage) for (const [k, f] of [['input', 'input'], ['cacheRead', 'cacheRead'], ['cacheCreate', 'cacheCreate'], ['output', 'output']] as const) r[k] = (r[k] ?? 0) + e.usage[f];
    } else if (e.type === 'context' && r) {
      r.firstContext ??= e.tokens;
      r.maxContext = Math.max(r.maxContext, e.tokens ?? 0);
      if (e.categories && !r.overhead) r.overhead = Object.fromEntries(Object.entries(e.categories).filter(([k, c]) => c.kind === 'used' && k !== 'messages').map(([k, c]) => [k, c.tokens]));
    } else if (e.type === 'tool') add(`tool:${e.name}`, len(e.input));
    else if (e.type === 'routed' || e.type === 'text') add(e.type, len(e.text));
    else if (e.type === 'board') add('board', len(e.text));
  }
  return { rows: [...rows.values()], sizes };
}

const fmt = (n?: number) => (n === undefined ? '-' : String(n));
function print(ws: string, { rows, sizes }: ReturnType<typeof report>) {
  console.log(`\n== ${ws}`);
  console.log(['agent', 'role', 'turns', 'cost$', 'input', 'cache_read', 'cache_create', 'output', 'ctx_first', 'ctx_max'].join('\t'));
  for (const r of rows) console.log([r.agent, r.role, r.turns, r.costUsd.toFixed(3), fmt(r.input), fmt(r.cacheRead), fmt(r.cacheCreate), fmt(r.output), fmt(r.firstContext), r.maxContext].join('\t'));
  const oh = rows.filter((r) => r.overhead);
  if (oh.length) { console.log('fixed overhead per spawn (tokens, first context breakdown):'); for (const r of oh) console.log(`  ${r.agent}: ${Object.entries(r.overhead!).map(([k, v]) => `${k}=${v}`).join(' ')}`); }
  console.log('message sizes (count, chars):');
  for (const [k, s] of Object.entries(sizes).sort((a, b) => b[1].chars - a[1].chars).slice(0, 12)) console.log(`  ${k}\t${s.n}\t${s.chars}`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const only = args.includes('--workspace') ? args[args.indexOf('--workspace') + 1] : undefined;
  const json = args.includes('--json');
  const data = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--workspace') ?? join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'jarvis');
  const root = join(data, 'workspaces');
  const out: Record<string, ReturnType<typeof report>> = {};
  for (const ws of existsSync(root) ? readdirSync(root).sort() : []) {
    const f = join(root, ws, 'events.jsonl');
    if ((only && ws !== only) || !existsSync(f)) continue;
    out[ws] = report(readEvents(f));
  }
  if (json) console.log(JSON.stringify(out, null, 2));
  else for (const [ws, r] of Object.entries(out)) print(ws, r);
}
