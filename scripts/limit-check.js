// Asks the queue app whether the cycle may start its next step (POST /api/gate), so a cycle stops before it runs the
// 5-hour window or the week out. The /q skill runs it before each card's step:
//   node scripts/limit-check.js [board-planner|board-implementer|board-reviewer]
// with the agent the step runs, or no argument for main-session work. Prints "go: <why>" and exits 0, or
// "stop: <why>" and exits 1. When the app isn't running it says so and exits 0: a cycle started from chat still runs,
// only without the gate.
'use strict';
const http = require('http');

const body = JSON.stringify({ agent: process.argv[2] || null });
const req = http.request({
  host: '127.0.0.1', port: Number(process.env.QUEUE_PORT) || 4747, path: '/api/gate', method: 'POST',
  headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
  timeout: 3 * 60 * 1000, // the gate runs a usage probe first, normally a few seconds
}, res => {
  let s = '';
  res.on('data', d => { s += d; });
  res.on('end', () => {
    let r = null; try { r = JSON.parse(s); } catch { /* below */ }
    if (res.statusCode !== 200 || !r) { console.log(`go: the app answered ${res.statusCode}, so no gate this time`); process.exit(0); }
    console.log(`${r.go ? 'go' : 'stop'}: ${r.reason}`);
    process.exit(r.go ? 0 : 1);
  });
});
req.on('timeout', () => req.destroy(new Error('timeout')));
req.on('error', e => { console.log(`go: the queue app didn't answer (${e.message}), so no gate this time`); process.exit(0); });
req.end(body);
