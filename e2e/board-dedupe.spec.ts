import { test, expect, createWs, open, uniq, say, events } from './helpers.ts';

test('an agent re-posting the same board note to the same recipients sends it once', async ({ page }) => {
  const name = uniq('dedupe');
  const id = await createWs(page, name);
  await open(page, name);
  const post = (to: string[], text: string) => `tool mcp__jarvis__board_post ${JSON.stringify({ to, text })}`;
  await say(page, id, post(['all'], 'still blocked'), post(['all'], 'still blocked'), post(['arbiter'], 'still blocked'), post(['all'], 'other'));
  await expect.poll(() => events(id).filter((e) => e.type === 'board').length).toBe(3);
  expect(events(id).filter((e) => e.type === 'board').map((e) => `${e.to}:${e.text}`)).toEqual(['all:still blocked', 'arbiter:still blocked', 'all:other']);
});
