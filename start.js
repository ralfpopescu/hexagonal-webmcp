// Starts the agent and both consumers as three independent processes.
import { spawn } from 'node:child_process';

const procs = [
  ['agent', 'agent-server/server.js', '\x1b[35m'],
  ['maple', 'consumer-maple/server.js', '\x1b[33m'],
  ['nordlager', 'consumer-nordlager/server.js', '\x1b[36m'],
].map(([name, file, color]) => {
  const p = spawn(process.execPath, [file], { env: process.env });
  const prefix = `${color}${name.padEnd(9)}\x1b[0m│ `;
  const pipe = (stream, target) =>
    stream.on('data', (d) => d.toString().trimEnd().split('\n').forEach((l) => target.write(`${prefix}${l}\n`)));
  pipe(p.stdout, process.stdout);
  pipe(p.stderr, process.stderr);
  p.on('exit', (code) => console.log(`${prefix}exited (${code})`));
  return p;
});

setTimeout(() => {
  console.log('\n  Maple & Co. (DTC storefront)   → http://localhost:3001');
  console.log('  NORDLAGER PIM (industrial B2B) → http://localhost:3002');
  console.log('  Shared agent spec               → http://localhost:4000/spec\n');
}, 600);

process.on('SIGINT', () => {
  procs.forEach((p) => p.kill());
  process.exit(0);
});
