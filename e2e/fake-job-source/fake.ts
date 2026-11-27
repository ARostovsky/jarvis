// Deterministic job source for the e2e specs: prints the row stored in $FAKE_JOBS_DIR/<id>.json for each id, so a spec changes a job by writing a file.
// `--fields cost` (the slow run) prints only id and costUsd. An id without a file is a running job.
// Id prefixes: fail- exits 1 with a stderr line, hang- sleeps past the timeout, v2- prints schema 2, extra- adds fields Jarvis does not know.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const at = argv.indexOf('--fields');
const fields = at >= 0 ? argv.splice(at, 2)[1].split(',') : undefined;
const ids = argv;

if (ids.some((i) => i.startsWith('fail-'))) { console.error('fake job source: backend refused the request'); process.exit(1); }
if (ids.some((i) => i.startsWith('hang-'))) await new Promise((r) => setTimeout(r, 120_000));

// While $FAKE_JOBS_DIR/.hold exists the call waits (at most 1.5 s), so a spec can change several jobs and have one poll see all of them.
for (let i = 0; i < 30 && existsSync(join(process.env.FAKE_JOBS_DIR ?? '.', '.hold')); i++) await new Promise((r) => setTimeout(r, 50));

const rows = ids.map((id) => {
  let row: Record<string, unknown> = { state: 'running' };
  try { row = JSON.parse(readFileSync(join(process.env.FAKE_JOBS_DIR ?? '.', `${id}.json`), 'utf8')); } catch {}
  if (fields) return { id, ...(row.costUsd !== undefined && { costUsd: row.costUsd }) };
  return { id, ...row, ...(id.startsWith('extra-') && { flavour: 'spicy', nested: { a: 1 } }) };
});
console.log(JSON.stringify({ schema: ids.some((i) => i.startsWith('v2-')) ? 2 : 1, checked: new Date().toISOString(), rows }));
