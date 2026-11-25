// Stand-in for voice/server.py (JARVIS_VOICE_CMD="node e2e/fake-voice.ts"). Same frame protocol; the answer depends on the frame size so tests can pick it:
// 2 bytes = crash, 4 bytes = error reply, 6 bytes = no speech, 14 bytes = never answers (hang), anything else = fixed text.
let buf = Buffer.alloc(0);
process.stdin.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
    const n = buf.readUInt32BE(0);
    buf = buf.subarray(4 + n);
    if (n === 2) process.exit(1);
    if (n === 14) continue;
    process.stdout.write(JSON.stringify(n === 4 ? { error: 'stub error' } : { text: n === 6 ? '' : 'hello from voice' }) + '\n');
  }
});
