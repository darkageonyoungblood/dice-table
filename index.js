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

const CLIENT_HTML = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Dice Table</title>
<meta name="description" content="A shared d20 table. The DM sees every roll, players see only their own.">
<style>
  :root{
    --ground:#2A1D24; --lift:#3A2A32; --lift2:#46333C;
    --paper:#F5F0E3; --dim:#C9BCA8; --faint:#8A7A80;
    --ochre:#E8B33C; --sage:#A8BC8C; --crit:#7FCF7F; --fumble:#D9604A;
    --rule:#54424C;
    box-sizing:border-box;
    padding-top:env(safe-area-inset-top,0px); padding-bottom:env(safe-area-inset-bottom,0px);
  }
  *{box-sizing:border-box}
  html{-webkit-text-size-adjust:100%}
  body{margin:0;background:var(--ground);color:var(--paper);
       font-family:ui-serif,Georgia,"Times New Roman",serif;line-height:1.5;min-height:100vh}
  .wrap{max-width:60rem;margin:0 auto;padding:1.25rem}
  .narrow{max-width:26rem}
  h1{font-family:ui-sans-serif,system-ui,sans-serif;font-weight:800;font-size:.8125rem;
     letter-spacing:.22em;text-transform:uppercase;color:var(--ochre);margin:0 0 1.25rem}
  h2{font-family:ui-sans-serif,system-ui,sans-serif;font-weight:700;font-size:.75rem;
     letter-spacing:.16em;text-transform:uppercase;color:var(--faint);margin:1.75rem 0 .65rem}
  .screen{display:none}
  .screen.on{display:block}

  button,input,select{font:inherit}
  button{font-family:ui-sans-serif,system-ui,sans-serif;font-weight:700;font-size:.9375rem;
    background:transparent;color:var(--paper);border:1.5px solid var(--rule);
    border-radius:10px;padding:.65rem .9rem;cursor:pointer}
  button:hover{border-color:var(--dim)}
  button:focus-visible,input:focus-visible{outline:2.5px solid var(--ochre);outline-offset:2px}
  button[aria-pressed="true"]{background:var(--ochre);border-color:var(--ochre);color:var(--ground)}
  button[disabled]{opacity:.42;cursor:default}
  .primary{background:var(--paper);color:var(--ground);border-color:var(--paper);width:100%;
    padding:.85rem;font-size:1.0625rem;margin-top:.4rem}
  .primary:hover{background:var(--ochre);border-color:var(--ochre)}
  .ghost{border-color:transparent;color:var(--dim);font-size:.8125rem;padding:.4rem .5rem}
  input{background:var(--lift);border:1.5px solid var(--rule);border-radius:10px;
    color:var(--paper);padding:.7rem .8rem;width:100%}
  input.code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.3em;
    text-transform:uppercase;text-align:center;font-size:1.25rem}
  label{display:block;font-family:ui-sans-serif,system-ui,sans-serif;font-size:.75rem;
    letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin:0 0 .35rem}
  .field{margin-bottom:.9rem}
  .err{color:var(--fumble);font-size:.875rem;min-height:1.3em;margin:.5rem 0 0}

  /* landing */
  .choice{display:grid;gap:.75rem;margin-top:1.5rem}
  .choice button{padding:1.1rem;text-align:left;border-radius:12px}
  .choice b{display:block;font-size:1.0625rem;margin-bottom:.15rem}
  .choice span{display:block;font-weight:400;font-family:ui-serif,Georgia,serif;
    font-size:.9375rem;color:var(--dim)}

  /* die */
  .stage{width:100%;aspect-ratio:1;max-height:44vh;margin:.25rem auto}
  canvas{width:100%;height:100%;display:block;cursor:pointer;touch-action:manipulation}
  canvas:focus-visible{outline:2.5px solid var(--ochre);outline-offset:4px;border-radius:12px}
  .total{font-family:ui-sans-serif,system-ui,sans-serif;font-weight:800;
    font-size:clamp(2.25rem,12vw,3.5rem);line-height:1;letter-spacing:-.03em;
    margin:.2rem 0;min-height:1em;text-align:center}
  .total.crit{color:var(--crit)} .total.fumble{color:var(--fumble)}
  .breakdown{font-size:.9375rem;color:var(--dim);text-align:center;min-height:1.4em;margin:0 0 1rem}
  .breakdown .drop{color:var(--faint);text-decoration:line-through}

  .banner{border:1.5px solid var(--rule);border-radius:10px;padding:.6rem .85rem;
    text-align:center;font-size:.9375rem;color:var(--dim);margin-bottom:.9rem}
  .banner.adv{border-color:var(--sage);color:var(--sage)}
  .banner.dis{border-color:var(--fumble);color:var(--fumble)}

  /* dm */
  .roomcode{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:2rem;
    letter-spacing:.24em;color:var(--ochre);margin:0}
  .bar{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin:.85rem 0}
  .seats{display:grid;gap:.75rem;grid-template-columns:repeat(auto-fill,minmax(16rem,1fr))}
  .seat{background:var(--lift);border:1.5px solid var(--rule);border-radius:12px;padding:.85rem}
  .seat.off{opacity:.62}
  .seat header{display:flex;align-items:baseline;gap:.5rem;margin-bottom:.5rem}
  .seat .nm{font-weight:700;font-family:ui-sans-serif,system-ui,sans-serif;font-size:1rem;flex:1;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .seat .sc{font-family:ui-monospace,Menlo,monospace;font-size:.8125rem;color:var(--ochre);
    letter-spacing:.12em}
  .dot{width:.5rem;height:.5rem;border-radius:50%;background:var(--faint);flex:none}
  .dot.on{background:var(--sage)}
  .seat .res{font-family:ui-sans-serif,system-ui,sans-serif;font-weight:800;font-size:2rem;
    line-height:1;margin:.35rem 0 .1rem}
  .seat .res.crit{color:var(--crit)} .seat .res.fumble{color:var(--fumble)}
  .seat .sub{font-size:.8125rem;color:var(--dim);min-height:1.2em}
  .seg{display:flex;gap:.3rem;margin-top:.6rem}
  .seg button{flex:1;padding:.42rem .2rem;font-size:.75rem;border-radius:8px}
  .modrow{display:flex;gap:.3rem;align-items:center;margin-top:.45rem}
  .modrow button{padding:.35rem .6rem;font-size:.9rem;border-radius:8px}
  .modrow output{font-family:ui-sans-serif,system-ui,sans-serif;font-weight:700;font-size:.875rem;
    min-width:2.4rem;text-align:center}
  .modrow .sp{flex:1}

  .log{margin-top:.5rem;border-top:1px solid var(--rule);max-height:15rem;overflow:auto}
  .log div{display:flex;gap:.6rem;align-items:baseline;padding:.4rem 0;
    border-bottom:1px solid rgba(84,66,76,.5);font-size:.9375rem}
  .log .who{flex:1;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .log .tot{font-family:ui-sans-serif,system-ui,sans-serif;font-weight:800;min-width:2.2rem;
    text-align:right}
  .log .tot.crit{color:var(--crit)} .log .tot.fumble{color:var(--fumble)}
  .log .det{color:var(--faint);font-size:.8125rem;min-width:7rem;text-align:right}

  .chips{display:flex;flex-wrap:wrap;gap:.3rem;margin-top:.5rem}
  .chips span{font-family:ui-sans-serif,system-ui,sans-serif;font-size:.8125rem;font-weight:700;
    background:var(--lift);color:var(--dim);border-radius:6px;padding:.2rem .5rem}
  .chips span.crit{color:var(--crit)} .chips span.fumble{color:var(--fumble)}

  footer{color:var(--faint);font-size:.75rem;margin-top:1.75rem;line-height:1.6}
  .status{font-size:.8125rem;color:var(--faint);margin-top:.75rem}
  .status.bad{color:var(--fumble)}
  @media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style>
</head>
<body>

<!-- ============================================ landing -->
<section class="screen on" id="s-landing">
  <div class="wrap narrow">
    <h1>Dice Table</h1>
    <p style="color:var(--dim);margin:0 0 .25rem">
      A shared d20 table. The DM sets advantage and sees every roll.
      Players see only their own.
    </p>
    <div class="choice">
      <button type="button" id="go-dm">
        <b>Start a table</b>
        <span>You are the DM. You get a table code and a seat code for each player.</span>
      </button>
      <button type="button" id="go-player">
        <b>Join a table</b>
        <span>You have a table code and a seat code from your DM.</span>
      </button>
    </div>
    <footer>
      Rolls happen on the server using crypto.getRandomValues with rejection
      sampling, so nobody at the table can influence or edit a result.
    </footer>
  </div>
</section>

<!-- ============================================ create -->
<section class="screen" id="s-create">
  <div class="wrap narrow">
    <h1>Start a table</h1>
    <div class="field">
      <label for="seatcount">How many players</label>
      <input id="seatcount" type="number" min="1" max="12" value="4" inputmode="numeric">
    </div>
    <button type="button" class="primary" id="create">Create table</button>
    <p class="err" id="create-err"></p>
    <button type="button" class="ghost" data-back>Back</button>
  </div>
</section>

<!-- ============================================ join -->
<section class="screen" id="s-join">
  <div class="wrap narrow">
    <h1>Join a table</h1>
    <div class="field">
      <label for="joincode">Table code</label>
      <input id="joincode" class="code" maxlength="5" autocomplete="off" autocapitalize="characters" spellcheck="false">
    </div>
    <div class="field">
      <label for="seatcode">Your seat code</label>
      <input id="seatcode" class="code" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false">
    </div>
    <button type="button" class="primary" id="join">Take my seat</button>
    <p class="err" id="join-err"></p>
    <button type="button" class="ghost" data-back>Back</button>
  </div>
</section>

<!-- ============================================ dm -->
<section class="screen" id="s-dm">
  <div class="wrap">
    <h1>Table</h1>
    <p class="roomcode" id="dm-code">-----</p>
    <p style="color:var(--dim);font-size:.9375rem;margin:.2rem 0 0">
      Give players the table code plus their own seat code.
    </p>

    <div class="bar">
      <label style="margin:0">Seats</label>
      <input id="dm-seats" type="number" min="1" max="12" style="width:5rem" inputmode="numeric">
      <span class="sp" style="flex:1"></span>
      <span style="font-size:.8125rem;color:var(--faint)">Set all:</span>
      <button type="button" data-all="dis">Disadv</button>
      <button type="button" data-all="norm">Normal</button>
      <button type="button" data-all="adv">Adv</button>
    </div>

    <div class="seats" id="dm-seatgrid"></div>

    <h2>Your die</h2>
    <div class="bar">
      <div class="seg" style="max-width:18rem;margin:0">
        <button type="button" data-dmmode="dis" aria-pressed="false">Disadv</button>
        <button type="button" data-dmmode="norm" aria-pressed="true">Normal</button>
        <button type="button" data-dmmode="adv" aria-pressed="false">Adv</button>
      </div>
      <button type="button" id="dm-roll">Roll</button>
    </div>
    <div class="chips" id="dm-chips"></div>

    <h2>Every roll</h2>
    <div class="log" id="dm-log"></div>
    <button type="button" class="ghost" id="dm-clear" style="margin-top:.6rem">Clear all history</button>

    <p class="status" id="dm-status"></p>
    <footer>
      Keep this tab open. The table lives as long as you hold the code, and the
      DM link is stored in this browser only.
    </footer>
  </div>
</section>

<!-- ============================================ player -->
<section class="screen" id="s-player">
  <div class="wrap narrow">
    <h1 id="p-name">Player</h1>
    <div class="banner" id="p-banner">Normal roll</div>
    <div class="stage"><canvas id="die" tabindex="0" role="button" aria-label="Roll your die"></canvas></div>
    <div class="total" id="p-total">&nbsp;</div>
    <p class="breakdown" id="p-break">&nbsp;</p>
    <button type="button" class="primary" id="p-roll">Roll</button>
    <div class="chips" id="p-chips"></div>
    <div class="bar" style="margin-top:1.5rem">
      <input id="p-rename" maxlength="24" placeholder="Change your name" style="flex:1">
      <button type="button" id="p-save">Save</button>
    </div>
    <p class="status" id="p-status"></p>
    <footer>
      Advantage and disadvantage are set by your DM. Your rolls are sent to the
      DM. You do not see anyone else's.
    </footer>
  </div>
</section>

<script>
"use strict";

/* ============================================================ screens */

const screens = {};
document.querySelectorAll(".screen").forEach(s => screens[s.id.slice(2)] = s);
function show(name) {
  Object.values(screens).forEach(s => s.classList.remove("on"));
  screens[name].classList.add("on");
}
document.querySelectorAll("[data-back]").forEach(b =>
  b.addEventListener("click", () => show("landing")));
document.getElementById("go-dm").addEventListener("click", () => show("create"));
document.getElementById("go-player").addEventListener("click", () => show("join"));

const $ = id => document.getElementById(id);

/* ============================================================ die render
   Same icosahedron as the single player roller: twelve golden-ratio
   vertices, faces found by shortest-edge triples, numbered so opposite
   faces sum to 21. The client only animates. It never decides a result. */

const PHI = (1 + Math.sqrt(5)) / 2;
const VERTS = [
  [0,1,PHI],[0,1,-PHI],[0,-1,PHI],[0,-1,-PHI],
  [1,PHI,0],[1,-PHI,0],[-1,PHI,0],[-1,-PHI,0],
  [PHI,0,1],[PHI,0,-1],[-PHI,0,1],[-PHI,0,-1],
].map(v => { const n = Math.hypot(...v); return v.map(x => x / n); });

const d2 = (a,b) => (a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2;
let minEdge = Infinity;
for (let i=0;i<12;i++) for (let j=i+1;j<12;j++) minEdge = Math.min(minEdge, d2(VERTS[i],VERTS[j]));

const FACES = [];
for (let i=0;i<12;i++) for (let j=i+1;j<12;j++) for (let k=j+1;k<12;k++) {
  const near = x => Math.abs(x-minEdge) < 1e-6;
  if (!near(d2(VERTS[i],VERTS[j])) || !near(d2(VERTS[j],VERTS[k])) || !near(d2(VERTS[i],VERTS[k]))) continue;
  const a=VERTS[i], b=VERTS[j], c=VERTS[k];
  const ab=[b[0]-a[0],b[1]-a[1],b[2]-a[2]], ac=[c[0]-a[0],c[1]-a[1],c[2]-a[2]];
  const n=[ab[1]*ac[2]-ab[2]*ac[1], ab[2]*ac[0]-ab[0]*ac[2], ab[0]*ac[1]-ab[1]*ac[0]];
  const cen=[(a[0]+b[0]+c[0])/3,(a[1]+b[1]+c[1])/3,(a[2]+b[2]+c[2])/3];
  const out = n[0]*cen[0]+n[1]*cen[1]+n[2]*cen[2] > 0;
  FACES.push({ idx: out ? [i,j,k] : [i,k,j], centroid: cen });
}
(function number() {
  const taken = new Array(FACES.length).fill(false);
  let n = 1;
  for (let i=0;i<FACES.length;i++) {
    if (taken[i]) continue;
    let opp=-1, best=Infinity;
    for (let j=0;j<FACES.length;j++) {
      if (j===i||taken[j]) continue;
      const c=FACES[j].centroid, o=FACES[i].centroid;
      const dd=(c[0]+o[0])**2+(c[1]+o[1])**2+(c[2]+o[2])**2;
      if (dd<best){best=dd;opp=j;}
    }
    FACES[i].value=n; FACES[opp].value=21-n; taken[i]=taken[opp]=true; n++;
  }
})();
const faceOf = v => FACES.find(f => f.value === v);
const unitNormal = f => { const c=f.centroid, n=Math.hypot(...c); return c.map(x=>x/n); };

const qMul=(a,b)=>[
  a[0]*b[0]-a[1]*b[1]-a[2]*b[2]-a[3]*b[3],
  a[0]*b[1]+a[1]*b[0]+a[2]*b[3]-a[3]*b[2],
  a[0]*b[2]-a[1]*b[3]+a[2]*b[0]+a[3]*b[1],
  a[0]*b[3]+a[1]*b[2]-a[2]*b[1]+a[3]*b[0]];
function qAxis(ax,ang){const n=Math.hypot(...ax)||1,s=Math.sin(ang/2);
  return [Math.cos(ang/2),ax[0]/n*s,ax[1]/n*s,ax[2]/n*s];}
function qSlerp(a,b,t){
  let dot=a[0]*b[0]+a[1]*b[1]+a[2]*b[2]+a[3]*b[3], bb=b.slice();
  if(dot<0){dot=-dot;bb=bb.map(x=>-x);}
  if(dot>0.9995){const r=a.map((x,i)=>x+(bb[i]-x)*t),n=Math.hypot(...r);return r.map(x=>x/n);}
  const th=Math.acos(dot),s=Math.sin(th);
  const wa=Math.sin((1-t)*th)/s, wb=Math.sin(t*th)/s;
  return a.map((x,i)=>x*wa+bb[i]*wb);
}
function qRotate(q,v){const[w,x,y,z]=q;
  const t=[2*(y*v[2]-z*v[1]),2*(z*v[0]-x*v[2]),2*(x*v[1]-y*v[0])];
  return [v[0]+w*t[0]+(y*t[2]-z*t[1]),v[1]+w*t[1]+(z*t[0]-x*t[2]),v[2]+w*t[2]+(x*t[1]-y*t[0])];}
function qFaceForward(f,spin){
  const n=unitNormal(f), dot=n[2];
  let q;
  if(dot>0.99999) q=[1,0,0,0];
  else if(dot<-0.99999) q=qAxis([1,0,0],Math.PI);
  else q=qAxis([n[1], -n[0], 0], Math.acos(Math.max(-1,Math.min(1,dot))));  // n x +Z
  return qMul(qAxis([0,0,1],spin),q);
}

const canvas = $("die"), ctx = canvas.getContext("2d");
let cssSize = 300, orientation = qFaceForward(faceOf(20), 0);
const LIGHT = (() => { const v=[-0.42,-0.72,0.55], n=Math.hypot(...v); return v.map(x=>x/n); })();

function resize(){
  const r = canvas.getBoundingClientRect();
  cssSize = Math.max(140, Math.min(r.width, r.height) || 260);
  const dpr = Math.min(window.devicePixelRatio||1, 3);
  canvas.width = Math.round(cssSize*dpr); canvas.height = Math.round(cssSize*dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);
  draw();
}
function draw(){
  const S=cssSize, C=S/2, R=S*0.40;
  ctx.clearRect(0,0,S,S);
  const pts = VERTS.map(v => qRotate(orientation, v));
  const faces = FACES.map(f => {
    const a=pts[f.idx[0]], b=pts[f.idx[1]], c=pts[f.idx[2]];
    const ab=[b[0]-a[0],b[1]-a[1],b[2]-a[2]], ac=[c[0]-a[0],c[1]-a[1],c[2]-a[2]];
    let n=[ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0]];
    const ln=Math.hypot(...n)||1; n=n.map(x=>x/ln);
    const cen=[(a[0]+b[0]+c[0])/3,(a[1]+b[1]+c[1])/3,(a[2]+b[2]+c[2])/3];
    return {f,a,b,c,n,cen,depth:cen[2]};
  }).filter(o=>o.n[2]>0.015).sort((p,q)=>p.depth-q.depth);
  const X=p=>C+p[0]*R, Y=p=>C-p[1]*R;
  ctx.save(); ctx.globalAlpha=.28; ctx.fillStyle="#000";
  ctx.beginPath(); ctx.ellipse(C,C+R*1.02,R*0.72,R*0.13,0,0,Math.PI*2);
  ctx.filter="blur(10px)"; ctx.fill(); ctx.restore();
  for (const o of faces){
    const lam=Math.max(0,o.n[0]*LIGHT[0]+o.n[1]*LIGHT[1]+o.n[2]*LIGHT[2]);
    const spec=Math.pow(Math.max(0,o.n[2]),14);
    const l=20+lam*46+spec*16;
    ctx.beginPath(); ctx.moveTo(X(o.a),Y(o.a)); ctx.lineTo(X(o.b),Y(o.b));
    ctx.lineTo(X(o.c),Y(o.c)); ctx.closePath();
    ctx.fillStyle=\`hsl(30 24% \${l.toFixed(1)}%)\`; ctx.fill();
    ctx.lineWidth=Math.max(1,S*0.004);
    ctx.strokeStyle=\`hsl(32 30% \${Math.min(86,l+20).toFixed(1)}%)\`; ctx.stroke();
    const face=o.n[2];
    if (face>0.30){
      const size=S*0.115*(0.55+face*0.45);
      ctx.save(); ctx.globalAlpha=Math.min(1,(face-0.30)/0.34);
      ctx.translate(C+o.cen[0]*R, C-o.cen[1]*R);
      ctx.font=\`700 \${size}px ui-sans-serif, system-ui, sans-serif\`;
      ctx.textAlign="center"; ctx.textBaseline="middle";
      const v=o.f.value, hot=(v===20||v===1);
      ctx.fillStyle = hot && face>0.9 ? (v===20?"#BFEFBF":"#F0A090")
        : \`hsl(36 34% \${Math.min(94,l+42).toFixed(1)}%)\`;
      ctx.fillText(String(v),0,size*0.04);
      if(v===6||v===9) ctx.fillRect(-size*0.22,size*0.44,size*0.44,Math.max(1.4,size*0.055));
      ctx.restore();
    }
  }
}
const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
function animateTo(value, done){
  const target = qFaceForward(faceOf(value), Math.random()*Math.PI*2);
  if (REDUCED){ orientation=target; draw(); done(); return; }
  const start=performance.now(), TUMBLE=560, SETTLE=820, TOTAL=TUMBLE+SETTLE;
  const axis=[Math.random()-.5,Math.random()-.5,Math.random()-.5], from=orientation;
  let atSettle=null;
  (function frame(now){
    const t=now-start;
    if(t<TUMBLE){
      orientation=qMul(qAxis(axis,(15-5*(t/TUMBLE))*(t/1000)),from); draw();
      requestAnimationFrame(frame);
    } else if(t<TOTAL){
      if(!atSettle) atSettle=orientation;
      const p=(t-TUMBLE)/SETTLE;
      orientation=qSlerp(atSettle,target,1-Math.pow(1-p,3)); draw();
      requestAnimationFrame(frame);
    } else { orientation=target; draw(); done(); }
  })(performance.now());
}

/* ============================================================ helpers */

const MODE_LABEL = { norm:"Normal roll", adv:"Advantage", dis:"Disadvantage" };
const cls = k => k===20 ? "crit" : k===1 ? "fumble" : "";
function detail(r){
  let s = r.dropped!=null
    ? \`\${r.kept} / <span class="drop">\${r.dropped}</span>\`
    : \`d20 \${r.kept}\`;
  if (r.mode!=="norm") s += r.mode==="adv" ? " adv" : " dis";
  if (r.mod) s += \` \${r.mod>0?"+":""}\${r.mod}\`;
  return s;
}

/* ============================================================ socket */

let sock = null, role = null, myRoom = null, reconnectAt = 800;

function connect(url, onMsg, statusEl){
  function open(){
    sock = new WebSocket(url);
    sock.addEventListener("open", () => {
      reconnectAt = 800;
      statusEl.textContent = "Connected."; statusEl.classList.remove("bad");
    });
    sock.addEventListener("message", e => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      onMsg(m);
    });
    sock.addEventListener("close", () => {
      statusEl.textContent = "Disconnected. Reconnecting...";
      statusEl.classList.add("bad");
      setTimeout(open, reconnectAt);
      reconnectAt = Math.min(reconnectAt*1.8, 12000);
    });
    sock.addEventListener("error", () => { try { sock.close(); } catch {} });
  }
  open();
}
const send = o => { if (sock && sock.readyState === 1) sock.send(JSON.stringify(o)); };
const wsURL = q => (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws?" + q;

/* ============================================================ create */

$("create").addEventListener("click", async () => {
  const btn = $("create"); btn.disabled = true;
  $("create-err").textContent = "";
  try {
    const res = await fetch("/api/create", {
      method: "POST", headers: {"content-type":"application/json"},
      body: JSON.stringify({ seats: Number($("seatcount").value) || 4 }),
    });
    if (!res.ok) throw new Error();
    const { code, dmToken } = await res.json();
    localStorage.setItem("dice-dm-" + code, dmToken);
    startDM(code, dmToken);
  } catch {
    $("create-err").textContent = "Could not create the table. Try again.";
  } finally { btn.disabled = false; }
});

/* ============================================================ dm view */

let dmMode = "norm";

function startDM(code, tok){
  role = "dm"; myRoom = code;
  history.replaceState(null, "", "#dm=" + code);
  $("dm-code").textContent = code;
  show("dm");
  connect(wsURL(\`code=\${code}&role=dm&token=\${encodeURIComponent(tok)}\`),
          renderDM, $("dm-status"));
}

function renderDM(m){
  if (m.t !== "dm") return;
  const seatsInput = $("dm-seats");
  if (document.activeElement !== seatsInput) seatsInput.value = m.seats.length;

  $("dm-seatgrid").innerHTML = m.seats.map(s => {
    const last = s.last;
    return \`<div class="seat \${s.connected ? "" : "off"}">
      <header>
        <span class="dot \${s.connected ? "on" : ""}" title="\${s.connected ? "connected" : "not connected"}"></span>
        <span class="nm">\${escapeHTML(s.name)}</span>
        <span class="sc">\${s.code}</span>
      </header>
      <div class="res \${last ? cls(last.kept) : ""}">\${last ? last.total : "-"}</div>
      <div class="sub">\${last ? detail(last) : "no rolls yet"}</div>
      <div class="seg">
        <button type="button" data-mode="dis" data-seat="\${s.id}" aria-pressed="\${s.mode==="dis"}">Disadv</button>
        <button type="button" data-mode="norm" data-seat="\${s.id}" aria-pressed="\${s.mode==="norm"}">Normal</button>
        <button type="button" data-mode="adv" data-seat="\${s.id}" aria-pressed="\${s.mode==="adv"}">Adv</button>
      </div>
      <div class="modrow">
        <button type="button" data-mod="-1" data-seat="\${s.id}" aria-label="Lower modifier">-</button>
        <output>\${s.mod>=0?"+":""}\${s.mod}</output>
        <button type="button" data-mod="1" data-seat="\${s.id}" aria-label="Raise modifier">+</button>
        <span class="sp"></span>
        <button type="button" data-rollfor="\${s.id}">Roll for</button>
      </div>
    </div>\`;
  }).join("");

  $("dm-chips").innerHTML = m.dmHistory.slice(0,14)
    .map(r => \`<span class="\${cls(r.kept)}">\${r.total}</span>\`).join("");

  $("dm-log").innerHTML = m.log.length
    ? m.log.map(r => \`<div>
        <span class="who">\${escapeHTML(r.name)}</span>
        <span class="det">\${detail(r)}</span>
        <span class="tot \${cls(r.kept)}">\${r.total}</span>
      </div>\`).join("")
    : \`<div><span class="who" style="color:var(--faint)">Nothing rolled yet.</span></div>\`;
}

$("dm-seatgrid").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  const seat = Number(b.dataset.seat);
  if (b.dataset.mode) send({ t:"mode", seat, mode:b.dataset.mode });
  else if (b.dataset.mod) {
    const cur = Number(b.parentElement.querySelector("output").textContent);
    send({ t:"mod", seat, mod: cur + Number(b.dataset.mod) });
  } else if (b.dataset.rollfor !== undefined) send({ t:"rollFor", seat:Number(b.dataset.rollfor) });
});
document.querySelectorAll("[data-all]").forEach(b =>
  b.addEventListener("click", () => send({ t:"modeAll", mode:b.dataset.all })));
$("dm-seats").addEventListener("change", e => send({ t:"seats", n:Number(e.target.value) }));
document.querySelectorAll("[data-dmmode]").forEach(b =>
  b.addEventListener("click", () => {
    dmMode = b.dataset.dmmode;
    document.querySelectorAll("[data-dmmode]").forEach(o =>
      o.setAttribute("aria-pressed", String(o === b)));
  }));
$("dm-roll").addEventListener("click", () => send({ t:"rollDM", mode:dmMode, mod:0 }));
$("dm-clear").addEventListener("click", () => {
  if (confirm("Clear every roll on this table?")) send({ t:"clear" });
});

/* ============================================================ join */

$("join").addEventListener("click", async () => {
  const btn = $("join"); btn.disabled = true; $("join-err").textContent = "";
  const code = $("joincode").value.trim().toUpperCase();
  const seat = $("seatcode").value.trim().toUpperCase();
  try {
    const res = await fetch("/api/seat", {
      method:"POST", headers:{"content-type":"application/json"},
      body: JSON.stringify({ code, seat }),
    });
    const data = await res.json();
    if (!data.ok) { $("join-err").textContent = data.error || "Could not join."; return; }
    startPlayer(code, seat);
  } catch {
    $("join-err").textContent = "Could not reach the table.";
  } finally { btn.disabled = false; }
});

/* ============================================================ player view */

let pending = false, myMode = "norm";

function startPlayer(code, seat){
  role = "player"; myRoom = code;
  history.replaceState(null, "", "#p=" + code + "." + seat);
  show("player");
  resize();
  connect(wsURL(\`code=\${code}&role=player&seat=\${seat}\`), renderPlayer, $("p-status"));
}

function renderPlayer(m){
  if (m.t !== "me") return;
  const s = m.seat;
  $("p-name").textContent = s.name;
  if (document.activeElement !== $("p-rename")) $("p-rename").value = s.name;

  myMode = s.mode;
  const b = $("p-banner");
  b.className = "banner " + (s.mode === "norm" ? "" : s.mode);
  b.textContent = MODE_LABEL[s.mode] + (s.mod ? \`, \${s.mod>0?"+":""}\${s.mod}\` : "");

  $("p-chips").innerHTML = s.history.slice(0,14)
    .map(r => \`<span class="\${cls(r.kept)}">\${r.total}</span>\`).join("");

  const latest = s.history[0];
  if (latest && pending) {
    pending = false;
    animateTo(latest.kept, () => {
      $("p-total").textContent = latest.total;
      $("p-total").className = "total " + cls(latest.kept);
      $("p-break").innerHTML = detail(latest);
      $("p-roll").disabled = false;
    });
  } else if (latest && $("p-total").textContent.trim() === "") {
    orientation = qFaceForward(faceOf(latest.kept), 0); draw();
    $("p-total").textContent = latest.total;
    $("p-total").className = "total " + cls(latest.kept);
    $("p-break").innerHTML = detail(latest);
  }
}

function playerRoll(){
  if (pending || !sock || sock.readyState !== 1) return;
  pending = true;
  $("p-roll").disabled = true;
  $("p-total").textContent = ""; $("p-total").className = "total";
  $("p-break").innerHTML = "&nbsp;";
  send({ t:"roll" });
}
$("p-roll").addEventListener("click", playerRoll);
canvas.addEventListener("click", playerRoll);
canvas.addEventListener("keydown", e => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); playerRoll(); }
});
$("p-save").addEventListener("click", () => {
  const v = $("p-rename").value.trim();
  if (v) send({ t:"name", name:v });
});

/* ============================================================ misc */

function escapeHTML(s){
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

["joincode","seatcode"].forEach(id =>
  $(id).addEventListener("input", e => e.target.value = e.target.value.toUpperCase()));

window.addEventListener("resize", resize);
new ResizeObserver(resize).observe(canvas);

// Rejoin from the address bar if this browser already has a role here.
(function restore(){
  const h = location.hash;
  let m;
  if ((m = h.match(/^#dm=([A-Z2-9]{5})$/))) {
    const tok = localStorage.getItem("dice-dm-" + m[1]);
    if (tok) { startDM(m[1], tok); return; }
  }
  if ((m = h.match(/^#p=([A-Z2-9]{5})\\.([A-Z2-9]{4})$/))) {
    startPlayer(m[1], m[2]); return;
  }
})();
</script>
</body>
</html>
`;
