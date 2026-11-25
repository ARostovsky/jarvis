import { test, expect, createWs, open, uniq, say, post, events } from './helpers.ts';

const call = (to: string[], text: string) => `tool mcp__jarvis__board_post ${JSON.stringify({ to, text })}`;
const boards = (id: string) => events(id).filter((e) => e.type === 'board').map((e) => `${e.from}:${e.to}:${e.text}`);
const arbiterTexts = (id: string) => events(id).filter((e) => e.type === 'text' && e.agentId === 'arbiter').map((e) => e.text as string);

test('an agent re-posting its last note before it is read sends it once; after delivery and from the user a repeat is posted', async ({ page }) => {
  const name = uniq('dedupe');
  const id = await createWs(page, name);
  await open(page, name);
  await say(page, id, 'tool mcp__jarvis__spawn_agent {"name":"helper","task":"sleep 30000"}');
  await expect.poll(() => events(id).some((e) => e.type === 'spawned' && e.agent.name === 'helper')).toBe(true);
  const helper = events(id).find((e) => e.type === 'spawned' && e.agent.name === 'helper').agent.id;

  // Unread repeat: dropped, and the tool reply names the first note.
  await say(page, id, call(['helper'], 'still blocked'), call(['helper'], 'still blocked'), 'result');
  await expect.poll(() => arbiterTexts(id).some((t) => /^not sent: .*#1$/.test(t))).toBe(true);
  expect(boards(id)).toEqual([`arbiter:${helper}:still blocked`]);

  // The helper receives the note with its next message; the same text is then a new note.
  await say(page, id, `tool mcp__jarvis__send_to_agent ${JSON.stringify({ id: helper, message: 'ping' })}`);
  await expect.poll(() => events(id).some((e) => e.type === 'board_seen' && e.agentId === helper)).toBe(true);
  await say(page, id, call(['helper'], 'still blocked'));
  await expect.poll(() => boards(id).length).toBe(2);

  // The user may repeat on purpose.
  expect((await post(page, '/board', { ws: id, to: ['all'], text: 'same' })).ok()).toBe(true);
  expect((await post(page, '/board', { ws: id, to: ['all'], text: 'same' })).ok()).toBe(true);
  expect(boards(id).filter((b) => b === 'user:all:same')).toHaveLength(2);
});
