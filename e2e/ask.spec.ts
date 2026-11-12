import { test, expect, createWs, open, uniq, say, post, events, type Page } from './helpers.ts';

// The fake's perm command calls canUseTool and says what came back: "allow <input>" or "deny <message>".
const reply = (page: Page, start: string) => page.locator('#log div:not(.user)').filter({ hasText: new RegExp(`^${start}`) });

test('a permission prompt: allowed in the UI, the session gets the input back', async ({ page }) => {
  const name = uniq('perm');
  const id = await createWs(page, name);
  await open(page, name);
  await say(page, id, 'perm Bash {"command":"rm -rf build"}');
  const card = page.locator('#asks .ask');
  await expect(card).toContainText('arbiter wants Bash');
  await expect(card.locator('pre')).toContainText('"command": "rm -rf build"');
  await expect(page.locator('#core')).toHaveClass(/\bwaiting\b/);
  await page.reload(); // a live ask is part of the snapshot
  await expect(card).toHaveCount(1);
  await card.getByRole('button', { name: 'ALLOW' }).click();
  await expect(card).toHaveCount(0);
  await expect(reply(page, 'allow')).toHaveText('allow {"command":"rm -rf build"}');
  await expect(page.locator('#core')).toHaveClass(/\bidle\b/);
});

test('a permission prompt: denied in the UI, the session gets the denial', async ({ page }) => {
  const name = uniq('deny');
  const id = await createWs(page, name);
  await open(page, name);
  await say(page, id, 'perm Write {"file_path":"/tmp/x","content":"y"}');
  const card = page.locator('#asks .ask');
  await card.getByRole('button', { name: 'DENY' }).click();
  await expect(card).toHaveCount(0);
  await expect(reply(page, 'deny')).toHaveText('deny User denied');
  await expect(page.locator('#core')).toHaveClass(/\bidle\b/);
});

test('AskUserQuestion: the picked option and the note reach the session', async ({ page }) => {
  const name = uniq('askq');
  const id = await createWs(page, name);
  await open(page, name);
  const questions = [{ question: 'Which color?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cold' }] }];
  await say(page, id, `perm AskUserQuestion ${JSON.stringify({ questions })}`);
  const card = page.locator('#asks .ask');
  await expect(card).toContainText('arbiter asks');
  await expect(card).toContainText('Which color?');
  const answer = card.getByRole('button', { name: 'ANSWER' });
  await expect(answer).toBeDisabled();
  await card.getByRole('button', { name: /^Blue/ }).click();
  await card.getByPlaceholder('Notes for the agent (optional)…').fill('navy is fine');
  await answer.click();
  await expect(card).toHaveCount(0);
  const input = { questions, answers: { 'Which color?': 'Blue' }, annotations: { 'Which color?': { notes: 'navy is fine' } } };
  await expect(reply(page, 'allow')).toHaveText(`allow ${JSON.stringify(input)}`);
});

test('AskUserQuestion: SKIP denies it', async ({ page }) => {
  const name = uniq('askskip');
  const id = await createWs(page, name);
  await open(page, name);
  await say(page, id, 'perm AskUserQuestion {"questions":[{"question":"Go on?","header":"Go","multiSelect":false,"options":[{"label":"Yes"},{"label":"No"}]}]}');
  await page.locator('#asks .ask').getByRole('button', { name: 'SKIP' }).click();
  await expect(page.locator('#asks .ask')).toHaveCount(0);
  await expect(reply(page, 'deny')).toHaveText('deny User denied');
});

test('STOP while a prompt waits: the prompt goes away and the next message resumes', async ({ page }) => {
  const name = uniq('askstop');
  const id = await createWs(page, name);
  await open(page, name);
  await say(page, id, 'perm Bash {"command":"ls"}');
  await expect(page.locator('#asks .ask')).toHaveCount(1);
  await page.locator('#pstop').click();
  await expect(page.locator('#asks .ask')).toHaveCount(0);
  await expect(page.locator('#core')).toHaveClass(/\bstopped\b/);
  await say(page, id, 'say back');
  await expect(reply(page, 'back')).toHaveText('back');
  await expect(page.locator('#core')).toHaveClass(/\bidle\b/);
});

test('STOP in the middle of a turn keeps the cost of that turn and the agent stays stopped', async ({ page }) => {
  const id = await createWs(page, uniq('stopcost'));
  await say(page, id, 'cost 0.5', 'sleep 30000', 'say never');
  await expect.poll(async () => (await (await page.request.get('/workspaces')).json()).workspaces.find((w: any) => w.id === id)?.running).toBe(1);
  expect((await post(page, '/stop', { ws: id, id: 'arbiter' })).ok()).toBe(true);
  await expect.poll(() => events(id).find((e) => e.type === 'result')?.costUsd).toBe(0.5);
  expect(events(id).filter((e) => e.type === 'status').at(-1).status).toBe('stopped');
});

test('a message after STOP once the interrupted result is in: a new session resumes and runs it', async ({ page }) => {
  const id = await createWs(page, uniq('stopmsg'));
  await say(page, id, 'sleep 30000', 'say never');
  await expect.poll(async () => (await (await page.request.get('/workspaces')).json()).workspaces.find((w: any) => w.id === id)?.running).toBe(1);
  await post(page, '/stop', { ws: id, id: 'arbiter' });
  await say(page, id, 'cost 0.7', 'sleep 6000', 'say back');
  await expect.poll(() => events(id).filter((e) => e.type === 'result').at(-1)?.costUsd, { timeout: 15000 }).toBe(0.7);
  expect(events(id).filter((e) => e.type === 'text').at(-1).text).toBe('back');
  expect(events(id).filter((e) => e.type === 'status').at(-1).status).toBe('idle');
});

test('a message after STOP but before the interrupted result: the turn is not an error and the queued turn runs', async ({ page }) => {
  const id = await createWs(page, uniq('stopslow'));
  await say(page, id, 'slowinterrupt 1500', 'sleep 30000', 'say never');
  await expect.poll(async () => (await (await page.request.get('/workspaces')).json()).workspaces.find((w: any) => w.id === id)?.running).toBe(1);
  await post(page, '/stop', { ws: id, id: 'arbiter' });
  await say(page, id, 'cost 0.7', 'sleep 6000', 'say back');
  await expect.poll(() => events(id).filter((e) => e.type === 'result').at(-1)?.costUsd, { timeout: 15000 }).toBe(0.7);
  expect(events(id).filter((e) => e.type === 'text').at(-1).text).toBe('back');
  expect(events(id).some((e) => e.type === 'status' && e.status === 'error')).toBe(false);
  expect(events(id).filter((e) => e.type === 'status').at(-1).status).toBe('idle');
});
