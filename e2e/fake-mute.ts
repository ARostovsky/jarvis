// Stand-in for wpctl (JARVIS_VOICE_MUTE_CMD="node e2e/fake-mute.ts <statefile>"): the sink state lives in <statefile> ("1" = muted, missing = unmuted); every set-mute is appended to <statefile>.log.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const [file, cmd, , val] = process.argv.slice(2);
if (cmd === 'get-volume') console.log(`Volume: 0.40${existsSync(file) && readFileSync(file, 'utf8') === '1' ? ' [MUTED]' : ''}`);
else if (cmd === 'set-mute') { writeFileSync(file, val); appendFileSync(`${file}.log`, `${val}\n`); }
else process.exit(1);
