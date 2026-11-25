// Pure pieces of the open items wiring: switch, prompt text with its gating, the reset seed lines. No SDK, no state. The line format and the (you) rule live in notes-layout.ts (OPEN_ITEMS_FORMAT); this adds only what the panel changes.
export const openItemsOn = () => process.env.JARVIS_OPEN_ITEMS !== '0';

export const OPEN_ITEMS_RULES = `Your open-items.md also feeds the "Open items" panel pinned above this chat. The panel is read-only for the user: it only shows the file. The user marks something done by telling you in chat; then you edit the file (single-line edits, re-read it right before each edit). Keep the rule that you write [x] only after you verified it yourself. The panel shows parked [~] items too, so do not list them in chat unless they block the goal or the user asks.`;

// The arbiter's open items paragraph: only with the switch on and a notes folder (the file lives there).
export const openItemsPrompt = (notes?: string) => (openItemsOn() && notes ? `\n${OPEN_ITEMS_RULES}` : '');

export const SEED_ITEMS = 20;
// Seed lines for a reset: the texts of the open and parked items, so the new arbiter does not raise them again. '' when there are none.
export function openItemsSeed(texts: string[]): string {
  if (!texts.length) return '';
  const shown = texts.slice(0, SEED_ITEMS).map((t) => `- ${t.replace(/\s+/g, ' ').slice(0, 200)}`);
  return `Open items shown in the panel now (text only; do not raise them again, the state is in open-items.md):\n${shown.join('\n')}${texts.length > SEED_ITEMS ? `\n… and ${texts.length - SEED_ITEMS} more (open-items.md)` : ''}`;
}
