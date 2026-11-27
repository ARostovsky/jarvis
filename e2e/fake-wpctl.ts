// Stand-in for wpctl with several sinks (tests only: `node e2e/fake-wpctl.ts <dir> <wpctl args>`), behaving like the real one: `inspect` of a missing node prints "Object '<id>' not found" to stderr and exits 3, `get-volume` and `set-mute` of a missing node print "Node '<id>' not found" to stderr and exit 0 without doing anything.
// State in <dir>: `default` = id of the default sink (missing: 1), `sinks` = lines "<id> <node.name>" (a sink not listed is named sink<id>), `mute.<id>` exists = muted, `log` = one line per set-mute "<id> <0|1>", `gone.<id>` = that node does not exist, `hang` = an unmute sleeps 4 s before it applies (the muter's timeout kills it first), `hang-inspect` = inspect sleeps 4 s.
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
const [dir, cmd, target, val] = process.argv.slice(2);
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sinks = existsSync(`${dir}/sinks`) ? readFileSync(`${dir}/sinks`, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split(' ') as [string, string]) : [];
const id = target === '@DEFAULT_AUDIO_SINK@' ? (existsSync(`${dir}/default`) ? readFileSync(`${dir}/default`, 'utf8').trim() : '1') : target;
const name = sinks.find(([i]) => i === id)?.[1] ?? `sink${id}`;
if (cmd === 'status') {
  console.log(`PipeWire 'pipewire-0'\n\nAudio\n ├─ Devices:\n │      51. Fake [alsa]\n │  \n ├─ Sinks:\n${sinks.filter(([i]) => !existsSync(`${dir}/gone.${i}`)).map(([i, n]) => ` │  ${i === id ? '*' : ' '} ${i.padStart(4)}. ${n} [vol: 0.40]\n`).join('')} │  \n ├─ Sources:\n │  \n └─ Streams:\n\nVideo\n ├─ Sinks:\n`);
  process.exit(0);
}
if (existsSync(`${dir}/gone.${id}`)) {
  console.error(cmd === 'inspect' ? `Object '${id}' not found` : `Node '${id}' not found`);
  process.exit(cmd === 'inspect' ? 3 : 0);
}
if (cmd === 'inspect') {
  if (existsSync(`${dir}/hang-inspect`)) sleep(4_000);
  console.log(`id ${id}, type PipeWire:Interface:Node\n    audio.position = "[FL, FR]"\n  * node.name = "${name}"`);
} else if (cmd === 'get-volume') console.log(`Volume: 0.40${existsSync(`${dir}/mute.${id}`) ? ' [MUTED]' : ''}`);
else if (cmd === 'set-mute') {
  if (val === '0' && existsSync(`${dir}/hang`)) sleep(4_000);
  if (val === '1') writeFileSync(`${dir}/mute.${id}`, ''); else rmSync(`${dir}/mute.${id}`, { force: true });
  appendFileSync(`${dir}/log`, `${id} ${val}\n`);
} else process.exit(1);
