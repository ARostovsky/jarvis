// Stage-1 console client: talk to the arbiter, watch events, answer permission asks.
import { createInterface } from 'node:readline';
import { bus, startArbiter, tellArbiter, answerAsk } from './agents.ts';

const short = (v: unknown, n = 160) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
};

bus.on('event', (e) => {
  switch (e.type) {
    case 'spawned': return console.log(`+ ${e.agent.id}  cwd=${e.agent.cwd}`);
    case 'status': return console.log(`  ${e.agentId}: ${e.status}`);
    case 'text': return console.log(`[${e.agentId}] ${e.text}`);
    case 'tool': return console.log(`  ${e.agentId} -> ${e.name} ${short(e.input)}`);
    case 'routed': return console.log(`  ${e.from} => ${e.to}: ${short(e.text, 100)}`);
    case 'result': return console.log(`  ${e.agentId} done ($${e.costUsd.toFixed(3)})`);
    case 'ask': return console.log(`? ${e.reqId} ${e.tool} ${short(e.input, 300)}\n  answer: /y ${e.reqId}  or  /n ${e.reqId}`);
  }
});

startArbiter(process.argv[2]);
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const m = line.match(/^\/([yn]) (\S+)/);
  if (m) answerAsk(m[2], m[1] === 'y');
  else if (line.trim()) tellArbiter(line);
});
