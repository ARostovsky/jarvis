// Stand-in for pw-record (JARVIS_VOICE_CAPTURE_CMD="node e2e/fake-capture.ts [mode] [pidfile]"): raw 16 kHz mono s16le on stdout, 100 ms (3200 bytes) of a constant tone every 100 ms, the first block at once.
// mode: tone (default, amplitude 8000), odd (tone in blocks of 3201 bytes, so chunk edges fall inside a sample), silent (prints nothing), exit (prints an error and exits 1).
import { writeFileSync } from 'node:fs';
const [mode = 'tone', pidfile] = process.argv.slice(2);
if (pidfile) writeFileSync(pidfile, String(process.pid));
if (mode === 'exit') { console.error('stub: no PipeWire daemon'); process.exit(1); }
if (mode === 'odd') {
  const tone = Buffer.alloc(3200 * 8);
  for (let i = 0; i < tone.length / 2; i++) tone.writeInt16LE(8000, i * 2);
  let at = 0;
  const next = () => { const b = tone.subarray(at, at + 3201); at = (at + 3201) % (tone.length - 3201); return b; }; // shortcut: the wrap may shift the sample phase by one byte, fine for a constant tone
  process.stdout.write(next());
  setInterval(() => process.stdout.write(next()), 100);
}
if (mode === 'tone') {
  const block = Buffer.alloc(3200);
  for (let i = 0; i < 1600; i++) block.writeInt16LE(8000, i * 2);
  process.stdout.write(block);
  setInterval(() => process.stdout.write(block), 100);
}
setInterval(() => {}, 1 << 30);
process.on('SIGTERM', () => process.exit(0));
