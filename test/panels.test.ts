import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPanels, type Panel } from '../src/panels.ts';

const rig = (last = new Map<string, Panel>()) => {
  const events: any[] = [];
  const panels = createPanels((type, data) => events.push({ type, ...data }), last);
  return { events, panels, last };
};
const p = (data: unknown, extra: Partial<Panel> = {}): Panel => ({ panelId: 'a', kind: 'k', title: 'A', data, ...extra });

test('setPanel emits only when data, title or badge changed', () => {
  const { events, panels } = rig();
  panels.setPanel(p({ n: 1 }));
  panels.setPanel(p({ n: 1 }));
  assert.equal(events.length, 1);
  panels.setPanel(p({ n: 2 }));
  panels.setPanel(p({ n: 2 }, { badge: { text: '1', level: 'ok' } }));
  panels.setPanel(p({ n: 2 }, { title: 'B', badge: { text: '1', level: 'ok' } }));
  assert.deepEqual(events.map((e) => e.type), ['panel', 'panel', 'panel', 'panel']);
});

test('restore keeps the last panel per id and honors panel_removed', () => {
  const { panels, last } = rig();
  panels.restore({ type: 'panel', at: 1, ...p(1) });
  panels.restore({ type: 'panel', at: 2, ...p(2) });
  panels.restore({ type: 'panel', at: 3, ...p(3, { panelId: 'b' }) });
  panels.restore({ type: 'panel_removed', at: 4, panelId: 'b' });
  assert.deepEqual([...last.values()], [p(2)]);
  const again = rig(last);
  again.panels.setPanel(p(2));
  assert.equal(again.events.length, 0); // restored version counts as the last one
});

test('removePanel emits once and only for a known panel', () => {
  const { events, panels } = rig();
  panels.removePanel('a');
  panels.setPanel(p(1));
  panels.removePanel('a');
  panels.removePanel('a');
  assert.deepEqual(events.map((e) => e.type), ['panel', 'panel_removed']);
  assert.deepEqual(panels.panels(), []);
});

test('panel_status goes through emit and its latest shows in snapshotLines and panels()', () => {
  const { events, panels } = rig();
  panels.setPanel(p(1));
  panels.setPanelStatus({ panelId: 'a', at: 1, ok: true });
  panels.setPanelStatus({ panelId: 'a', at: 2, ok: false, error: 'x' });
  assert.equal(events.filter((e) => e.type === 'panel_status').length, 2);
  assert.deepEqual(panels.snapshotLines().map((l) => JSON.parse(l)), [{ type: 'panel_status', panelId: 'a', at: 2, ok: false, error: 'x' }]);
  assert.equal(panels.panels()[0].status?.error, 'x');
});

test('runAction reaches the handler; unknown panel gives 400, handler errors pass through', async () => {
  const { panels } = rig();
  panels.setPanel(p(1));
  panels.onPanelAction('a', async (action, args) => { if (action !== 'go') throw Object.assign(new Error('bad action'), { status: 400 }); return { got: args }; });
  assert.deepEqual(await panels.runAction('a', 'go', { x: 1 }), { got: { x: 1 } });
  await assert.rejects(async () => panels.runAction('a', 'nope', {}), { status: 400 });
  assert.throws(() => panels.runAction('zz', 'go', {}), { status: 400 });
});

test('the seam knows no panel kinds', () => {
  assert.doesNotMatch(readFileSync(new URL('../src/panels.ts', import.meta.url), 'utf8'), /job|job source|open.?item/i);
});
