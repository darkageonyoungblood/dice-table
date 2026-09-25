/**
 * Dice table. Worker + Durable Object.
 *
 * The whole point of the server is enforcement. Two things cannot be done
 * in the browser and are done here instead:
 *
 *   1. Rolling. The die is rolled inside the Durable Object, so a player
 *      cannot edit a result on the way back. The client only animates a
 *      number it was given.
 *
 *   2. Visibility. A player socket is never sent another player's result.
 *      Hiding rolls with CSS or a client-side filter is not hiding them,
 *      because anything that reaches the browser can be read in devtools.
 */
import { DurableObject } from "cloudflare:workers";

/* ------------------------------------------------------------ randomness */

// 2^32 is not divisible by 20, so a raw modulo would favour the low faces.
// Discard draws landing in the short tail instead.
const LIMIT = Math.floor(0x100000000 / 20) * 20;

function d20() {
  const buf = new Uint32Array(1);
  let v;
  do {
    crypto.getRandomValues(buf);
    v = buf[0];
  } while (v >= LIMIT);
  return (v % 20) + 1;
}

// Unambiguous alphabet: no O/0, no I/1, no S/5.
const ALPHABET = "ABCDEFGHJKLMNPQRTUVWXYZ2346789";

function code(n) {
  const buf = new Uint32Array(n);
  crypto.getRandomValues(buf);
  let s = "";
  for (let i = 0; i < n; i++) s += ALPHABET[buf[i] % ALPHABET.length];
  return s;
}

function token() {
  const buf = new Uint8Array(24);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time-ish compare, so a wrong token cannot be found by timing.
function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const MAX_SEATS = 12;
const MAX_LOG = 200;
const MAX_HISTORY = 40;

/* ------------------------------------------------------------ durable object */

export class Table extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.room = null;
    ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get("room")) || null;
    });
  }

  save() {
    return this.ctx.storage.put("room", this.room);
  }

  newSeat(i) {
    return {
      id: i,
      code: code(4),
      name: `Player ${i + 1}`,
      mode: "norm",
      mod: 0,
      history: [],
    };
  }

  /** Called over RPC by the Worker before any socket is opened. */
  async create(roomCode, seats) {
    this.room = {
      code: roomCode,
      dmToken: token(),
      created: Date.now(),
      seats: Array.from({ length: clampSeats(seats) }, (_, i) => this.newSeat(i)),
      dmHistory: [],
      log: [],
    };
    await this.save();
    return { code: this.room.code, dmToken: this.room.dmToken };
  }

  async exists() {
    return !!this.room;
  }

  /** Check a seat code without opening a socket, so joining can fail cleanly. */
  async checkSeat(seatCode) {
    if (!this.room) return { ok: false, error: "That table does not exist." };
    const seat = this.room.seats.find(s => s.code === String(seatCode || "").toUpperCase());
    if (!seat) return { ok: false, error: "That seat code is not on this table." };
    return { ok: true, seat: seat.id, name: seat.name };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const role = url.searchParams.get("role");
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    if (!this.room) return new Response("No such table", { status: 404 });

    let who;
    if (role === "dm") {
      if (!sameSecret(url.searchParams.get("token") || "", this.room.dmToken)) {
        return new Response("Bad DM token", { status: 403 });
      }
      who = { role: "dm" };
    } else {
      const seat = this.room.seats.find(
        s => s.code === (url.searchParams.get("seat") || "").toUpperCase());
      if (!seat) return new Response("Bad seat code", { status: 403 });
      who = { role: "player", seat: seat.id };
    }

    // Hibernation: the attachment survives eviction, so a woken object
    // still knows which socket belongs to whom.
    this.ctx.acceptWebSocket(server, [who.role === "dm" ? "dm" : `seat:${who.seat}`]);
    server.serializeAttachment(who);
    this.push(server, who);
    if (who.role === "player") this.pushDM();

    return new Response(null, { status: 101, webSocket: client });
  }

  /* ---------------------------------------------------------- projections */

  // What a DM is allowed to see: everything.
  dmView() {
    const connected = new Set();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a && a.role === "player") connected.add(a.seat);
    }
    return {
      t: "dm",
      code: this.room.code,
      seats: this.room.seats.map(s => ({
        id: s.id, code: s.code, name: s.name, mode: s.mode, mod: s.mod,
        connected: connected.has(s.id),
        last: s.history[0] || null,
      })),
      dmHistory: this.room.dmHistory,
      log: this.room.log,
    };
  }

  // What a player is allowed to see: their own seat, and nothing else.
  // No other seat's name, mode, or result is present in this object.
  playerView(seatId) {
    const s = this.room.seats[seatId];
    return {
      t: "me",
      code: this.room.code,
      seat: { id: s.id, name: s.name, mode: s.mode, mod: s.mod, history: s.history },
    };
  }

  push(ws, who) {
    try {
      ws.send(JSON.stringify(
        who.role === "dm" ? this.dmView() : this.playerView(who.seat)));
    } catch { /* socket already gone */ }
  }

  pushDM() {
    const v = JSON.stringify(this.dmView());
    for (const ws of this.ctx.getWebSockets("dm")) {
      try { ws.send(v); } catch { /* ignore */ }
    }
  }

  pushSeat(seatId) {
    const v = JSON.stringify(this.playerView(seatId));
    for (const ws of this.ctx.getWebSockets(`seat:${seatId}`)) {
      try { ws.send(v); } catch { /* ignore */ }
    }
  }

  /* ---------------------------------------------------------- rolling */

  resolve(mode, mod) {
    const a = d20();
    const b = mode === "norm" ? null : d20();
    let kept = a, dropped = null;
    if (b !== null) {
      kept = mode === "adv" ? Math.max(a, b) : Math.min(a, b);
      dropped = kept === a ? b : a;
    }
    return { kept, dropped, mode, mod, total: kept + mod, ts: Date.now() };
  }

  rollSeat(seatId) {
    const s = this.room.seats[seatId];
    if (!s) return;
    const r = this.resolve(s.mode, s.mod);
    s.history.unshift(r);
    s.history.splice(MAX_HISTORY);
    this.room.log.unshift({ ...r, seat: s.id, name: s.name });
    this.room.log.splice(MAX_LOG);
    this.save();
    this.pushSeat(seatId);
    this.pushDM();
  }

  /* ---------------------------------------------------------- messages */

  async webSocketMessage(ws, raw) {
    const who = ws.deserializeAttachment();
    if (!who || !this.room) return;

    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (who.role === "player") {
      const s = this.room.seats[who.seat];
      if (!s) return;
      if (m.t === "roll") {
        this.rollSeat(who.seat);
      } else if (m.t === "name" && typeof m.name === "string") {
        s.name = m.name.slice(0, 24).trim() || s.name;
        await this.save();
        this.pushSeat(who.seat);
        this.pushDM();
      }
      // A player asking to change their own mode is ignored on purpose.
      // Advantage is the DM's call.
      return;
    }

    // ---- DM only past this point
    switch (m.t) {
      case "mode": {
        const s = this.room.seats[m.seat];
        if (s && ["norm", "adv", "dis"].includes(m.mode)) {
          s.mode = m.mode;
          await this.save();
          this.pushSeat(s.id);
          this.pushDM();
        }
        break;
      }
      case "modeAll": {
        if (!["norm", "adv", "dis"].includes(m.mode)) break;
        for (const s of this.room.seats) s.mode = m.mode;
        await this.save();
        for (const s of this.room.seats) this.pushSeat(s.id);
        this.pushDM();
        break;
      }
      case "mod": {
        const s = this.room.seats[m.seat];
        if (s && Number.isFinite(m.mod)) {
          s.mod = Math.max(-20, Math.min(20, Math.trunc(m.mod)));
          await this.save();
          this.pushSeat(s.id);
          this.pushDM();
        }
        break;
      }
      case "seats": {
        const n = clampSeats(m.n);
        const cur = this.room.seats.length;
        if (n > cur) {
          for (let i = cur; i < n; i++) this.room.seats.push(this.newSeat(i));
        } else if (n < cur) {
          this.room.seats.length = n;
        }
        await this.save();
        this.pushDM();
        break;
      }
      case "rollFor":
        this.rollSeat(m.seat);
        break;
      case "rollDM": {
        const r = this.resolve(
          ["norm", "adv", "dis"].includes(m.mode) ? m.mode : "norm",
          Number.isFinite(m.mod) ? Math.trunc(m.mod) : 0);
        this.room.dmHistory.unshift(r);
        this.room.dmHistory.splice(MAX_HISTORY);
        await this.save();
        this.pushDM();
        break;
      }
      case "clear":
        for (const s of this.room.seats) s.history = [];
        this.room.log = [];
        this.room.dmHistory = [];
        await this.save();
        for (const s of this.room.seats) this.pushSeat(s.id);
        this.pushDM();
        break;
    }
  }

  async webSocketClose(ws) {
    try { ws.close(); } catch { /* ignore */ }
    this.pushDM();
  }

  async webSocketError(ws) {
    this.pushDM();
  }
}

function clampSeats(n) {
  n = Math.trunc(Number(n) || 4);
  return Math.max(1, Math.min(MAX_SEATS, n));
}

/* ------------------------------------------------------------ worker */

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { "content-type": "application/json" },
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/create" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const roomCode = code(5);
      const stub = env.TABLE.getByName(roomCode);
      const made = await stub.create(roomCode, body.seats);
      return json(made);
    }

    if (url.pathname === "/api/seat" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const roomCode = String(body.code || "").toUpperCase();
      if (!/^[A-Z2-9]{5}$/.test(roomCode)) {
        return json({ ok: false, error: "That table code does not look right." }, 400);
      }
      const stub = env.TABLE.getByName(roomCode);
      if (!(await stub.exists())) {
        return json({ ok: false, error: "No table with that code." }, 404);
      }
      return json(await stub.checkSeat(body.seat));
    }

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected websocket", { status: 426 });
      }
      const roomCode = (url.searchParams.get("code") || "").toUpperCase();
      if (!/^[A-Z2-9]{5}$/.test(roomCode)) {
        return new Response("Bad table code", { status: 400 });
      }
      return env.TABLE.getByName(roomCode).fetch(request);
    }

    // The client is embedded below, so there is no assets directory.
    return new Response(CLIENT_HTML, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};


/* ===================================================== embedded client */

const CLIENT_HTML = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n<title>Dice Table</title>\n<meta name=\"description\" content=\"A shared d20 table. The DM sees every roll, players see only their own.\">\n<style>\n  :root{\n    --ground:#2A1D24; --lift:#3A2A32; --lift2:#46333C;\n    --paper:#F5F0E3; --dim:#C9BCA8; --faint:#8A7A80;\n    --ochre:#E8B33C; --sage:#A8BC8C; --crit:#7FCF7F; --fumble:#D9604A;\n    --rule:#54424C;\n    box-sizing:border-box;\n    padding-top:env(safe-area-inset-top,0px); padding-bottom:env(safe-area-inset-bottom,0px);\n  }\n  *{box-sizing:border-box}\n  html{-webkit-text-size-adjust:100%}\n  body{margin:0;background:var(--ground);color:var(--paper);\n       font-family:ui-serif,Georgia,\"Times New Roman\",serif;line-height:1.5;min-height:100vh}\n  .wrap{max-width:60rem;margin:0 auto;padding:1.25rem}\n  .narrow{max-width:26rem}\n  h1{font-family:ui-sans-serif,system-ui,sans-serif;font-weight:800;font-size:.8125rem;\n     letter-spacing:.22em;text-transform:uppercase;color:var(--ochre);margin:0 0 1.25rem}\n  h2{font-family:ui-sans-serif,system-ui,sans-serif;font-weight:700;font-size:.75rem;\n     letter-spacing:.16em;text-transform:uppercase;color:var(--faint);margin:1.75rem 0 .65rem}\n  .screen{display:none}\n  .screen.on{display:block}\n\n  button,input,select{font:inherit}\n  button{font-family:ui-sans-serif,system-ui,sans-serif;font-weight:700;font-size:.9375rem;\n    background:transparent;color:var(--paper);border:1.5px solid var(--rule);\n    border-radius:10px;padding:.65rem .9rem;cursor:pointer}\n  button:hover{border-color:var(--dim)}\n  button:focus-visible,input:focus-visible{outline:2.5px solid var(--ochre);outline-offset:2px}\n  button[aria-pressed=\"true\"]{background:var(--ochre);border-color:var(--ochre);color:var(--ground)}\n  button[disabled]{opacity:.42;cursor:default}\n  .primary{background:var(--paper);color:var(--ground);border-color:var(--paper);width:100%;\n    padding:.85rem;font-size:1.0625rem;margin-top:.4rem}\n  .primary:hover{background:var(--ochre);border-color:var(--ochre)}\n  .ghost{border-color:transparent;color:var(--dim);font-size:.8125rem;padding:.4rem .5rem}\n  input{background:var(--lift);border:1.5px solid var(--rule);border-radius:10px;\n    color:var(--paper);padding:.7rem .8rem;width:100%}\n  input.code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.3em;\n    text-transform:uppercase;text-align:center;font-size:1.25rem}\n  label{display:block;font-family:ui-sans-serif,system-ui,sans-serif;font-size:.75rem;\n    letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin:0 0 .35rem}\n  .field{margin-bottom:.9rem}\n  .err{color:var(--fumble);font-size:.875rem;min-height:1.3em;margin:.5rem 0 0}\n\n  /* landing */\n  .choice{display:grid;gap:.75rem;margin-top:1.5rem}\n  .choice button{padding:1.1rem;text-align:left;border-radius:12px}\n  .choice b{display:block;font-size:1.0625rem;margin-bottom:.15rem}\n  .choice span{display:block;font-weight:400;font-family:ui-serif,Georgia,serif;\n    font-size:.9375rem;color:var(--dim)}\n\n  /* die */\n  .stage{width:100%;aspect-ratio:1;max-height:44vh;margin:.25rem auto}\n  canvas{width:100%;height:100%;display:block;cursor:pointer;touch-action:manipulation}\n  canvas:focus-visible{outline:2.5px solid var(--ochre);outline-offset:4px;border-radius:12px}\n  .total{font-family:ui-sans-serif,system-ui,sans-serif;font-weight:800;\n    font-size:clamp(2.25rem,12vw,3.5rem);line-height:1;letter-spacing:-.03em;\n    margin:.2rem 0;min-height:1em;text-align:center}\n  .total.crit{color:var(--crit)} .total.fumble{color:var(--fumble)}\n  .breakdown{font-size:.9375rem;color:var(--dim);text-align:center;min-height:1.4em;margin:0 0 1rem}\n  .breakdown .drop{color:var(--faint);text-decoration:line-through}\n\n  .banner{border:1.5px solid var(--rule);border-radius:10px;padding:.6rem .85rem;\n    text-align:center;font-size:.9375rem;color:var(--dim);margin-bottom:.9rem}\n  .banner.adv{border-color:var(--sage);color:var(--sage)}\n  .banner.dis{border-color:var(--fumble);color:var(--fumble)}\n\n  /* dm */\n  .roomcode{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:2rem;\n    letter-spacing:.24em;color:var(--ochre);margin:0}\n  .bar{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin:.85rem 0}\n  .seats{display:grid;gap:.75rem;grid-template-columns:repeat(auto-fill,minmax(16rem,1fr))}\n  .seat{background:var(--lift);border:1.5px solid var(--rule);border-radius:12px;padding:.85rem}\n  .seat.off{opacity:.62}\n  .seat header{display:flex;align-items:baseline;gap:.5rem;margin-bottom:.5rem}\n  .seat .nm{font-weight:700;font-family:ui-sans-serif,system-ui,sans-serif;font-size:1rem;flex:1;\n    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n  .seat .sc{font-family:ui-monospace,Menlo,monospace;font-size:.8125rem;color:var(--ochre);\n    letter-spacing:.12em}\n  .dot{width:.5rem;height:.5rem;border-radius:50%;background:var(--faint);flex:none}\n  .dot.on{background:var(--sage)}\n  .seat .res{font-family:ui-sans-serif,system-ui,sans-serif;font-weight:800;font-size:2rem;\n    line-height:1;margin:.35rem 0 .1rem}\n  .seat .res.crit{color:var(--crit)} .seat .res.fumble{color:var(--fumble)}\n  .seat .sub{font-size:.8125rem;color:var(--dim);min-height:1.2em}\n  .seg{display:flex;gap:.3rem;margin-top:.6rem}\n  .seg button{flex:1;padding:.42rem .2rem;font-size:.75rem;border-radius:8px}\n  .modrow{display:flex;gap:.3rem;align-items:center;margin-top:.45rem}\n  .modrow button{padding:.35rem .6rem;font-size:.9rem;border-radius:8px}\n  .modrow output{font-family:ui-sans-serif,system-ui,sans-serif;font-weight:700;font-size:.875rem;\n    min-width:2.4rem;text-align:center}\n  .modrow .sp{flex:1}\n\n  .log{margin-top:.5rem;border-top:1px solid var(--rule);max-height:15rem;overflow:auto}\n  .log div{display:flex;gap:.6rem;align-items:baseline;padding:.4rem 0;\n    border-bottom:1px solid rgba(84,66,76,.5);font-size:.9375rem}\n  .log .who{flex:1;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n  .log .tot{font-family:ui-sans-serif,system-ui,sans-serif;font-weight:800;min-width:2.2rem;\n    text-align:right}\n  .log .tot.crit{color:var(--crit)} .log .tot.fumble{color:var(--fumble)}\n  .log .det{color:var(--faint);font-size:.8125rem;min-width:7rem;text-align:right}\n\n  .chips{display:flex;flex-wrap:wrap;gap:.3rem;margin-top:.5rem}\n  .chips span{font-family:ui-sans-serif,system-ui,sans-serif;font-size:.8125rem;font-weight:700;\n    background:var(--lift);color:var(--dim);border-radius:6px;padding:.2rem .5rem}\n  .chips span.crit{color:var(--crit)} .chips span.fumble{color:var(--fumble)}\n\n  footer{color:var(--faint);font-size:.75rem;margin-top:1.75rem;line-height:1.6}\n  .status{font-size:.8125rem;color:var(--faint);margin-top:.75rem}\n  .status.bad{color:var(--fumble)}\n  @media (prefers-reduced-motion:reduce){*{transition:none!important}}\n</style>\n</head>\n<body>\n\n<!-- ============================================ landing -->\n<section class=\"screen on\" id=\"s-landing\">\n  <div class=\"wrap narrow\">\n    <h1>Dice Table</h1>\n    <p style=\"color:var(--dim);margin:0 0 .25rem\">\n      A shared d20 table. The DM sets advantage and sees every roll.\n      Players see only their own.\n    </p>\n    <div class=\"choice\">\n      <button type=\"button\" id=\"go-dm\">\n        <b>Start a table</b>\n        <span>You are the DM. You get a table code and a seat code for each player.</span>\n      </button>\n      <button type=\"button\" id=\"go-player\">\n        <b>Join a table</b>\n        <span>You have a table code and a seat code from your DM.</span>\n      </button>\n    </div>\n    <footer>\n      Rolls happen on the server using crypto.getRandomValues with rejection\n      sampling, so nobody at the table can influence or edit a result.\n    </footer>\n  </div>\n</section>\n\n<!-- ============================================ create -->\n<section class=\"screen\" id=\"s-create\">\n  <div class=\"wrap narrow\">\n    <h1>Start a table</h1>\n    <div class=\"field\">\n      <label for=\"seatcount\">How many players</label>\n      <input id=\"seatcount\" type=\"number\" min=\"1\" max=\"12\" value=\"4\" inputmode=\"numeric\">\n    </div>\n    <button type=\"button\" class=\"primary\" id=\"create\">Create table</button>\n    <p class=\"err\" id=\"create-err\"></p>\n    <button type=\"button\" class=\"ghost\" data-back>Back</button>\n  </div>\n</section>\n\n<!-- ============================================ join -->\n<section class=\"screen\" id=\"s-join\">\n  <div class=\"wrap narrow\">\n    <h1>Join a table</h1>\n    <div class=\"field\">\n      <label for=\"joincode\">Table code</label>\n      <input id=\"joincode\" class=\"code\" maxlength=\"5\" autocomplete=\"off\" autocapitalize=\"characters\" spellcheck=\"false\">\n    </div>\n    <div class=\"field\">\n      <label for=\"seatcode\">Your seat code</label>\n      <input id=\"seatcode\" class=\"code\" maxlength=\"4\" autocomplete=\"off\" autocapitalize=\"characters\" spellcheck=\"false\">\n    </div>\n    <button type=\"button\" class=\"primary\" id=\"join\">Take my seat</button>\n    <p class=\"err\" id=\"join-err\"></p>\n    <button type=\"button\" class=\"ghost\" data-back>Back</button>\n  </div>\n</section>\n\n<!-- ============================================ dm -->\n<section class=\"screen\" id=\"s-dm\">\n  <div class=\"wrap\">\n    <h1>Table</h1>\n    <p class=\"roomcode\" id=\"dm-code\">-----</p>\n    <p style=\"color:var(--dim);font-size:.9375rem;margin:.2rem 0 0\">\n      Give players the table code plus their own seat code.\n    </p>\n\n    <div class=\"bar\">\n      <label style=\"margin:0\">Seats</label>\n      <input id=\"dm-seats\" type=\"number\" min=\"1\" max=\"12\" style=\"width:5rem\" inputmode=\"numeric\">\n      <span class=\"sp\" style=\"flex:1\"></span>\n      <span style=\"font-size:.8125rem;color:var(--faint)\">Set all:</span>\n      <button type=\"button\" data-all=\"dis\">Disadv</button>\n      <button type=\"button\" data-all=\"norm\">Normal</button>\n      <button type=\"button\" data-all=\"adv\">Adv</button>\n    </div>\n\n    <div class=\"seats\" id=\"dm-seatgrid\"></div>\n\n    <h2>Your die</h2>\n    <div class=\"bar\">\n      <div class=\"seg\" style=\"max-width:18rem;margin:0\">\n        <button type=\"button\" data-dmmode=\"dis\" aria-pressed=\"false\">Disadv</button>\n        <button type=\"button\" data-dmmode=\"norm\" aria-pressed=\"true\">Normal</button>\n        <button type=\"button\" data-dmmode=\"adv\" aria-pressed=\"false\">Adv</button>\n      </div>\n      <button type=\"button\" id=\"dm-roll\">Roll</button>\n    </div>\n    <div class=\"chips\" id=\"dm-chips\"></div>\n\n    <h2>Every roll</h2>\n    <div class=\"log\" id=\"dm-log\"></div>\n    <button type=\"button\" class=\"ghost\" id=\"dm-clear\" style=\"margin-top:.6rem\">Clear all history</button>\n\n    <p class=\"status\" id=\"dm-status\"></p>\n    <footer>\n      Keep this tab open. The table lives as long as you hold the code, and the\n      DM link is stored in this browser only.\n    </footer>\n  </div>\n</section>\n\n<!-- ============================================ player -->\n<section class=\"screen\" id=\"s-player\">\n  <div class=\"wrap narrow\">\n    <h1 id=\"p-name\">Player</h1>\n    <div class=\"banner\" id=\"p-banner\">Normal roll</div>\n    <div class=\"stage\"><canvas id=\"die\" tabindex=\"0\" role=\"button\" aria-label=\"Roll your die\"></canvas></div>\n    <div class=\"total\" id=\"p-total\">&nbsp;</div>\n    <p class=\"breakdown\" id=\"p-break\">&nbsp;</p>\n    <button type=\"button\" class=\"primary\" id=\"p-roll\">Roll</button>\n    <div class=\"chips\" id=\"p-chips\"></div>\n    <div class=\"bar\" style=\"margin-top:1.5rem\">\n      <input id=\"p-rename\" maxlength=\"24\" placeholder=\"Change your name\" style=\"flex:1\">\n      <button type=\"button\" id=\"p-save\">Save</button>\n    </div>\n    <p class=\"status\" id=\"p-status\"></p>\n    <footer>\n      Advantage and disadvantage are set by your DM. Your rolls are sent to the\n      DM. You do not see anyone else's.\n    </footer>\n  </div>\n</section>\n\n<script>\n\"use strict\";\n\n/* ============================================================ screens */\n\nconst screens = {};\ndocument.querySelectorAll(\".screen\").forEach(s => screens[s.id.slice(2)] = s);\nfunction show(name) {\n  Object.values(screens).forEach(s => s.classList.remove(\"on\"));\n  screens[name].classList.add(\"on\");\n}\ndocument.querySelectorAll(\"[data-back]\").forEach(b =>\n  b.addEventListener(\"click\", () => show(\"landing\")));\ndocument.getElementById(\"go-dm\").addEventListener(\"click\", () => show(\"create\"));\ndocument.getElementById(\"go-player\").addEventListener(\"click\", () => show(\"join\"));\n\nconst $ = id => document.getElementById(id);\n\n/* ============================================================ die render\n   Same icosahedron as the single player roller: twelve golden-ratio\n   vertices, faces found by shortest-edge triples, numbered so opposite\n   faces sum to 21. The client only animates. It never decides a result. */\n\nconst PHI = (1 + Math.sqrt(5)) / 2;\nconst VERTS = [\n  [0,1,PHI],[0,1,-PHI],[0,-1,PHI],[0,-1,-PHI],\n  [1,PHI,0],[1,-PHI,0],[-1,PHI,0],[-1,-PHI,0],\n  [PHI,0,1],[PHI,0,-1],[-PHI,0,1],[-PHI,0,-1],\n].map(v => { const n = Math.hypot(...v); return v.map(x => x / n); });\n\nconst d2 = (a,b) => (a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2;\nlet minEdge = Infinity;\nfor (let i=0;i<12;i++) for (let j=i+1;j<12;j++) minEdge = Math.min(minEdge, d2(VERTS[i],VERTS[j]));\n\nconst FACES = [];\nfor (let i=0;i<12;i++) for (let j=i+1;j<12;j++) for (let k=j+1;k<12;k++) {\n  const near = x => Math.abs(x-minEdge) < 1e-6;\n  if (!near(d2(VERTS[i],VERTS[j])) || !near(d2(VERTS[j],VERTS[k])) || !near(d2(VERTS[i],VERTS[k]))) continue;\n  const a=VERTS[i], b=VERTS[j], c=VERTS[k];\n  const ab=[b[0]-a[0],b[1]-a[1],b[2]-a[2]], ac=[c[0]-a[0],c[1]-a[1],c[2]-a[2]];\n  const n=[ab[1]*ac[2]-ab[2]*ac[1], ab[2]*ac[0]-ab[0]*ac[2], ab[0]*ac[1]-ab[1]*ac[0]];\n  const cen=[(a[0]+b[0]+c[0])/3,(a[1]+b[1]+c[1])/3,(a[2]+b[2]+c[2])/3];\n  const out = n[0]*cen[0]+n[1]*cen[1]+n[2]*cen[2] > 0;\n  FACES.push({ idx: out ? [i,j,k] : [i,k,j], centroid: cen });\n}\n(function number() {\n  const taken = new Array(FACES.length).fill(false);\n  let n = 1;\n  for (let i=0;i<FACES.length;i++) {\n    if (taken[i]) continue;\n    let opp=-1, best=Infinity;\n    for (let j=0;j<FACES.length;j++) {\n      if (j===i||taken[j]) continue;\n      const c=FACES[j].centroid, o=FACES[i].centroid;\n      const dd=(c[0]+o[0])**2+(c[1]+o[1])**2+(c[2]+o[2])**2;\n      if (dd<best){best=dd;opp=j;}\n    }\n    FACES[i].value=n; FACES[opp].value=21-n; taken[i]=taken[opp]=true; n++;\n  }\n})();\nconst faceOf = v => FACES.find(f => f.value === v);\nconst unitNormal = f => { const c=f.centroid, n=Math.hypot(...c); return c.map(x=>x/n); };\n\nconst qMul=(a,b)=>[\n  a[0]*b[0]-a[1]*b[1]-a[2]*b[2]-a[3]*b[3],\n  a[0]*b[1]+a[1]*b[0]+a[2]*b[3]-a[3]*b[2],\n  a[0]*b[2]-a[1]*b[3]+a[2]*b[0]+a[3]*b[1],\n  a[0]*b[3]+a[1]*b[2]-a[2]*b[1]+a[3]*b[0]];\nfunction qAxis(ax,ang){const n=Math.hypot(...ax)||1,s=Math.sin(ang/2);\n  return [Math.cos(ang/2),ax[0]/n*s,ax[1]/n*s,ax[2]/n*s];}\nfunction qSlerp(a,b,t){\n  let dot=a[0]*b[0]+a[1]*b[1]+a[2]*b[2]+a[3]*b[3], bb=b.slice();\n  if(dot<0){dot=-dot;bb=bb.map(x=>-x);}\n  if(dot>0.9995){const r=a.map((x,i)=>x+(bb[i]-x)*t),n=Math.hypot(...r);return r.map(x=>x/n);}\n  const th=Math.acos(dot),s=Math.sin(th);\n  const wa=Math.sin((1-t)*th)/s, wb=Math.sin(t*th)/s;\n  return a.map((x,i)=>x*wa+bb[i]*wb);\n}\nfunction qRotate(q,v){const[w,x,y,z]=q;\n  const t=[2*(y*v[2]-z*v[1]),2*(z*v[0]-x*v[2]),2*(x*v[1]-y*v[0])];\n  return [v[0]+w*t[0]+(y*t[2]-z*t[1]),v[1]+w*t[1]+(z*t[0]-x*t[2]),v[2]+w*t[2]+(x*t[1]-y*t[0])];}\nfunction qFaceForward(f,spin){\n  const n=unitNormal(f), dot=n[2];\n  let q;\n  if(dot>0.99999) q=[1,0,0,0];\n  else if(dot<-0.99999) q=qAxis([1,0,0],Math.PI);\n  else q=qAxis([n[1], -n[0], 0], Math.acos(Math.max(-1,Math.min(1,dot))));  // n x +Z\n  return qMul(qAxis([0,0,1],spin),q);\n}\n\nconst canvas = $(\"die\"), ctx = canvas.getContext(\"2d\");\nlet cssSize = 300, orientation = qFaceForward(faceOf(20), 0);\nconst LIGHT = (() => { const v=[-0.42,-0.72,0.55], n=Math.hypot(...v); return v.map(x=>x/n); })();\n\nfunction resize(){\n  const r = canvas.getBoundingClientRect();\n  cssSize = Math.max(140, Math.min(r.width, r.height) || 260);\n  const dpr = Math.min(window.devicePixelRatio||1, 3);\n  canvas.width = Math.round(cssSize*dpr); canvas.height = Math.round(cssSize*dpr);\n  ctx.setTransform(dpr,0,0,dpr,0,0);\n  draw();\n}\nfunction draw(){\n  const S=cssSize, C=S/2, R=S*0.40;\n  ctx.clearRect(0,0,S,S);\n  const pts = VERTS.map(v => qRotate(orientation, v));\n  const faces = FACES.map(f => {\n    const a=pts[f.idx[0]], b=pts[f.idx[1]], c=pts[f.idx[2]];\n    const ab=[b[0]-a[0],b[1]-a[1],b[2]-a[2]], ac=[c[0]-a[0],c[1]-a[1],c[2]-a[2]];\n    let n=[ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0]];\n    const ln=Math.hypot(...n)||1; n=n.map(x=>x/ln);\n    const cen=[(a[0]+b[0]+c[0])/3,(a[1]+b[1]+c[1])/3,(a[2]+b[2]+c[2])/3];\n    return {f,a,b,c,n,cen,depth:cen[2]};\n  }).filter(o=>o.n[2]>0.015).sort((p,q)=>p.depth-q.depth);\n  const X=p=>C+p[0]*R, Y=p=>C-p[1]*R;\n  ctx.save(); ctx.globalAlpha=.28; ctx.fillStyle=\"#000\";\n  ctx.beginPath(); ctx.ellipse(C,C+R*1.02,R*0.72,R*0.13,0,0,Math.PI*2);\n  ctx.filter=\"blur(10px)\"; ctx.fill(); ctx.restore();\n  for (const o of faces){\n    const lam=Math.max(0,o.n[0]*LIGHT[0]+o.n[1]*LIGHT[1]+o.n[2]*LIGHT[2]);\n    const spec=Math.pow(Math.max(0,o.n[2]),14);\n    const l=20+lam*46+spec*16;\n    ctx.beginPath(); ctx.moveTo(X(o.a),Y(o.a)); ctx.lineTo(X(o.b),Y(o.b));\n    ctx.lineTo(X(o.c),Y(o.c)); ctx.closePath();\n    ctx.fillStyle=`hsl(30 24% ${l.toFixed(1)}%)`; ctx.fill();\n    ctx.lineWidth=Math.max(1,S*0.004);\n    ctx.strokeStyle=`hsl(32 30% ${Math.min(86,l+20).toFixed(1)}%)`; ctx.stroke();\n    const face=o.n[2];\n    if (face>0.30){\n      const size=S*0.115*(0.55+face*0.45);\n      ctx.save(); ctx.globalAlpha=Math.min(1,(face-0.30)/0.34);\n      ctx.translate(C+o.cen[0]*R, C-o.cen[1]*R);\n      ctx.font=`700 ${size}px ui-sans-serif, system-ui, sans-serif`;\n      ctx.textAlign=\"center\"; ctx.textBaseline=\"middle\";\n      const v=o.f.value, hot=(v===20||v===1);\n      ctx.fillStyle = hot && face>0.9 ? (v===20?\"#BFEFBF\":\"#F0A090\")\n        : `hsl(36 34% ${Math.min(94,l+42).toFixed(1)}%)`;\n      ctx.fillText(String(v),0,size*0.04);\n      if(v===6||v===9) ctx.fillRect(-size*0.22,size*0.44,size*0.44,Math.max(1.4,size*0.055));\n      ctx.restore();\n    }\n  }\n}\nconst REDUCED = window.matchMedia(\"(prefers-reduced-motion: reduce)\").matches;\nfunction animateTo(value, done){\n  const target = qFaceForward(faceOf(value), Math.random()*Math.PI*2);\n  if (REDUCED){ orientation=target; draw(); done(); return; }\n  const start=performance.now(), TUMBLE=560, SETTLE=820, TOTAL=TUMBLE+SETTLE;\n  const axis=[Math.random()-.5,Math.random()-.5,Math.random()-.5], from=orientation;\n  let atSettle=null;\n  (function frame(now){\n    const t=now-start;\n    if(t<TUMBLE){\n      orientation=qMul(qAxis(axis,(15-5*(t/TUMBLE))*(t/1000)),from); draw();\n      requestAnimationFrame(frame);\n    } else if(t<TOTAL){\n      if(!atSettle) atSettle=orientation;\n      const p=(t-TUMBLE)/SETTLE;\n      orientation=qSlerp(atSettle,target,1-Math.pow(1-p,3)); draw();\n      requestAnimationFrame(frame);\n    } else { orientation=target; draw(); done(); }\n  })(performance.now());\n}\n\n/* ============================================================ helpers */\n\nconst MODE_LABEL = { norm:\"Normal roll\", adv:\"Advantage\", dis:\"Disadvantage\" };\nconst cls = k => k===20 ? \"crit\" : k===1 ? \"fumble\" : \"\";\nfunction detail(r){\n  let s = r.dropped!=null\n    ? `${r.kept} / <span class=\"drop\">${r.dropped}</span>`\n    : `d20 ${r.kept}`;\n  if (r.mode!==\"norm\") s += r.mode===\"adv\" ? \" adv\" : \" dis\";\n  if (r.mod) s += ` ${r.mod>0?\"+\":\"\"}${r.mod}`;\n  return s;\n}\n\n/* ============================================================ socket */\n\nlet sock = null, role = null, myRoom = null, reconnectAt = 800;\n\nfunction connect(url, onMsg, statusEl){\n  function open(){\n    sock = new WebSocket(url);\n    sock.addEventListener(\"open\", () => {\n      reconnectAt = 800;\n      statusEl.textContent = \"Connected.\"; statusEl.classList.remove(\"bad\");\n    });\n    sock.addEventListener(\"message\", e => {\n      let m; try { m = JSON.parse(e.data); } catch { return; }\n      onMsg(m);\n    });\n    sock.addEventListener(\"close\", () => {\n      statusEl.textContent = \"Disconnected. Reconnecting...\";\n      statusEl.classList.add(\"bad\");\n      setTimeout(open, reconnectAt);\n      reconnectAt = Math.min(reconnectAt*1.8, 12000);\n    });\n    sock.addEventListener(\"error\", () => { try { sock.close(); } catch {} });\n  }\n  open();\n}\nconst send = o => { if (sock && sock.readyState === 1) sock.send(JSON.stringify(o)); };\nconst wsURL = q => (location.protocol === \"https:\" ? \"wss://\" : \"ws://\") + location.host + \"/ws?\" + q;\n\n/* ============================================================ create */\n\n$(\"create\").addEventListener(\"click\", async () => {\n  const btn = $(\"create\"); btn.disabled = true;\n  $(\"create-err\").textContent = \"\";\n  try {\n    const res = await fetch(\"/api/create\", {\n      method: \"POST\", headers: {\"content-type\":\"application/json\"},\n      body: JSON.stringify({ seats: Number($(\"seatcount\").value) || 4 }),\n    });\n    if (!res.ok) throw new Error();\n    const { code, dmToken } = await res.json();\n    localStorage.setItem(\"dice-dm-\" + code, dmToken);\n    startDM(code, dmToken);\n  } catch {\n    $(\"create-err\").textContent = \"Could not create the table. Try again.\";\n  } finally { btn.disabled = false; }\n});\n\n/* ============================================================ dm view */\n\nlet dmMode = \"norm\";\n\nfunction startDM(code, tok){\n  role = \"dm\"; myRoom = code;\n  history.replaceState(null, \"\", \"#dm=\" + code);\n  $(\"dm-code\").textContent = code;\n  show(\"dm\");\n  connect(wsURL(`code=${code}&role=dm&token=${encodeURIComponent(tok)}`),\n          renderDM, $(\"dm-status\"));\n}\n\nfunction renderDM(m){\n  if (m.t !== \"dm\") return;\n  const seatsInput = $(\"dm-seats\");\n  if (document.activeElement !== seatsInput) seatsInput.value = m.seats.length;\n\n  $(\"dm-seatgrid\").innerHTML = m.seats.map(s => {\n    const last = s.last;\n    return `<div class=\"seat ${s.connected ? \"\" : \"off\"}\">\n      <header>\n        <span class=\"dot ${s.connected ? \"on\" : \"\"}\" title=\"${s.connected ? \"connected\" : \"not connected\"}\"></span>\n        <span class=\"nm\">${escapeHTML(s.name)}</span>\n        <span class=\"sc\">${s.code}</span>\n      </header>\n      <div class=\"res ${last ? cls(last.kept) : \"\"}\">${last ? last.total : \"-\"}</div>\n      <div class=\"sub\">${last ? detail(last) : \"no rolls yet\"}</div>\n      <div class=\"seg\">\n        <button type=\"button\" data-mode=\"dis\" data-seat=\"${s.id}\" aria-pressed=\"${s.mode===\"dis\"}\">Disadv</button>\n        <button type=\"button\" data-mode=\"norm\" data-seat=\"${s.id}\" aria-pressed=\"${s.mode===\"norm\"}\">Normal</button>\n        <button type=\"button\" data-mode=\"adv\" data-seat=\"${s.id}\" aria-pressed=\"${s.mode===\"adv\"}\">Adv</button>\n      </div>\n      <div class=\"modrow\">\n        <button type=\"button\" data-mod=\"-1\" data-seat=\"${s.id}\" aria-label=\"Lower modifier\">-</button>\n        <output>${s.mod>=0?\"+\":\"\"}${s.mod}</output>\n        <button type=\"button\" data-mod=\"1\" data-seat=\"${s.id}\" aria-label=\"Raise modifier\">+</button>\n        <span class=\"sp\"></span>\n        <button type=\"button\" data-rollfor=\"${s.id}\">Roll for</button>\n      </div>\n    </div>`;\n  }).join(\"\");\n\n  $(\"dm-chips\").innerHTML = m.dmHistory.slice(0,14)\n    .map(r => `<span class=\"${cls(r.kept)}\">${r.total}</span>`).join(\"\");\n\n  $(\"dm-log\").innerHTML = m.log.length\n    ? m.log.map(r => `<div>\n        <span class=\"who\">${escapeHTML(r.name)}</span>\n        <span class=\"det\">${detail(r)}</span>\n        <span class=\"tot ${cls(r.kept)}\">${r.total}</span>\n      </div>`).join(\"\")\n    : `<div><span class=\"who\" style=\"color:var(--faint)\">Nothing rolled yet.</span></div>`;\n}\n\n$(\"dm-seatgrid\").addEventListener(\"click\", e => {\n  const b = e.target.closest(\"button\"); if (!b) return;\n  const seat = Number(b.dataset.seat);\n  if (b.dataset.mode) send({ t:\"mode\", seat, mode:b.dataset.mode });\n  else if (b.dataset.mod) {\n    const cur = Number(b.parentElement.querySelector(\"output\").textContent);\n    send({ t:\"mod\", seat, mod: cur + Number(b.dataset.mod) });\n  } else if (b.dataset.rollfor !== undefined) send({ t:\"rollFor\", seat:Number(b.dataset.rollfor) });\n});\ndocument.querySelectorAll(\"[data-all]\").forEach(b =>\n  b.addEventListener(\"click\", () => send({ t:\"modeAll\", mode:b.dataset.all })));\n$(\"dm-seats\").addEventListener(\"change\", e => send({ t:\"seats\", n:Number(e.target.value) }));\ndocument.querySelectorAll(\"[data-dmmode]\").forEach(b =>\n  b.addEventListener(\"click\", () => {\n    dmMode = b.dataset.dmmode;\n    document.querySelectorAll(\"[data-dmmode]\").forEach(o =>\n      o.setAttribute(\"aria-pressed\", String(o === b)));\n  }));\n$(\"dm-roll\").addEventListener(\"click\", () => send({ t:\"rollDM\", mode:dmMode, mod:0 }));\n$(\"dm-clear\").addEventListener(\"click\", () => {\n  if (confirm(\"Clear every roll on this table?\")) send({ t:\"clear\" });\n});\n\n/* ============================================================ join */\n\n$(\"join\").addEventListener(\"click\", async () => {\n  const btn = $(\"join\"); btn.disabled = true; $(\"join-err\").textContent = \"\";\n  const code = $(\"joincode\").value.trim().toUpperCase();\n  const seat = $(\"seatcode\").value.trim().toUpperCase();\n  try {\n    const res = await fetch(\"/api/seat\", {\n      method:\"POST\", headers:{\"content-type\":\"application/json\"},\n      body: JSON.stringify({ code, seat }),\n    });\n    const data = await res.json();\n    if (!data.ok) { $(\"join-err\").textContent = data.error || \"Could not join.\"; return; }\n    startPlayer(code, seat);\n  } catch {\n    $(\"join-err\").textContent = \"Could not reach the table.\";\n  } finally { btn.disabled = false; }\n});\n\n/* ============================================================ player view */\n\nlet pending = false, myMode = \"norm\";\n\nfunction startPlayer(code, seat){\n  role = \"player\"; myRoom = code;\n  history.replaceState(null, \"\", \"#p=\" + code + \".\" + seat);\n  show(\"player\");\n  resize();\n  connect(wsURL(`code=${code}&role=player&seat=${seat}`), renderPlayer, $(\"p-status\"));\n}\n\nfunction renderPlayer(m){\n  if (m.t !== \"me\") return;\n  const s = m.seat;\n  $(\"p-name\").textContent = s.name;\n  if (document.activeElement !== $(\"p-rename\")) $(\"p-rename\").value = s.name;\n\n  myMode = s.mode;\n  const b = $(\"p-banner\");\n  b.className = \"banner \" + (s.mode === \"norm\" ? \"\" : s.mode);\n  b.textContent = MODE_LABEL[s.mode] + (s.mod ? `, ${s.mod>0?\"+\":\"\"}${s.mod}` : \"\");\n\n  $(\"p-chips\").innerHTML = s.history.slice(0,14)\n    .map(r => `<span class=\"${cls(r.kept)}\">${r.total}</span>`).join(\"\");\n\n  const latest = s.history[0];\n  if (latest && pending) {\n    pending = false;\n    animateTo(latest.kept, () => {\n      $(\"p-total\").textContent = latest.total;\n      $(\"p-total\").className = \"total \" + cls(latest.kept);\n      $(\"p-break\").innerHTML = detail(latest);\n      $(\"p-roll\").disabled = false;\n    });\n  } else if (latest && $(\"p-total\").textContent.trim() === \"\") {\n    orientation = qFaceForward(faceOf(latest.kept), 0); draw();\n    $(\"p-total\").textContent = latest.total;\n    $(\"p-total\").className = \"total \" + cls(latest.kept);\n    $(\"p-break\").innerHTML = detail(latest);\n  }\n}\n\nfunction playerRoll(){\n  if (pending || !sock || sock.readyState !== 1) return;\n  pending = true;\n  $(\"p-roll\").disabled = true;\n  $(\"p-total\").textContent = \"\"; $(\"p-total\").className = \"total\";\n  $(\"p-break\").innerHTML = \"&nbsp;\";\n  send({ t:\"roll\" });\n}\n$(\"p-roll\").addEventListener(\"click\", playerRoll);\ncanvas.addEventListener(\"click\", playerRoll);\ncanvas.addEventListener(\"keydown\", e => {\n  if (e.key === \"Enter\" || e.key === \" \") { e.preventDefault(); playerRoll(); }\n});\n$(\"p-save\").addEventListener(\"click\", () => {\n  const v = $(\"p-rename\").value.trim();\n  if (v) send({ t:\"name\", name:v });\n});\n\n/* ============================================================ misc */\n\nfunction escapeHTML(s){\n  return String(s).replace(/[&<>\"']/g, c =>\n    ({ \"&\":\"&amp;\",\"<\":\"&lt;\",\">\":\"&gt;\",'\"':\"&quot;\",\"'\":\"&#39;\" }[c]));\n}\n\n[\"joincode\",\"seatcode\"].forEach(id =>\n  $(id).addEventListener(\"input\", e => e.target.value = e.target.value.toUpperCase()));\n\nwindow.addEventListener(\"resize\", resize);\nnew ResizeObserver(resize).observe(canvas);\n\n// Rejoin from the address bar if this browser already has a role here.\n(function restore(){\n  const h = location.hash;\n  let m;\n  if ((m = h.match(/^#dm=([A-Z2-9]{5})$/))) {\n    const tok = localStorage.getItem(\"dice-dm-\" + m[1]);\n    if (tok) { startDM(m[1], tok); return; }\n  }\n  if ((m = h.match(/^#p=([A-Z2-9]{5})\\.([A-Z2-9]{4})$/))) {\n    startPlayer(m[1], m[2]); return;\n  }\n})();\n</script>\n</body>\n</html>\n";
