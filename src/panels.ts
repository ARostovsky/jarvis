// Panels: named blocks of live data in a workspace, fed by server sources and shown pinned in the UI. Generic seam: no knowledge of what a panel holds.
export type Panel = { panelId: string; kind: string; title: string; data: unknown; badge?: { text: string; level: 'active' | 'ok' | 'warn' | 'error' } };
export type PanelStatus = { panelId: string; at: number; ok: boolean; error?: string; detail?: unknown };
type Handler = (action: string, args: any) => unknown | Promise<unknown>;

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const same = (a: Panel, b: Panel) => JSON.stringify([a.kind, a.title, a.data, a.badge]) === JSON.stringify([b.kind, b.title, b.data, b.badge]);

// `emit` writes an event (persisting it unless transient); `last` holds the latest persisted panel per id and is shared with the caller so restore() can fill it.
export function createPanels(emit: (type: string, data: object) => void, last: Map<string, Panel>) {
  const status = new Map<string, PanelStatus>(); // freshness, never persisted
  const handlers = new Map<string, Handler>();

  return {
    // Writes an event only when something differs from the last persisted version.
    setPanel(p: Panel) {
      const prev = last.get(p.panelId);
      if (prev && same(prev, p)) return;
      const panel: Panel = { panelId: p.panelId, kind: p.kind, title: p.title, data: p.data, ...(p.badge && { badge: p.badge }) };
      last.set(p.panelId, panel);
      emit('panel', panel);
    },
    removePanel(panelId: string) {
      if (!last.delete(panelId)) return;
      status.delete(panelId);
      emit('panel_removed', { panelId });
    },
    setPanelStatus(s: PanelStatus) {
      status.set(s.panelId, s);
      emit('panel_status', s);
    },
    onPanelAction(panelId: string, handler: Handler) {
      handlers.set(panelId, handler);
    },
    // Sorted by id so the order is stable across restarts.
    panels: (): (Panel & { status?: PanelStatus })[] =>
      [...last.values()].sort((a, b) => a.panelId.localeCompare(b.panelId)).map((p) => ({ ...p, status: status.get(p.panelId) })),
    runAction(panelId: string, action: string, args: any) {
      const h = last.has(panelId) ? handlers.get(panelId) : undefined;
      if (!h) throw fail(400, `no panel ${panelId}`);
      return h(action, args);
    },
    // Replays a logged event when rebuilding from events.jsonl; last one per id wins.
    restore(ev: any) {
      if (ev.type === 'panel') {
        const { type, at, ...panel } = ev;
        last.set(panel.panelId, panel);
      } else if (ev.type === 'panel_removed') last.delete(ev.panelId);
    },
    // Transient status events a freshly connected UI needs.
    snapshotLines: () => [...status.values()].map((s) => JSON.stringify({ type: 'panel_status', ...s })),
  };
}
