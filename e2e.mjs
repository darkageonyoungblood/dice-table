import WebSocket from 'ws';
const BASE = 'http://127.0.0.1:8787';
const WS = 'ws://127.0.0.1:8787';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fails++; };

// 1. create a table
const made = await (await fetch(BASE + '/api/create', {
  method:'POST', headers:{'content-type':'application/json'},
  body: JSON.stringify({ seats: 3 })
})).json();
ok(/^[A-Z2-9]{5}$/.test(made.code), 'table code issued: ' + made.code);
ok(made.dmToken && made.dmToken.length === 48, 'DM token issued');

// 2. DM connects
const dmMsgs = [];
const dm = new WebSocket(`${WS}/ws?code=${made.code}&role=dm&token=${made.dmToken}`);
dm.on('message', d => dmMsgs.push(JSON.parse(d)));
await new Promise(r => dm.on('open', r));
await sleep(300);
ok(dmMsgs.length > 0, 'DM receives initial state');
const seats = dmMsgs.at(-1).seats;
ok(seats.length === 3, 'three seats created');
ok(seats.every(s => /^[A-Z2-9]{4}$/.test(s.code)), 'every seat has a join code');

// 3. a wrong DM token must be rejected
const badDM = new WebSocket(`${WS}/ws?code=${made.code}&role=dm&token=${'0'.repeat(48)}`);
const badDMres = await new Promise(r => { badDM.on('error', () => r('rejected')); badDM.on('open', () => r('accepted')); });
ok(badDMres === 'rejected', 'wrong DM token rejected');

// 4. a wrong seat code must be rejected
const badSeat = new WebSocket(`${WS}/ws?code=${made.code}&role=player&seat=ZZZZ`);
const badSeatRes = await new Promise(r => { badSeat.on('error', () => r('rejected')); badSeat.on('open', () => r('accepted')); });
ok(badSeatRes === 'rejected', 'wrong seat code rejected');

// 5. two players connect
const pMsgs = [[], []];
const players = [];
for (let i = 0; i < 2; i++) {
  const w = new WebSocket(`${WS}/ws?code=${made.code}&role=player&seat=${seats[i].code}`);
  w.on('message', d => pMsgs[i].push(JSON.parse(d)));
  await new Promise(r => w.on('open', r));
  players.push(w);
}
await sleep(300);
ok(pMsgs[0].length > 0 && pMsgs[1].length > 0, 'both players receive their own state');
ok(pMsgs[0].at(-1).seat.id === 0 && pMsgs[1].at(-1).seat.id === 1, 'each player gets their own seat');

// 6. DM sets advantage on seat 0 only
dm.send(JSON.stringify({ t:'mode', seat:0, mode:'adv' }));
await sleep(300);
ok(pMsgs[0].at(-1).seat.mode === 'adv', 'DM set advantage, player 0 sees it');
ok(pMsgs[1].at(-1).seat.mode === 'norm', 'player 1 unaffected');

// 7. a player cannot set their own advantage
players[1].send(JSON.stringify({ t:'mode', seat:1, mode:'adv' }));
players[1].send(JSON.stringify({ t:'modeAll', mode:'adv' }));
await sleep(350);
ok(pMsgs[1].at(-1).seat.mode === 'norm', 'player cannot grant themselves advantage');
ok(dmMsgs.at(-1).seats[1].mode === 'norm', 'DM view confirms player 1 still normal');

// 8. roll on seat 0, then check isolation
const before1 = pMsgs[1].length;
players[0].send(JSON.stringify({ t:'roll' }));
await sleep(400);
const r0 = pMsgs[0].at(-1).seat.history[0];
ok(!!r0, 'player 0 got a result: total ' + (r0 && r0.total));
ok(r0 && r0.dropped != null, 'advantage produced two dice');
ok(r0 && r0.kept === Math.max(r0.kept, r0.dropped), 'advantage kept the higher die');
ok(pMsgs[1].length === before1, 'player 1 received NOTHING when player 0 rolled');

// the real test: nothing about seat 0 exists anywhere in player 1's traffic
const p1Raw = JSON.stringify(pMsgs[1]);
ok(!p1Raw.includes(seats[0].code), "player 1 never sees seat 0's join code");
ok(!p1Raw.includes('"seat":0'), 'player 1 never receives seat 0 data');
const p1Totals = pMsgs[1].flatMap(m => (m.seat?.history || []).map(h => h.total));
ok(!p1Totals.includes(r0.total) || p1Totals.length === 0, "player 1 has no record of player 0's total");

// 9. DM sees it
const dmLog = dmMsgs.at(-1).log;
ok(dmLog.length === 1 && dmLog[0].seat === 0 && dmLog[0].total === r0.total, 'DM sees the roll in the full log');

// 10. DM rolls for a seat
dm.send(JSON.stringify({ t:'rollFor', seat:2 }));
await sleep(350);
ok(dmMsgs.at(-1).log.length === 2, 'DM can roll on behalf of a seat');

// 11. distribution sanity through the real server path
let lo = 99, hi = 0;
for (let i = 0; i < 60; i++) { players[1].send(JSON.stringify({ t:'roll' })); }
await sleep(1200);
const hist = pMsgs[1].at(-1).seat.history;
for (const h of hist) { lo = Math.min(lo, h.kept); hi = Math.max(hi, h.kept); }
ok(hist.length > 0, `player 1 accumulated ${hist.length} own rolls`);
ok(lo >= 1 && hi <= 20, `all results within 1..20 (saw ${lo}..${hi})`);
ok(hist.every(h => h.dropped == null), 'normal mode rolled a single die');

dm.close(); players.forEach(p => p.close());
await sleep(200);
console.log(fails === 0 ? '\nALL CHECKS PASSED' : `\n${fails} CHECK(S) FAILED`);
process.exit(fails ? 1 : 0);
