// Automatic arbiter context reset: when to act and what the fresh session is told. Pure, so the logic is unit-tested without a session.

// A configured bound lowered to 60% of the model window once that is known; the plain bound until then. 0 stays 0 (off).
export const resetLimit = (bound: number, max?: number) => (bound > 0 ? (max ? Math.min(bound, 0.6 * max) : bound) : 0);

export type ResetPhase = 'none' | 'saving';

// Called at a successful arbiter result with no message left in the session's queue. Above `hard` it acts at once; above `soft` only
// when `calm` (no agent of the workspace runs or waits and the SDK queue is empty); neither the queue nor a count of ours can block it. hard 0 disables everything, soft 0 only the soft bound. `saving` is the
// once-only flag of a session; `force` (the RESET button) counts as over the hard bound, whatever the size or the bounds: the save-state turn is asked for once, and its result resets.
export function atResult(phase: ResetPhase, ctx: number, bounds: { soft: number; hard: number }, calm: boolean, hasNotes: boolean, force = false): { phase: ResetPhase; act?: 'ask' | 'reset' } {
  if (phase === 'saving') return { phase, act: 'reset' };
  const over = force || (bounds.hard > 0 && (ctx > bounds.hard || (bounds.soft > 0 && ctx > bounds.soft && calm)));
  return over ? { phase: 'saving', act: hasNotes ? 'ask' : 'reset' } : { phase };
}

export type SeedFacts = {
  workspace: string;
  project?: string;
  notes?: string;
  wsNotes?: string; // this workspace's own folder under notes
  agents: { id: string; name: string; status: string; repo?: string; lastText: string }[];
  last: string; // the arbiter's last assistant text
  unhandled: string[]; // sent to the old session, no result for them yet: the SDK may not have handled them
  handled: { text: string; reply: string }[]; // sent while it was asked to save, answered by the old session
};

const SEED_CAP = 16_000;
const AGENTS_CAP = 4500;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function resetSeed(f: SeedFacts): string {
  const out = [
    `[context reset] Your context grew too large, so the server ended your session and started this new one in the same workspace "${f.workspace}". This is a context reset, not a new workspace: continue the work, and do not tell the user to start a new workspace. Workspace, tab, board, agents (running ones too) and the event log are unchanged; agent reports still reach you.`,
  ];
  if (f.project) out.push(`Project: ${f.project}`);
  if (f.notes) out.push(f.wsNotes
    ? `Notes folder: ${f.notes}. Your own files: ${f.wsNotes}/status.md, ${f.wsNotes}/open-items.md and your journal. Read README.md, CLAUDE.md and those first to recover the state. Other workspaces' state: ${f.notes}/workspaces/.`
    : `Notes folder: ${f.notes}. Read README.md, CLAUDE.md, status.md and your journal there first to recover the state.`);
  // The agent list gets its own budget, so many agents cannot push the last text and late messages out of the cap.
  const lines: string[] = [];
  let size = 0;
  for (const a of f.agents) {
    const line = `- ${a.id} (${a.name}): ${a.status}${a.repo ? `, repo ${a.repo}, branch jarvis/${a.id}` : ''}${a.lastText ? `; last: ${clip(a.lastText.replace(/\s+/g, ' '), 300)}` : ''}`;
    if ((size += line.length) > AGENTS_CAP) break;
    lines.push(line);
  }
  out.push(f.agents.length ? `Agents:\n${lines.join('\n')}${f.agents.length > lines.length ? `\n… and ${f.agents.length - lines.length} more (list_agents)` : ''}` : 'Agents: none yet.');
  if (f.last) out.push(`Your last message before the reset (may be stale: do not repeat its open items or "on you" lists without re-verifying them):\n${clip(f.last, 1500)}${f.wsNotes ? `\nTreat every '- [ ]' item as not verified: keep its '[ ]' state, and check it before you claim its state. Never drop an item you did not verify, unless the user says it is done. Do not re-check a verified fact that cannot change. Open items are '- [ ]' lines, parked ones '- [~]' lines, done and verified ones '- [x] ... verified <DD-MM-YYYY>' lines of ${f.wsNotes}/open-items.md.` : ''}`);
  if (f.handled.length) out.push(`Already handled by your old session after it was asked to save, with its final reply; do not redo them, they may be missing from the notes:\n${f.handled.slice(-8).map((h) => `${clip(h.text, 400)}\n=> ${clip(h.reply, 300)}`).join('\n---\n')}`);
  if (f.unhandled.length) out.push(`Sent to your old session but possibly not handled yet; handle them now:\n${f.unhandled.slice(-8).map((t) => clip(t, 600)).join('\n---\n')}`);
  return clip(out.join('\n\n'), SEED_CAP);
}
