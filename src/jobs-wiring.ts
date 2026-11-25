// Pure pieces of the jobs wiring: prompt text with its gating, the arbiter's tool names, the `[jobs]` message. No SDK, no state.
import { join, resolve } from 'node:path';
import type { Change } from './jobs.ts';

export const jobsOn = () => process.env.JARVIS_JOBS !== '0';
const mcp = (names: string[]) => names.map((t) => `mcp__jarvis__${t}`);
// Only the arbiter ever gets these: they are in no tool list of agents or sub-agents.
export const JOBS_TOOLS = mcp(['list_providers', 'watch_jobs', 'clear_jobs', 'jobs_status']);
export const PROPOSE_TOOLS = mcp(['propose_provider']);
export const jobsToolNames = (notes?: string) => (jobsOn() ? [...JOBS_TOOLS, ...(notes ? PROPOSE_TOOLS : [])] : []);

// The repo root, for the template path in the offer text (the server's own location, not the workspace's).
export const REPO_ROOT = resolve(import.meta.dirname, '..');

export const JOBS_RULES = `Long jobs (pipeline runs, CI, deploys, training) are watched by status providers. list_providers shows the ones you may use. Right after you or an agent start a job that a provider covers, call watch_jobs with its ids and short labels. Jarvis then polls it without any model turn, shows it to the user in the jobs panel, and sends you one batched "[jobs]" message whenever a job changes state (failed, finished or any other change). Cost and other slow numbers come from the provider on a slower schedule; do not look them up yourself. Only you call watch_jobs and clear_jobs; agents and sub-agents never do. Drop rows with clear_jobs (given ids, or all but the current jobs). Never check a watched job yourself: no Bash, no cron, no sleep loop. If you need its state, call jobs_status. Never spawn an agent or send an agent a message only to check, fetch or print the status of a job. That costs a turn of the agent and a turn of yours each time. Status is a script's job, not an agent's. For a job no provider covers, check it once when the user asks, and do not loop.`;

export const NO_NOTES_SENTENCE = 'Building a new provider needs a notes folder for this workspace. If the user asks for one, tell them to set a notes folder in the tab menu first.';

export const offerRules = (notes: string, root = REPO_ROOT) => `Offer to build a status provider when a long job has no provider and someone keeps checking its status: the user asks about it a second time, you are about to check it a second time, or you are about to schedule a cron, a sleep loop or an agent for it. First read ${notes}/status-providers.md. If it already records a decision for this job kind, follow it and do not offer. Otherwise ask once, in one sentence, for example: "I keep checking <job kind> by hand. Shall I build a status provider for it? Then it shows in the jobs panel and checking costs no tokens." Record the answer (yes, no or later) with the date in ${notes}/status-providers.md (a table: job kind, provider, what the ids look like, decision). After "no", never offer again for that job kind unless the user brings it up. After "later", offer again at most once, at the next new job of that kind. Never offer during an urgent task or in the same message as a failure report. On yes, spawn one agent (model sonnet, effort medium, no lead). Its task names the job kind, states what you know about how its status is checked (commands, ids, links from the notes or the chat), and says: "Read and follow ${join(root, 'templates', 'status-provider', 'SKILL.md')}." When it reports VERDICT verified with a passing provider-check, call propose_provider with its folder and report, and tell the user that an approval card is waiting. After approval, record the provider in ${notes}/status-providers.md and watch the jobs in flight.`;

// The arbiter's jobs paragraph, or '' with JARVIS_JOBS=0. The offer, template path and propose_provider need a notes folder as well.
export function jobsPrompt(notes?: string, root = REPO_ROOT): string {
  if (!jobsOn()) return '';
  return `\n${JOBS_RULES} ${notes ? offerRules(notes, root) : NO_NOTES_SENTENCE}`;
}

// One batched message for a poll round. Text from providers is untrusted: every value is quoted, lines are capped.
export function jobsMessage(changes: Change[]): string {
  const names = [...new Set(changes.map((c) => c.provider))];
  const q = (s: string | undefined, n = 200) => (s ? ` ${JSON.stringify(s.slice(0, n))}` : '');
  const lines = changes.slice(0, 25).map((c) => `  - ${c.id}${c.label ? ` (${JSON.stringify(c.label.slice(0, 80))})` : ''} [${c.provider}]: ${c.from} -> ${c.to}${c.detail ? `, detail${q(c.detail)}` : ''}${c.step ? `, step${q(c.step)}` : ''}${c.error ? `, error${q(c.error, 300)}` : ''}${c.link ? `, ${c.link}` : ''}`);
  if (changes.length > 25) lines.push(`  - ... and ${changes.length - 25} more, call jobs_status`);
  return `[jobs] Status from provider ${names.join(', ')}, not from the user. Job state changes:\n${lines.join('\n')}`.slice(0, 6000);
}
