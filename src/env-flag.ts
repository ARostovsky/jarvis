// On/off switches (JARVIS_VOICE, JARVIS_TELEGRAM) from the shell or the Jarvis env file. `1` is on, `0` is off, `also` values (voice: `cpu`) are on with a mode. Unset or empty falls through to the next source; a garbage value logs one warning per name and source and falls through too. Order: shell, env file, off.
export type Flag = { enabled: boolean; source: 'shell' | 'env file' | 'default'; mode?: string };

// Filled by local-env.ts: the parsed env file and the names it supplied (not set in the shell). process.env alone cannot show a garbage shell value behind a good file value.
export const fileEnv: Record<string, string> = {};
export const fromFile = new Set<string>();

const warned = new Set<string>();
export function pickFlag(name: string, also: string[], shell: string | undefined, file: string | undefined, warn: (m: string) => void = console.error): Flag {
  for (const [source, raw] of [['shell', shell], ['env file', file]] as const) {
    const v = raw?.trim() ?? '';
    if (v === '') continue;
    if (v === '1') return { enabled: true, source };
    if (also.includes(v)) return { enabled: true, source, mode: v };
    if (v === '0') return { enabled: false, source };
    if (!warned.has(`${name} ${source}`)) { warned.add(`${name} ${source}`); warn(`${name}: unknown value "${v}" in ${source} (use 1 or 0), ignoring it`); }
  }
  return { enabled: false, source: 'default' };
}

export const resolveFlag = (name: string, ...also: string[]): Flag => pickFlag(name, also, fromFile.has(name) ? undefined : process.env[name], fileEnv[name]);

// The lines `jarvis start` prints; also what the arguments of the resolver mean to a reader.
export const flagLine = (label: string, f: Flag) => `${label}: ${f.enabled ? 'enabled' : 'disabled'}${f.mode ? `, ${f.mode} mode` : ''} (${f.source})`;
export const statusLines = () => [flagLine('voice input', resolveFlag('JARVIS_VOICE', 'cpu')), flagLine('telegram bridge', resolveFlag('JARVIS_TELEGRAM'))];
