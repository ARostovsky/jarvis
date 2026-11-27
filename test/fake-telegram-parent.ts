// Stands in for the Jarvis server: starts the fake bridge through startTelegram, prints the child pid, then ends as argv[2] says ("exit": process.exit(0) at once; "wait": runs until a signal).
import { startTelegram } from '../src/telegram-autostart.ts';
const c = startTelegram({ script: new URL('./fake-telegram-bridge.ts', import.meta.url).pathname, log: () => {} });
console.log(`child ${c.pid}`);
if (process.argv[2] === 'exit') setTimeout(() => process.exit(0), 600); // late enough for the test to see the child running
setInterval(() => {}, 1000);
