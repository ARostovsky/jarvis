// Stand-in for wpctl (JARVIS_VOICE_MUTE_CMD="node e2e/fake-mute.ts <statefile>"): the sink state lives in <statefile> ("1" = muted, missing = unmuted); every set-mute is appended to <statefile>.log; an unmute fails while <statefile>.fail exists.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const [file, cmd, , val] = process.argv.slice(2);
if (cmd === 'inspect') console.log('id 1, type PipeWire:Interface:Node\n  * node.name = "fake-sink"'); // the id and name the muter records
else if (cmd === 'get-volume') console.log(`Volume: 0.40${existsSync(file) && readFileSync(file, 'utf8') === '1' ? ' [MUTED]' : ''}`);
else if (cmd === 'set-mute') {
  if (val === '0' && existsSync(`${file}.fail`)) process.exit(1); // tests: an unmute that fails while <statefile>.fail exists
  writeFileSync(file, val); appendFileSync(`${file}.log`, `${val}\n`);
}
else process.exit(1);
