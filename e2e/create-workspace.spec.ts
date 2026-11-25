import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, createWs, uniq, tmp, say, events } from './helpers.ts';

test('create_workspace makes a workspace whose arbiter gets the task', async ({ page }) => {
  const project = tmp('cwproj'), notes = tmp('cwnotes');
  const ws = await createWs(page, uniq('cwold'), { project, notes });
  const name = uniq('cwnew');
  await say(page, ws, `tool mcp__jarvis__create_workspace ${JSON.stringify({ name, task: 'TASK-TEXT' })}`, 'result');
  await expect.poll(() => events(ws).some((e) => e.type === 'text' && e.text.startsWith(`created workspace ${name} (`))).toBe(true);

  const list = (await (await page.request.get('/workspaces')).json()).workspaces;
  const next = list.find((w: any) => w.name === name);
  expect(next).toMatchObject({ project, notes });
  const first = events(next.id).find((e) => e.type === 'routed');
  expect(first.from).toBe(`workspace:${ws}`);
  expect(first.text).toContain('TASK-TEXT');
  // Its own folder; the creator's stays as it was, and the new arbiter is told where the creator's files are.
  expect(existsSync(join(notes, 'workspaces', next.id, 'status.md'))).toBe(true);
  expect(readFileSync(join(notes, 'workspaces', ws, 'status.md'), 'utf8')).toContain(`Workspace id: ${ws}`);
  expect(first.text).toContain(`The creator's notes: ${join(notes, 'workspaces', ws)}`);
});
