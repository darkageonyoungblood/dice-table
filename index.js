/**
 * Dice table. Worker + Durable Object.
 *
 * This tool contains no AI. Nothing is generated, predicted or suggested.
 * Dice are rolled from cryptographic randomness and the numbers are sent out.
 *
 * The server exists for enforcement. Two things cannot be done in a browser:
 *
 *   1. Rolling. Dice are rolled inside the Durable Object, so a player cannot
 *      edit a result on the way back. Clients only animate a given number.
 *
 *   2. Visibility. A player socket is never sent another player's result,
 *      sheet, or a hidden monster. Hiding things with CSS is not hiding them.
 */
import { DurableObject } from "cloudflare:workers";

/* ------------------------------------------------------------ randomness */

// 2^32 is not divisible by most die sizes, so a raw modulo would favour the
// low faces. Discard draws landing in the short tail instead.
function rollDie(sides) {
  const limit = Math.floor(0x100000000 / sides) * sides;
  const buf = new Uint32Array(1);
  let v;
  do {
    crypto.getRandomValues(buf);
    v = buf[0];
  } while (v >= limit);
  return (v % sides) + 1;
}

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

function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ------------------------------------------------------------ rules data */

// Not exported. Cloudflare treats every named export of the entry module as an
// entrypoint or Durable Object class, so only Table and the default handler are
// exported. Plain data exported here fails deploy validation.
const DICE = [4, 6, 8, 10, 12, 20, 100];

// 5th edition conditions, with the short version a DM actually needs mid-turn.
const CONDITIONS = {
  blinded:       { name: "Blinded",       text: "Cannot see, auto-fails sight checks. Attacks against it have advantage, its attacks have disadvantage." },
  charmed:       { name: "Charmed",       text: "Cannot attack the charmer. The charmer has advantage on social checks with it." },
  deafened:      { name: "Deafened",      text: "Cannot hear, auto-fails hearing checks." },
  frightened:    { name: "Frightened",    text: "Disadvantage on checks and attacks while the source is in sight. Cannot willingly move closer." },
  grappled:      { name: "Grappled",      text: "Speed 0, no bonus to speed. Ends if the grappler is incapacitated." },
  incapacitated: { name: "Incapacitated", text: "No actions and no reactions." },
  invisible:     { name: "Invisible",     text: "Unseen without special senses. Attacks against it have disadvantage, its attacks have advantage." },
  paralyzed:     { name: "Paralyzed",     text: "Incapacitated, cannot move or speak. Auto-fails STR and DEX saves. Attacks have advantage, hits within 5 feet are critical." },
  petrified:     { name: "Petrified",     text: "Turned to stone. Incapacitated, resistance to all damage, immune to poison and disease." },
  poisoned:      { name: "Poisoned",      text: "Disadvantage on attack rolls and ability checks." },
  prone:         { name: "Prone",         text: "Can only crawl. Disadvantage on attacks. Attacks within 5 feet have advantage, ranged have disadvantage." },
  restrained:    { name: "Restrained",    text: "Speed 0. Attacks against it have advantage, its attacks have disadvantage, disadvantage on DEX saves." },
  stunned:       { name: "Stunned",       text: "Incapacitated, cannot move, speaks haltingly. Auto-fails STR and DEX saves. Attacks have advantage." },
  unconscious:   { name: "Unconscious",   text: "Incapacitated, drops what it holds, falls prone. Auto-fails STR and DEX saves. Hits within 5 feet are critical." },
};

// Exhaustion, cumulative: each level includes every level below it.
const EXHAUSTION = [
  "",
  "1. Disadvantage on ability checks.",
  "2. Speed halved.",
  "3. Disadvantage on attack rolls and saving throws.",
  "4. Hit point maximum halved.",
  "5. Speed reduced to 0.",
  "6. Death.",
];

const DEFAULT_STATS = ["STR", "DEX", "CON", "INT", "WIS", "CHA"];

// Every optional system, switched on or off by the DM when the table is made
// and changeable afterwards in Setup. Off means the controls disappear from
// both screens; the data stays put so switching back loses nothing.
const FEATURES = {
  initiative:    "Initiative and turn order",
  monsters:      "Monsters and NPCs",
  hp:            "Hit points",
  tempHp:        "Temporary hit points",
  ac:            "Armor class",
  conditions:    "Conditions",
  exhaustion:    "Exhaustion",
  concentration: "Concentration",
  deathSaves:    "Death saves",
  requests:      "Asking players to roll",
  secretRolls:   "Secret rolls",
  stats:         "Ability scores",
  attacks:       "Attack bonuses",
  advantage:     "Advantage and disadvantage",
  modifiers:     "Flat roll modifiers",
  otherDice:     "Dice other than d20",
  multiDice:     "Rolling several dice at once",
};

const allFeatures = () => Object.fromEntries(Object.keys(FEATURES).map(k => [k, true]));

function cleanFeatures(input, base) {
  const out = base ? { ...base } : allFeatures();
  if (input && typeof input === "object") {
    for (const k of Object.keys(FEATURES)) if (k in input) out[k] = !!input[k];
  }
  return out;
}

const MAX_SEATS = 12;
const MAX_ACTORS = 60;
const MAX_LOG = 200;
const MAX_HISTORY = 40;

/* ------------------------------------------------------------ helpers */

function clampStat(v, max = 999) {
  if (v === null || v === "" || v === undefined) return null;
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(max, n));
}

function clampSigned(v, lim = 99) {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return 0;
  return Math.max(-lim, Math.min(lim, n));
}

function clampSeats(n) {
  n = Math.trunc(Number(n) || 4);
  return Math.max(1, Math.min(MAX_SEATS, n));
}

function cleanText(v, len = 40) {
  return typeof v === "string" ? v.slice(0, len).trim() : "";
}

/* ------------------------------------------------------------ durable object */

export class Table extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.room = null;
    ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get("room")) || null;
      if (this.room) this.migrate();
    });
  }

  // Older tables keep working when the shape grows.
  migrate() {
    const r = this.room;
    r.config ||= { stats: [...DEFAULT_STATS], statMode: "5e", initStat: "DEX" };
    r.config.stats ||= [...DEFAULT_STATS];
    r.config.statMode ||= "5e";
    r.config.features = cleanFeatures(r.config.features, allFeatures());
    r.actors ||= [];
    r.initiative ||= { active: false, round: 0, turn: 0, order: [] };
    r.requests ||= {};
    r.secretLog ||= [];
    r.nextActorId ||= 1;
    for (const s of r.seats) this.fillCombatant(s);
  }

  fillCombatant(c) {
    c.hpMax ??= null;
    c.hpCur ??= null;
    c.tempHp ??= 0;
    c.ac ??= null;
    c.conditions ||= [];
    c.exhaustion ??= 0;
    c.concentration ||= { on: false, note: "" };
    c.deathSaves ||= { active: false, s: 0, f: 0 };
    c.initiative ??= null;
    c.stats ||= {};
    c.atk ||= { melee: 0, ranged: 0, spell: 0 };
    return c;
  }

  save() {
    return this.ctx.storage.put("room", this.room);
  }

  newSeat(i) {
    return this.fillCombatant({
      id: i,
      code: code(4),
      name: `Player ${i + 1}`,
      mode: "norm",
      mod: 0,
      sheetLocked: false,
      history: [],
    });
  }

  newActor(name, hp, ac, hidden) {
    return this.fillCombatant({
      id: this.room.nextActorId++,
      name: cleanText(name, 40) || "Creature",
      hpMax: clampStat(hp),
      hpCur: clampStat(hp),
      ac: clampStat(ac, 99),
      hidden: hidden !== false,
      history: [],
    });
  }

  /* ---------------------------------------------------------- lifecycle */

  async create(roomCode, seats, features) {
    this.room = {
      code: roomCode,
      dmToken: token(),
      created: Date.now(),
      config: {
        stats: [...DEFAULT_STATS], statMode: "5e", initStat: "DEX",
        features: cleanFeatures(features),
      },
      seats: [],
      actors: [],
      nextActorId: 1,
      initiative: { active: false, round: 0, turn: 0, order: [] },
      requests: {},
      dmHistory: [],
      log: [],
      secretLog: [],
    };
    this.room.seats = Array.from({ length: clampSeats(seats) }, (_, i) => this.newSeat(i));
    await this.save();
    return { code: this.room.code, dmToken: this.room.dmToken };
  }

  async exists() { return !!this.room; }

  async checkSeat(seatCode) {
    if (!this.room) return { ok: false, error: "That table does not exist." };
    const seat = this.room.seats.find(s => s.code === String(seatCode || "").toUpperCase());
    if (!seat) return { ok: false, error: "That seat code is not on this table." };
    return { ok: true, seat: seat.id, name: seat.name };
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (!this.room) return new Response("No such table", { status: 404 });

    const role = url.searchParams.get("role");
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

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [who.role === "dm" ? "dm" : `seat:${who.seat}`]);
    server.serializeAttachment(who);
    this.push(server, who);
    if (who.role === "player") this.pushDM();
    return new Response(null, { status: 101, webSocket: client });
  }

  /* ---------------------------------------------------------- stats */

  // System neutral: the DM picks how a raw stat becomes a modifier.
  modFor(c, statName) {
    if (!statName) return 0;
    const raw = c.stats ? c.stats[statName] : null;
    if (raw === null || raw === undefined || raw === "") return 0;
    const n = Number(raw);
    if (!Number.isFinite(n)) return 0;
    return this.room.config.statMode === "raw"
      ? Math.trunc(n)
      : Math.floor((Math.trunc(n) - 10) / 2);
  }

  bonusFor(c, source) {
    if (!source) return 0;
    if (source === "melee" || source === "ranged" || source === "spell") {
      return clampSigned(c.atk ? c.atk[source] : 0);
    }
    return this.modFor(c, source);
  }

  find(kind, id) {
    return kind === "actor"
      ? this.room.actors.find(a => a.id === id)
      : this.room.seats[id];
  }

  /* ---------------------------------------------------------- projections */

  publicCombatant(c, kind) {
    return {
      kind, id: c.id, name: c.name,
      hpMax: c.hpMax, hpCur: c.hpCur, tempHp: c.tempHp, ac: c.ac,
      conditions: c.conditions, exhaustion: c.exhaustion,
      concentration: c.concentration, deathSaves: c.deathSaves,
      initiative: c.initiative,
    };
  }

  dmView() {
    const connected = new Set();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a && a.role === "player") connected.add(a.seat);
    }
    return {
      t: "dm",
      code: this.room.code,
      config: this.room.config,
      conditions: CONDITIONS,
      exhaustion: EXHAUSTION,
      featureList: FEATURES,
      seats: this.room.seats.map(s => ({
        ...this.publicCombatant(s, "seat"),
        code: s.code, mode: s.mode, mod: s.mod,
        sheetLocked: s.sheetLocked, stats: s.stats, atk: s.atk,
        connected: connected.has(s.id),
        last: s.history[0] || null,
        request: this.room.requests[s.id] || null,
      })),
      actors: this.room.actors.map(a => ({
        ...this.publicCombatant(a, "actor"),
        hidden: a.hidden, last: a.history[0] || null,
      })),
      initiative: this.room.initiative,
      dmHistory: this.room.dmHistory,
      log: this.room.log,
      secretLog: this.room.secretLog,
    };
  }

  // Everything a player is allowed to see. No other seat's sheet or rolls,
  // and no hidden actor in any form.
  playerView(seatId) {
    const s = this.room.seats[seatId];
    const init = this.room.initiative;
    const showActors = this.room.config.features.monsters !== false;
    const visible = init.order
      .filter(e => {
        if (e.kind !== "actor") return true;
        if (!showActors) return false;
        const a = this.find("actor", e.id);
        return a && !a.hidden;
      })
      .map(e => {
        const c = this.find(e.kind, e.id);
        return {
          kind: e.kind, id: e.id, value: e.value,
          name: c ? c.name : "?",
          me: e.kind === "seat" && e.id === seatId,
        };
      });
    const cur = init.order[init.turn];
    return {
      t: "me",
      code: this.room.code,
      config: this.room.config,
      conditions: CONDITIONS,
      exhaustion: EXHAUSTION,
      featureList: FEATURES,
      seat: {
        ...this.publicCombatant(s, "seat"),
        mode: s.mode, mod: s.mod, sheetLocked: s.sheetLocked,
        stats: s.stats, atk: s.atk, history: s.history,
      },
      request: this.room.requests[seatId] || null,
      initiative: {
        active: init.active, round: init.round,
        order: visible,
        current: cur ? { kind: cur.kind, id: cur.id, mine: cur.kind === "seat" && cur.id === seatId } : null,
      },
    };
  }

  push(ws, who) {
    try {
      ws.send(JSON.stringify(who.role === "dm" ? this.dmView() : this.playerView(who.seat)));
    } catch { /* socket gone */ }
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

  pushAllSeats() {
    for (const s of this.room.seats) this.pushSeat(s.id);
  }

  pushAll() { this.pushAllSeats(); this.pushDM(); }

  /* ---------------------------------------------------------- rolling */

  // One roll. sides/count for arbitrary dice, mode for adv/dis on a single d20.
  resolve(opts) {
    const sides = DICE.includes(opts.sides) ? opts.sides : 20;
    const count = Math.max(1, Math.min(20, Math.trunc(opts.count || 1)));
    const mode = ["norm", "adv", "dis"].includes(opts.mode) ? opts.mode : "norm";
    const mod = clampSigned(opts.mod || 0, 199);

    let dice = [], kept, dropped = null;
    if (count === 1 && mode !== "norm") {
      const a = rollDie(sides), b = rollDie(sides);
      kept = mode === "adv" ? Math.max(a, b) : Math.min(a, b);
      dropped = kept === a ? b : a;
      dice = [a, b];
    } else {
      for (let i = 0; i < count; i++) dice.push(rollDie(sides));
      kept = dice.reduce((x, y) => x + y, 0);
    }
    return {
      sides, count, mode, mod, dice, kept, dropped,
      total: kept + mod,
      label: cleanText(opts.label, 48),
      ts: Date.now(),
    };
  }

  logRoll(c, kind, r, secret) {
    const entry = { ...r, kind, id: c.id, name: c.name };
    if (secret) {
      // Deliberately NOT written to c.history: that object is sent to the
      // player, so a secret roll there would not be secret.
      this.room.secretLog.unshift(entry);
      this.room.secretLog.splice(MAX_LOG);
    } else {
      c.history.unshift(r);
      c.history.splice(MAX_HISTORY);
      this.room.log.unshift(entry);
      this.room.log.splice(MAX_LOG);
    }
  }

  // Assemble a roll for a combatant, applying any stat or attack bonus.
  rollFor(kind, id, opts, secret) {
    const c = this.find(kind, id);
    if (!c) return null;
    const bonus = opts.bonusFrom ? this.bonusFor(c, opts.bonusFrom) : 0;
    const r = this.resolve({
      sides: opts.sides,
      count: opts.count,
      mode: opts.mode || (kind === "seat" ? c.mode : "norm"),
      mod: (opts.mod !== undefined ? clampSigned(opts.mod) : (kind === "seat" ? c.mod : 0)) + bonus,
      label: opts.label,
    });
    r.bonusFrom = opts.bonusFrom || null;
    this.logRoll(c, kind, r, secret);
    return r;
  }

  /* ---------------------------------------------------------- damage */

  applyDamage(c, amount) {
    const before = c.hpCur === null ? (c.hpMax || 0) : c.hpCur;
    let amt = Math.trunc(amount);
    if (amt > 0 && c.tempHp > 0) {
      const absorbed = Math.min(c.tempHp, amt);
      c.tempHp -= absorbed;
      amt -= absorbed;
    }
    let next = before - amt;
    next = Math.max(0, next);
    if (c.hpMax !== null) next = Math.min(next, c.hpMax);
    c.hpCur = next;

    // Dropping to 0 opens death saves for a player seat.
    if (next === 0 && before > 0) {
      c.deathSaves.active = true;
      if (!c.conditions.includes("unconscious")) c.conditions.push("unconscious");
    }
    if (next > 0 && before === 0) {
      c.deathSaves = { active: false, s: 0, f: 0 };
      c.conditions = c.conditions.filter(x => x !== "unconscious");
    }
    return { before, after: next, dealt: Math.max(0, before - next) };
  }

  /* ---------------------------------------------------------- initiative */

  buildOrder() {
    const init = this.room.initiative;
    const rows = [];
    for (const s of this.room.seats) {
      if (s.initiative !== null) rows.push({ kind: "seat", id: s.id, value: s.initiative });
    }
    for (const a of this.room.actors) {
      if (a.initiative !== null) rows.push({ kind: "actor", id: a.id, value: a.initiative });
    }
    rows.sort((x, y) => y.value - x.value || (x.kind === "seat" ? -1 : 1));
    const cur = init.order[init.turn];
    init.order = rows;
    if (cur) {
      const i = rows.findIndex(r => r.kind === cur.kind && r.id === cur.id);
      init.turn = i >= 0 ? i : 0;
    } else {
      init.turn = 0;
    }
  }

  /* ---------------------------------------------------------- messages */

  async webSocketMessage(ws, raw) {
    const who = ws.deserializeAttachment();
    if (!who || !this.room) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (who.role === "player") return this.playerMessage(who.seat, m);
    return this.dmMessage(m);
  }

  async playerMessage(seatId, m) {
    const s = this.room.seats[seatId];
    if (!s) return;

    switch (m.t) {
      case "roll": {
        // A pending request fixes the terms of the roll.
        const req = this.room.requests[seatId];
        const opts = req
          ? { sides: 20, count: 1, mode: req.mode, bonusFrom: req.bonusFrom, label: req.label }
          : { sides: m.sides, count: m.count, mode: s.mode, label: m.label, bonusFrom: m.bonusFrom };
        this.rollFor("seat", seatId, opts, false);
        if (req) delete this.room.requests[seatId];
        await this.save();
        this.pushSeat(seatId);
        this.pushDM();
        break;
      }
      case "sheet": {
        if (s.sheetLocked) return;
        s.hpMax = clampStat(m.hpMax);
        s.hpCur = clampStat(m.hpCur);
        s.ac = clampStat(m.ac, 99);
        if (s.hpMax !== null && s.hpCur === null) s.hpCur = s.hpMax;
        if (s.hpMax !== null && s.hpCur !== null) s.hpCur = Math.min(s.hpCur, s.hpMax);
        if (m.stats && typeof m.stats === "object") {
          const out = {};
          for (const k of this.room.config.stats) {
            const v = m.stats[k];
            out[k] = (v === "" || v === null || v === undefined) ? null : clampSigned(v, 999);
          }
          s.stats = out;
        }
        if (m.atk && typeof m.atk === "object") {
          s.atk = {
            melee: clampSigned(m.atk.melee),
            ranged: clampSigned(m.atk.ranged),
            spell: clampSigned(m.atk.spell),
          };
        }
        s.sheetLocked = true;
        await this.save();
        this.pushSeat(seatId);
        this.pushDM();
        break;
      }
      case "name": {
        const n = cleanText(m.name, 24);
        if (n) { s.name = n; await this.save(); this.pushSeat(seatId); this.pushDM(); }
        break;
      }
      case "concentrationEnd": {
        // A player may always drop their own concentration.
        s.concentration = { on: false, note: "" };
        await this.save();
        this.pushSeat(seatId);
        this.pushDM();
        break;
      }
      // Everything else is the DM's call and is ignored here on purpose.
    }
  }

  async dmMessage(m) {
    const r = this.room;

    switch (m.t) {
      /* ---- table config */
      case "config": {
        if (Array.isArray(m.stats)) {
          const list = m.stats.map(x => cleanText(x, 8)).filter(Boolean).slice(0, 10);
          if (list.length) r.config.stats = list;
        }
        if (m.statMode === "5e" || m.statMode === "raw") r.config.statMode = m.statMode;
        if (m.features) r.config.features = cleanFeatures(m.features, r.config.features);
        if (m.initStat !== undefined) r.config.initStat = cleanText(m.initStat, 12) || null;
        break;
      }
      case "seats": {
        const n = clampSeats(m.n), cur = r.seats.length;
        if (n > cur) for (let i = cur; i < n; i++) r.seats.push(this.newSeat(i));
        else if (n < cur) r.seats.length = n;
        break;
      }

      /* ---- per combatant */
      case "mode": {
        const c = this.find("seat", m.seat);
        if (c && ["norm", "adv", "dis"].includes(m.mode)) c.mode = m.mode;
        break;
      }
      case "modeAll": {
        if (["norm", "adv", "dis"].includes(m.mode)) for (const s of r.seats) s.mode = m.mode;
        break;
      }
      case "mod": {
        const c = this.find("seat", m.seat);
        if (c) c.mod = clampSigned(m.mod, 20);
        break;
      }
      case "hp": {
        const c = this.find(m.kind, m.id);
        if (!c) break;
        if ("max" in m) c.hpMax = clampStat(m.max);
        if ("cur" in m) c.hpCur = clampStat(m.cur);
        if ("temp" in m) c.tempHp = clampStat(m.temp) || 0;
        if (c.hpMax !== null && c.hpCur !== null) c.hpCur = Math.min(c.hpCur, c.hpMax);
        break;
      }
      case "ac": {
        const c = this.find(m.kind, m.id);
        if (c) c.ac = clampStat(m.ac, 99);
        break;
      }
      case "damage": {
        const c = this.find(m.kind, m.id);
        if (!c || !Number.isFinite(m.amount)) break;
        const taken = Math.max(0, Math.trunc(m.amount));
        this.applyDamage(c, m.amount);
        // Concentration prompt. DC is 10 or half the damage taken, whichever is
        // higher. Damage taken, not damage dealt: dropping to 0 does not soften
        // the blow, and temporary hit points do not either.
        if (c.concentration.on && taken > 0) {
          const dc = Math.max(10, Math.floor(taken / 2));
          c.concentration.prompt = { dc, dealt: taken, ts: Date.now() };
          if (m.kind === "seat") {
            r.requests[c.id] = {
              id: code(4), label: `Concentration save, DC ${dc}`,
              bonusFrom: "CON", mode: "norm", dc,
            };
          }
        }
        break;
      }
      case "condition": {
        const c = this.find(m.kind, m.id);
        if (!c || !CONDITIONS[m.cond]) break;
        const has = c.conditions.includes(m.cond);
        if (m.on === false || (m.on === undefined && has)) {
          c.conditions = c.conditions.filter(x => x !== m.cond);
        } else if (!has) {
          c.conditions.push(m.cond);
        }
        break;
      }
      case "exhaustion": {
        const c = this.find(m.kind, m.id);
        if (c) c.exhaustion = Math.max(0, Math.min(6, Math.trunc(Number(m.level) || 0)));
        break;
      }
      case "concentration": {
        const c = this.find(m.kind, m.id);
        if (!c) break;
        c.concentration = m.on
          ? { on: true, note: cleanText(m.note, 40) }
          : { on: false, note: "" };
        break;
      }
      case "clearPrompt": {
        const c = this.find(m.kind, m.id);
        if (c && c.concentration) delete c.concentration.prompt;
        break;
      }
      case "deathSaves": {
        const c = this.find(m.kind, m.id);
        if (!c) break;
        if ("active" in m) c.deathSaves.active = !!m.active;
        if ("s" in m) c.deathSaves.s = Math.max(0, Math.min(3, Math.trunc(m.s)));
        if ("f" in m) c.deathSaves.f = Math.max(0, Math.min(3, Math.trunc(m.f)));
        break;
      }
      case "unlock": {
        const c = this.find("seat", m.seat);
        if (c) c.sheetLocked = false;
        break;
      }
      case "setStats": {
        const c = this.find(m.kind, m.id);
        if (!c) break;
        if (m.stats && typeof m.stats === "object") {
          const out = { ...c.stats };
          for (const k of r.config.stats) {
            if (k in m.stats) {
              const v = m.stats[k];
              out[k] = (v === "" || v === null) ? null : clampSigned(v, 999);
            }
          }
          c.stats = out;
        }
        if (m.atk && typeof m.atk === "object") {
          c.atk = {
            melee: clampSigned(m.atk.melee ?? c.atk.melee),
            ranged: clampSigned(m.atk.ranged ?? c.atk.ranged),
            spell: clampSigned(m.atk.spell ?? c.atk.spell),
          };
        }
        break;
      }

      /* ---- actors */
      case "addActors": {
        const n = Math.max(1, Math.min(20, Math.trunc(Number(m.count) || 1)));
        if (r.actors.length + n > MAX_ACTORS) break;
        const base = cleanText(m.name, 32) || "Creature";
        for (let i = 0; i < n; i++) {
          const nm = n > 1 ? `${base} ${i + 1}` : base;
          r.actors.push(this.newActor(nm, m.hp, m.ac, m.hidden !== false));
        }
        break;
      }
      case "reveal": {
        if (m.id === "all") { for (const a of r.actors) a.hidden = false; break; }
        const a = this.find("actor", m.id);
        if (a) a.hidden = m.hidden === true;
        break;
      }
      case "renameActor": {
        const a = this.find("actor", m.id);
        if (a) a.name = cleanText(m.name, 40) || a.name;
        break;
      }
      case "removeActor": {
        r.actors = r.actors.filter(a => a.id !== m.id);
        r.initiative.order = r.initiative.order.filter(e => !(e.kind === "actor" && e.id === m.id));
        break;
      }
      case "clearActors": {
        r.actors = [];
        r.initiative.order = r.initiative.order.filter(e => e.kind !== "actor");
        break;
      }

      /* ---- initiative */
      case "initStart": {
        r.initiative.active = true;
        r.initiative.round = 1;
        r.initiative.turn = 0;
        this.buildOrder();
        break;
      }
      case "initStop": {
        r.initiative = { active: false, round: 0, turn: 0, order: [] };
        for (const s of r.seats) s.initiative = null;
        for (const a of r.actors) a.initiative = null;
        break;
      }
      case "initSet": {
        const c = this.find(m.kind, m.id);
        if (!c) break;
        c.initiative = (m.value === null || m.value === "") ? null : clampSigned(m.value, 99);
        this.buildOrder();
        break;
      }
      case "initRoll": {
        // who: "actors" | "seats" | "all" | a single {kind,id}
        const stat = r.config.initStat;
        const doOne = c => {
          const roll = rollDie(20) + this.modFor(c, stat);
          c.initiative = roll;
        };
        if (m.who === "actors" || m.who === "all") for (const a of r.actors) doOne(a);
        if (m.who === "seats" || m.who === "all") for (const s of r.seats) doOne(s);
        if (m.who && m.who.kind) {
          const c = this.find(m.who.kind, m.who.id);
          if (c) doOne(c);
        }
        this.buildOrder();
        break;
      }
      case "initTurn": {
        const init = r.initiative;
        if (!init.order.length) break;
        const step = m.dir === "prev" ? -1 : 1;
        let t = init.turn + step;
        if (t >= init.order.length) { t = 0; init.round += 1; }
        if (t < 0) { t = init.order.length - 1; init.round = Math.max(1, init.round - 1); }
        init.turn = t;
        break;
      }

      /* ---- rolls */
      case "rollFor": {
        this.rollFor(m.kind || "seat", m.id, {
          sides: m.sides, count: m.count, mode: m.mode,
          bonusFrom: m.bonusFrom, label: m.label,
        }, false);
        break;
      }
      case "rollSecret": {
        this.rollFor(m.kind || "seat", m.id, {
          sides: m.sides, count: m.count, mode: m.mode,
          bonusFrom: m.bonusFrom, label: m.label,
        }, true);
        break;
      }
      case "rollDM": {
        const roll = this.resolve({
          sides: m.sides, count: m.count, mode: m.mode, mod: m.mod, label: m.label,
        });
        r.dmHistory.unshift(roll);
        r.dmHistory.splice(MAX_HISTORY);
        break;
      }
      case "request": {
        // Ask one seat, or every seat, for a specific roll.
        const req = {
          id: code(4),
          label: cleanText(m.label, 48) || "Roll",
          bonusFrom: m.bonusFrom || null,
          mode: ["norm", "adv", "dis"].includes(m.mode) ? m.mode : "norm",
          dc: Number.isFinite(m.dc) ? Math.trunc(m.dc) : null,
        };
        if (m.seat === "all") for (const s of r.seats) r.requests[s.id] = { ...req };
        else if (r.seats[m.seat]) r.requests[m.seat] = req;
        break;
      }
      case "cancelRequest": {
        if (m.seat === "all") r.requests = {};
        else delete r.requests[m.seat];
        break;
      }
      case "clear": {
        for (const s of r.seats) s.history = [];
        for (const a of r.actors) a.history = [];
        r.log = []; r.dmHistory = []; r.secretLog = [];
        break;
      }
      default: return;
    }

    await this.save();
    this.pushAll();
  }

  async webSocketClose(ws) {
    try { ws.close(); } catch { /* ignore */ }
    this.pushDM();
  }

  async webSocketError() { this.pushDM(); }
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
      return json(await stub.create(roomCode, body.seats, body.features));
    }

    if (url.pathname === "/api/seat" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const roomCode = String(body.code || "").toUpperCase();
      if (!/^[A-Z2-9]{5}$/.test(roomCode)) {
        return json({ ok: false, error: "That table code does not look right." }, 400);
      }
      const stub = env.TABLE.getByName(roomCode);
      if (!(await stub.exists())) return json({ ok: false, error: "No table with that code." }, 404);
      return json(await stub.checkSeat(body.seat));
    }

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected websocket", { status: 426 });
      }
      const roomCode = (url.searchParams.get("code") || "").toUpperCase();
      if (!/^[A-Z2-9]{5}$/.test(roomCode)) return new Response("Bad table code", { status: 400 });
      return env.TABLE.getByName(roomCode).fetch(request);
    }

    // The client is embedded, so there is no assets directory.
    return new Response(CLIENT_HTML, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};


/* ===================================================== embedded client */

const CLIENT_HTML = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n<title>Dice Table</title>\n<meta name=\"description\" content=\"A shared table. The DM runs initiative and sees every roll. Players see only their own. No AI generated content anywhere in it.\">\n<style>\n  /* ---------------- themes ---------------- */\n  :root,\n  :root[data-theme=\"bloodmoon\"]{\n    --ground:#130A11; --lift:#22131F; --lift2:#311D2C; --rule:#46283E;\n    --paper:#F3E9EC; --dim:#C3AAB4; --faint:#7C6370;\n    --accent:#D8344A; --accent2:#E0C9A8; --good:#77C98A; --bad:#E2564B;\n  }\n  :root[data-theme=\"emberfall\"]{\n    --ground:#15110E; --lift:#241C16; --lift2:#33271E; --rule:#4A382A;\n    --paper:#F4EDE3; --dim:#C6B6A2; --faint:#7E6E5C;\n    --accent:#E8762B; --accent2:#D8B36A; --good:#8FBF6B; --bad:#D9503C;\n  }\n  :root[data-theme=\"drowned\"]{\n    --ground:#08151A; --lift:#102730; --lift2:#183843; --rule:#23505E;\n    --paper:#E8F1F0; --dim:#9FBDBE; --faint:#628086;\n    --accent:#3FB8A6; --accent2:#A8C6BE; --good:#6FD3A8; --bad:#E0685E;\n  }\n  :root[data-theme=\"witchlight\"]{\n    --ground:#0B0A12; --lift:#171526; --lift2:#221F38; --rule:#342F52;\n    --paper:#ECEAF6; --dim:#ADA7C6; --faint:#6E688A;\n    --accent:#7CF36B; --accent2:#B98CFF; --good:#7CF36B; --bad:#FF5C7A;\n  }\n  :root{box-sizing:border-box;\n    padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}\n  *{box-sizing:border-box}\n  html{-webkit-text-size-adjust:100%}\n  body{margin:0;background:var(--ground);color:var(--paper);\n    font-family:ui-serif,Georgia,\"Times New Roman\",serif;line-height:1.5;min-height:100vh}\n  .wrap{max-width:66rem;margin:0 auto;padding:1.1rem}\n  .narrow{max-width:27rem}\n\n  h1{font-family:ui-sans-serif,system-ui,sans-serif;font-weight:800;font-size:.8125rem;\n    letter-spacing:.22em;text-transform:uppercase;color:var(--accent);margin:0 0 1rem}\n  h2{font-family:ui-sans-serif,system-ui,sans-serif;font-weight:700;font-size:.75rem;\n    letter-spacing:.16em;text-transform:uppercase;color:var(--faint);margin:1.5rem 0 .6rem}\n  .screen{display:none} .screen.on{display:block}\n  .hide{display:none!important}\n\n  button,input,select,textarea{font:inherit}\n  button{font-family:ui-sans-serif,system-ui,sans-serif;font-weight:700;font-size:.9375rem;\n    background:transparent;color:var(--paper);border:1.5px solid var(--rule);\n    border-radius:9px;padding:.6rem .85rem;cursor:pointer}\n  button:hover{border-color:var(--dim)}\n  button:focus-visible,input:focus-visible,select:focus-visible{outline:2.5px solid var(--accent);outline-offset:2px}\n  button[aria-pressed=\"true\"],button.on{background:var(--accent);border-color:var(--accent);color:var(--ground)}\n  button[disabled]{opacity:.4;cursor:default}\n  .primary{background:var(--paper);color:var(--ground);border-color:var(--paper);\n    width:100%;padding:.85rem;font-size:1.0625rem;margin-top:.4rem}\n  .primary:hover{background:var(--accent);border-color:var(--accent);color:var(--ground)}\n  .sm{padding:.35rem .55rem;font-size:.8125rem;border-radius:7px}\n  .ghost{border-color:transparent;color:var(--dim);font-size:.8125rem;padding:.35rem .5rem}\n  input,select,textarea{background:var(--lift);border:1.5px solid var(--rule);border-radius:9px;\n    color:var(--paper);padding:.55rem .65rem;width:100%}\n  select{appearance:none;padding-right:1.8rem;\n    background-image:linear-gradient(45deg,transparent 50%,var(--dim) 50%),linear-gradient(135deg,var(--dim) 50%,transparent 50%);\n    background-position:calc(100% - 15px) 1.05rem,calc(100% - 10px) 1.05rem;\n    background-size:5px 5px;background-repeat:no-repeat}\n  input.code{font-family:ui-monospace,Menlo,monospace;letter-spacing:.3em;text-transform:uppercase;\n    text-align:center;font-size:1.2rem}\n  label{display:block;font-family:ui-sans-serif,system-ui,sans-serif;font-size:.6875rem;\n    letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin:0 0 .3rem}\n  .field{margin-bottom:.8rem}\n  .err{color:var(--bad);font-size:.875rem;min-height:1.3em;margin:.5rem 0 0}\n  .row{display:flex;gap:.45rem;flex-wrap:wrap;align-items:center}\n  .grow{flex:1}\n\n  /* ---------------- landing ---------------- */\n  .noai{display:inline-flex;align-items:center;gap:.5rem;border:1.5px solid var(--good);\n    border-radius:999px;padding:.35rem .9rem;margin:0 0 1rem;\n    font-family:ui-sans-serif,system-ui,sans-serif;font-weight:800;font-size:.75rem;\n    letter-spacing:.14em;text-transform:uppercase;color:var(--good)}\n  .noai::before{content:\"\";width:.45rem;height:.45rem;border-radius:50%;background:var(--good)}\n  .noai-note{color:var(--dim);font-size:.9375rem;margin:0 0 1.25rem}\n  .choice{display:grid;gap:.7rem;margin-top:1.25rem}\n  .choice button{padding:1rem;text-align:left;border-radius:11px}\n  .choice b{display:block;font-size:1.0625rem;margin-bottom:.1rem}\n  .choice span{display:block;font-weight:400;font-family:ui-serif,Georgia,serif;\n    font-size:.9375rem;color:var(--dim)}\n  .themes{display:flex;gap:.4rem;flex-wrap:wrap;margin-top:1.25rem}\n  .themes button{font-size:.75rem;padding:.4rem .7rem;border-radius:999px}\n\n  /* ---------------- die ---------------- */\n  .stage{width:100%;aspect-ratio:1;max-height:34vh;margin:.2rem auto}\n  canvas{width:100%;height:100%;display:block;cursor:pointer;touch-action:manipulation}\n  canvas:focus-visible{outline:2.5px solid var(--accent);outline-offset:4px;border-radius:12px}\n  .total{font-family:ui-sans-serif,system-ui,sans-serif;font-weight:800;\n    font-size:clamp(2rem,11vw,3.25rem);line-height:1;letter-spacing:-.03em;\n    margin:.15rem 0;min-height:1em;text-align:center}\n  .total.crit{color:var(--good)} .total.fumble{color:var(--bad)}\n  .breakdown{font-size:.9375rem;color:var(--dim);text-align:center;min-height:1.4em;margin:0 0 .8rem}\n  .breakdown .drop{color:var(--faint);text-decoration:line-through}\n  .banner{border:1.5px solid var(--rule);border-radius:9px;padding:.55rem .8rem;\n    text-align:center;font-size:.9375rem;color:var(--dim);margin-bottom:.7rem}\n  .banner.adv{border-color:var(--good);color:var(--good)}\n  .banner.dis{border-color:var(--bad);color:var(--bad)}\n  .banner.ask{border-color:var(--accent);color:var(--paper);background:var(--lift)}\n  .banner.turn{border-color:var(--accent2);color:var(--accent2)}\n\n  /* ---------------- tabs ---------------- */\n  .tabs{display:flex;gap:.3rem;flex-wrap:wrap;border-bottom:1.5px solid var(--rule);\n    margin:.9rem 0 1rem;padding-bottom:.55rem}\n  .tabs button{border:0;border-radius:8px;padding:.45rem .8rem;color:var(--dim);font-size:.8125rem;\n    letter-spacing:.06em;text-transform:uppercase}\n  .tabs button.on{background:var(--lift2);color:var(--paper)}\n  .pane{display:none} .pane.on{display:block}\n\n  /* ---------------- initiative ---------------- */\n  .initbar{background:var(--lift);border:1.5px solid var(--rule);border-radius:11px;\n    padding:.7rem .8rem;margin-bottom:.9rem}\n  .initbar .head{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-bottom:.55rem}\n  .round{font-family:ui-sans-serif,system-ui,sans-serif;font-weight:800;font-size:.8125rem;\n    letter-spacing:.1em;text-transform:uppercase;color:var(--accent2)}\n  .order{display:flex;gap:.35rem;overflow-x:auto;padding-bottom:.25rem}\n  .turnchip{flex:none;display:flex;flex-direction:column;align-items:center;gap:.1rem;\n    border:1.5px solid var(--rule);border-radius:9px;padding:.35rem .6rem;min-width:4.4rem;\n    background:var(--ground)}\n  .turnchip.now{border-color:var(--accent);background:var(--lift2)}\n  .turnchip.mine{border-color:var(--accent2)}\n  .turnchip.foe{border-style:dashed}\n  .turnchip b{font-family:ui-sans-serif,system-ui,sans-serif;font-size:.8125rem;font-weight:700;\n    max-width:7rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n  .turnchip i{font-style:normal;font-size:.75rem;color:var(--faint)}\n  .turnchip.down{opacity:.5}\n\n  /* ---------------- combatant cards ---------------- */\n  .cards{display:grid;gap:.7rem;grid-template-columns:repeat(auto-fill,minmax(17.5rem,1fr))}\n  .card{background:var(--lift);border:1.5px solid var(--rule);border-radius:11px;padding:.75rem}\n  .card.off{opacity:.6}\n  .card.hidden-actor{border-style:dashed}\n  .card.down{border-color:var(--bad)}\n  .card header{display:flex;align-items:center;gap:.4rem;margin-bottom:.4rem}\n  .card .nm{font-weight:700;font-family:ui-sans-serif,system-ui,sans-serif;font-size:.9375rem;\n    flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n  .card .sc{font-family:ui-monospace,Menlo,monospace;font-size:.75rem;color:var(--accent);letter-spacing:.1em}\n  .dot{width:.45rem;height:.45rem;border-radius:50%;background:var(--faint);flex:none}\n  .dot.on{background:var(--good)}\n  .res{font-family:ui-sans-serif,system-ui,sans-serif;font-weight:800;font-size:1.6rem;line-height:1;margin:.15rem 0 0}\n  .res.crit{color:var(--good)} .res.fumble{color:var(--bad)}\n  .sub{font-size:.8125rem;color:var(--dim);min-height:1.1em}\n  .seg{display:flex;gap:.25rem;margin-top:.5rem}\n  .seg button{flex:1;padding:.35rem .2rem;font-size:.6875rem;border-radius:7px}\n  .stats{display:flex;gap:.3rem;margin-top:.5rem;border-top:1px solid var(--rule);padding-top:.5rem}\n  .stat{flex:1;text-align:center}\n  .stat b{display:block;font-family:ui-sans-serif,system-ui,sans-serif;font-weight:800;font-size:1.05rem;line-height:1.1}\n  .stat span{display:block;font-family:ui-sans-serif,system-ui,sans-serif;font-size:.625rem;\n    letter-spacing:.08em;text-transform:uppercase;color:var(--faint)}\n  .stat.down b{color:var(--bad)} .stat.hurt b{color:var(--accent2)}\n  .hpbar{height:.28rem;border-radius:2px;background:var(--rule);overflow:hidden;margin-top:.35rem}\n  .hpbar i{display:block;height:100%;background:var(--good)}\n  .hpbar i.hurt{background:var(--accent2)} .hpbar i.down{background:var(--bad)}\n  .dmg{display:flex;gap:.25rem;margin-top:.45rem;align-items:center}\n  .dmg button{padding:.3rem .4rem;font-size:.75rem;border-radius:7px;flex:1}\n  .dmg input{width:2.9rem;padding:.3rem;text-align:center;font-size:.75rem}\n  .mini{display:flex;gap:.3rem;margin-top:.45rem;align-items:flex-end}\n  .mini label{font-size:.5625rem;margin-bottom:.1rem}\n  .mini input{padding:.32rem;text-align:center;font-size:.75rem}\n  .chips{display:flex;flex-wrap:wrap;gap:.25rem;margin-top:.45rem}\n  .chip{font-family:ui-sans-serif,system-ui,sans-serif;font-size:.6875rem;font-weight:700;\n    background:var(--lift2);color:var(--dim);border:1px solid var(--rule);border-radius:999px;\n    padding:.15rem .5rem;cursor:pointer}\n  .chip.cond{color:var(--accent2);border-color:var(--accent2)}\n  .chip.conc{color:var(--good);border-color:var(--good)}\n  .chip.exh{color:var(--bad);border-color:var(--bad)}\n  .chip.crit{color:var(--good)} .chip.fumble{color:var(--bad)}\n  .chip.plain{cursor:default}\n  .note{font-size:.75rem;color:var(--faint);margin:.4rem 0 0;font-style:italic}\n  .deaths{display:flex;gap:.3rem;align-items:center;margin-top:.45rem;font-size:.75rem;color:var(--dim)}\n  .pip{width:.85rem;height:.85rem;border-radius:50%;border:1.5px solid var(--rule);cursor:pointer}\n  .pip.s{background:var(--good);border-color:var(--good)}\n  .pip.f{background:var(--bad);border-color:var(--bad)}\n  .prompt{border:1.5px solid var(--accent);background:var(--lift2);border-radius:8px;\n    padding:.4rem .55rem;margin-top:.45rem;font-size:.8125rem}\n\n  /* ---------------- log ---------------- */\n  .log{border-top:1px solid var(--rule);max-height:22rem;overflow:auto}\n  .log div{display:flex;gap:.5rem;align-items:baseline;padding:.35rem 0;\n    border-bottom:1px solid color-mix(in srgb,var(--rule) 60%,transparent);font-size:.875rem}\n  .log .who{flex:1;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n  .log .det{color:var(--faint);font-size:.75rem;text-align:right;min-width:8rem}\n  .log .tot{font-family:ui-sans-serif,system-ui,sans-serif;font-weight:800;min-width:2rem;text-align:right}\n  .log .tot.crit{color:var(--good)} .log .tot.fumble{color:var(--bad)}\n\n  .roomcode{font-family:ui-monospace,Menlo,monospace;font-size:1.7rem;letter-spacing:.22em;\n    color:var(--accent);margin:0}\n  .status{font-size:.8125rem;color:var(--faint);margin-top:.7rem}\n  .status.bad{color:var(--bad)}\n  footer{color:var(--faint);font-size:.75rem;margin-top:1.5rem;line-height:1.6}\n  details{margin-top:.5rem} summary{cursor:pointer;font-size:.8125rem;color:var(--dim)}\n  .desc{font-size:.8125rem;color:var(--dim);margin:.35rem 0 0}\n  .feats{display:grid;gap:.3rem;grid-template-columns:repeat(auto-fill,minmax(13rem,1fr))}\n  .feat{display:flex;gap:.5rem;align-items:center;background:var(--lift);border:1.5px solid var(--rule);\n    border-radius:8px;padding:.4rem .55rem;cursor:pointer;font-size:.8125rem}\n  .feat input{width:auto;margin:0;accent-color:var(--accent)}\n  .feat.off{opacity:.5}\n  @media (prefers-reduced-motion:reduce){*{transition:none!important}}\n</style>\n</head>\n<body>\n\n<!-- ======================================= landing -->\n<section class=\"screen on\" id=\"s-landing\">\n  <div class=\"wrap narrow\">\n    <h1>Dice Table</h1>\n    <p class=\"noai\">No AI generated content</p>\n    <p class=\"noai-note\">\n      This tool is AI free. Nothing in it is AI generated, predicted or suggested.\n      Dice are rolled from cryptographic randomness and the numbers are sent to\n      you. That is the whole of it.\n    </p>\n    <p style=\"color:var(--dim);margin:0 0 .25rem\">\n      The DM runs initiative, sets advantage, and sees every roll.\n      Players see only their own.\n    </p>\n    <div class=\"choice\">\n      <button type=\"button\" id=\"go-dm\">\n        <b>Start a table</b>\n        <span>You are the DM. You get a table code and a seat code for each player.</span>\n      </button>\n      <button type=\"button\" id=\"go-player\">\n        <b>Join a table</b>\n        <span>You have a table code and a seat code from your DM.</span>\n      </button>\n    </div>\n    <h2 style=\"margin-bottom:.35rem\">Theme</h2>\n    <div class=\"themes\" id=\"themes\"></div>\n    <footer>\n      Rolls happen on the server with crypto.getRandomValues and rejection\n      sampling, so nobody at the table can influence or edit a result. No model,\n      no training data, no telemetry, no account.\n    </footer>\n  </div>\n</section>\n\n<!-- ======================================= create -->\n<section class=\"screen\" id=\"s-create\">\n  <div class=\"wrap narrow\">\n    <h1>Start a table</h1>\n    <div class=\"field\">\n      <label for=\"seatcount\">How many players</label>\n      <input id=\"seatcount\" type=\"number\" min=\"1\" max=\"12\" value=\"4\" inputmode=\"numeric\">\n    </div>\n    <h2>What this table uses</h2>\n    <p class=\"note\" style=\"margin:0 0 .6rem\">\n      Switch off anything your system does not use. You can change these later\n      in Setup, and nothing is lost by turning something off and back on.\n    </p>\n    <div id=\"feature-list\"></div>\n    <div class=\"row\" style=\"margin:.5rem 0 .9rem\">\n      <button type=\"button\" class=\"sm\" data-feat-all=\"1\">All on</button>\n      <button type=\"button\" class=\"sm\" data-feat-all=\"0\">All off</button>\n      <button type=\"button\" class=\"sm\" data-feat-preset=\"dice\">Dice only</button>\n    </div>\n    <button type=\"button\" class=\"primary\" id=\"create\">Create table</button>\n    <p class=\"err\" id=\"create-err\"></p>\n    <button type=\"button\" class=\"ghost\" data-back>Back</button>\n  </div>\n</section>\n\n<!-- ======================================= join -->\n<section class=\"screen\" id=\"s-join\">\n  <div class=\"wrap narrow\">\n    <h1>Join a table</h1>\n    <div class=\"field\">\n      <label for=\"joincode\">Table code</label>\n      <input id=\"joincode\" class=\"code\" maxlength=\"5\" autocomplete=\"off\" autocapitalize=\"characters\" spellcheck=\"false\">\n    </div>\n    <div class=\"field\">\n      <label for=\"seatcode\">Your seat code</label>\n      <input id=\"seatcode\" class=\"code\" maxlength=\"4\" autocomplete=\"off\" autocapitalize=\"characters\" spellcheck=\"false\">\n    </div>\n    <button type=\"button\" class=\"primary\" id=\"join\">Take my seat</button>\n    <p class=\"err\" id=\"join-err\"></p>\n    <button type=\"button\" class=\"ghost\" data-back>Back</button>\n  </div>\n</section>\n\n<!-- ======================================= dm -->\n<section class=\"screen\" id=\"s-dm\">\n  <div class=\"wrap\">\n    <div class=\"row\" style=\"justify-content:space-between;align-items:flex-start\">\n      <div>\n        <h1 style=\"margin-bottom:.3rem\">Table</h1>\n        <p class=\"roomcode\" id=\"dm-code\">-----</p>\n      </div>\n      <div class=\"themes\" id=\"dm-themes\" style=\"margin:0\"></div>\n    </div>\n\n    <div id=\"dm-initbar\"></div>\n\n    <div class=\"tabs\" id=\"dm-tabs\">\n      <button type=\"button\" data-tab=\"party\" class=\"on\">Party</button>\n      <button type=\"button\" data-tab=\"foes\">Monsters</button>\n      <button type=\"button\" data-tab=\"dice\">Dice</button>\n      <button type=\"button\" data-tab=\"log\">Log</button>\n      <button type=\"button\" data-tab=\"setup\">Setup</button>\n    </div>\n\n    <div class=\"pane on\" id=\"pane-party\">\n      <div class=\"row\" style=\"margin-bottom:.7rem\">\n        <span style=\"font-size:.75rem;color:var(--faint)\">Set all:</span>\n        <button type=\"button\" class=\"sm\" data-all=\"dis\">Disadv</button>\n        <button type=\"button\" class=\"sm\" data-all=\"norm\">Normal</button>\n        <button type=\"button\" class=\"sm\" data-all=\"adv\">Adv</button>\n        <span class=\"grow\"></span>\n        <button type=\"button\" class=\"sm\" id=\"ask-all\">Ask everyone to roll</button>\n        <button type=\"button\" class=\"sm\" id=\"group-roll\">Group roll</button>\n      </div>\n      <div class=\"card hide\" id=\"ask-panel\" style=\"margin-bottom:.8rem\">\n        <div class=\"row\" style=\"margin-bottom:.5rem\">\n          <b id=\"ask-target\" style=\"font-family:ui-sans-serif,system-ui,sans-serif;font-size:.875rem\">Ask</b>\n          <span class=\"grow\"></span>\n          <button type=\"button\" class=\"sm ghost\" id=\"ask-close\">Close</button>\n        </div>\n        <div class=\"mini\">\n          <div style=\"flex:2\"><label for=\"ask-label\">What to roll</label>\n            <input id=\"ask-label\" placeholder=\"Perception check\"></div>\n          <div style=\"flex:1\"><label for=\"ask-bonus\">Add</label><select id=\"ask-bonus\"></select></div>\n          <div style=\"flex:1\"><label for=\"ask-dc\">DC</label>\n            <input id=\"ask-dc\" type=\"number\" inputmode=\"numeric\" placeholder=\"-\"></div>\n        </div>\n        <div class=\"row\" style=\"margin-top:.5rem\">\n          <div class=\"seg\" style=\"max-width:15rem;margin:0\">\n            <button type=\"button\" data-askmode=\"dis\">Disadv</button>\n            <button type=\"button\" data-askmode=\"norm\" class=\"on\">Normal</button>\n            <button type=\"button\" data-askmode=\"adv\">Adv</button>\n          </div>\n          <span class=\"grow\"></span>\n          <button type=\"button\" class=\"sm\" id=\"ask-send\">Ask them</button>\n          <button type=\"button\" class=\"sm\" id=\"ask-now\">Roll it now</button>\n        </div>\n        <p class=\"note\">Ask them puts a button on their screen. Roll it now rolls on their behalf and shows them the result.</p>\n      </div>\n      <div class=\"cards\" id=\"dm-seats\"></div>\n    </div>\n\n    <div class=\"pane\" id=\"pane-foes\">\n      <div class=\"card\" style=\"margin-bottom:.8rem\">\n        <div class=\"mini\" style=\"align-items:flex-end\">\n          <div style=\"flex:2\"><label for=\"a-name\">Name</label><input id=\"a-name\" placeholder=\"Goblin\"></div>\n          <div style=\"flex:1\"><label for=\"a-count\">How many</label><input id=\"a-count\" type=\"number\" min=\"1\" max=\"20\" value=\"1\" inputmode=\"numeric\"></div>\n          <div style=\"flex:1\"><label for=\"a-hp\">HP</label><input id=\"a-hp\" type=\"number\" min=\"0\" max=\"999\" inputmode=\"numeric\"></div>\n          <div style=\"flex:1\"><label for=\"a-ac\">AC</label><input id=\"a-ac\" type=\"number\" min=\"0\" max=\"99\" inputmode=\"numeric\"></div>\n        </div>\n        <div class=\"row\" style=\"margin-top:.5rem\">\n          <button type=\"button\" class=\"sm on\" id=\"a-hidden\" aria-pressed=\"true\">Add hidden</button>\n          <span class=\"grow\"></span>\n          <button type=\"button\" class=\"sm\" id=\"a-add\">Add to the table</button>\n        </div>\n        <p class=\"note\">Hidden creatures are invisible to players, including in initiative. Reveal them when they step into the light.</p>\n      </div>\n      <div class=\"row\" style=\"margin-bottom:.7rem\">\n        <button type=\"button\" class=\"sm\" id=\"reveal-all\">Reveal all</button>\n        <button type=\"button\" class=\"sm\" id=\"roll-foe-init\">Roll initiative for monsters</button>\n        <span class=\"grow\"></span>\n        <button type=\"button\" class=\"sm ghost\" id=\"clear-foes\">Remove all</button>\n      </div>\n      <div class=\"cards\" id=\"dm-actors\"></div>\n    </div>\n\n    <div class=\"pane\" id=\"pane-dice\">\n      <h2 style=\"margin-top:0\">Your dice</h2>\n      <div class=\"row\">\n        <div style=\"width:6rem\"><label for=\"dm-count\">How many</label>\n          <input id=\"dm-count\" type=\"number\" min=\"1\" max=\"20\" value=\"1\" inputmode=\"numeric\"></div>\n        <div style=\"width:7rem\"><label for=\"dm-sides\">Die</label>\n          <select id=\"dm-sides\"></select></div>\n        <div style=\"width:6rem\"><label for=\"dm-mod\">Modifier</label>\n          <input id=\"dm-mod\" type=\"number\" value=\"0\" inputmode=\"numeric\"></div>\n        <div class=\"grow\"><label for=\"dm-label\">Label</label>\n          <input id=\"dm-label\" placeholder=\"fire damage\"></div>\n      </div>\n      <div class=\"row\" style=\"margin-top:.5rem\">\n        <div class=\"seg\" style=\"max-width:16rem;margin:0\">\n          <button type=\"button\" data-dmmode=\"dis\">Disadv</button>\n          <button type=\"button\" data-dmmode=\"norm\" class=\"on\">Normal</button>\n          <button type=\"button\" data-dmmode=\"adv\">Adv</button>\n        </div>\n        <span class=\"grow\"></span>\n        <button type=\"button\" id=\"dm-roll\">Roll</button>\n      </div>\n      <div class=\"chips\" id=\"dm-chips\"></div>\n      <p class=\"note\">Your rolls stay on this screen. Nobody else sees them.</p>\n    </div>\n\n    <div class=\"pane\" id=\"pane-log\">\n      <h2 style=\"margin-top:0\">Every roll at the table</h2>\n      <div class=\"log\" id=\"dm-log\"></div>\n      <h2>Secret rolls</h2>\n      <p class=\"note\" style=\"margin-top:0\">Rolls you made on someone's behalf that they never saw.</p>\n      <div class=\"log\" id=\"dm-secret\"></div>\n      <button type=\"button\" class=\"ghost\" id=\"dm-clear\" style=\"margin-top:.6rem\">Clear all history</button>\n    </div>\n\n    <div class=\"pane\" id=\"pane-setup\">\n      <h2 style=\"margin-top:0\">Seats</h2>\n      <div class=\"row\">\n        <div style=\"width:7rem\"><label for=\"dm-seatcount\">How many</label>\n          <input id=\"dm-seatcount\" type=\"number\" min=\"1\" max=\"12\" inputmode=\"numeric\"></div>\n      </div>\n      <h2>Stats</h2>\n      <p class=\"note\" style=\"margin-top:0\">Name them whatever your system uses. Comma separated.</p>\n      <div class=\"field\"><input id=\"cfg-stats\" placeholder=\"STR, DEX, CON, INT, WIS, CHA\"></div>\n      <div class=\"row\">\n        <div class=\"grow\"><label for=\"cfg-mode\">How a stat becomes a bonus</label>\n          <select id=\"cfg-mode\">\n            <option value=\"5e\">Subtract 10, halve, round down (5e style)</option>\n            <option value=\"raw\">The number is the bonus (system neutral)</option>\n          </select></div>\n        <div style=\"width:10rem\"><label for=\"cfg-init\">Initiative uses</label>\n          <select id=\"cfg-init\"></select></div>\n      </div>\n      <h2>What this table uses</h2>\n      <div id=\"dm-feature-list\"></div>\n      <div class=\"row\" style=\"margin:.5rem 0 0\">\n        <button type=\"button\" class=\"sm\" data-dmfeat-all=\"1\">All on</button>\n        <button type=\"button\" class=\"sm\" data-dmfeat-all=\"0\">All off</button>\n      </div>\n      <button type=\"button\" class=\"sm\" id=\"cfg-save\" style=\"margin-top:.8rem\">Save setup</button>\n      <p class=\"status\" id=\"dm-status\"></p>\n      <footer>\n        Keep this tab open. The DM link is stored in this browser only, so note\n        the table code somewhere if this is a long campaign.\n      </footer>\n    </div>\n  </div>\n</section>\n\n<!-- ======================================= player -->\n<section class=\"screen\" id=\"s-player\">\n  <div class=\"wrap narrow\">\n    <div class=\"row\" style=\"justify-content:space-between\">\n      <h1 id=\"p-name\" style=\"margin-bottom:.6rem\">Player</h1>\n      <div class=\"themes\" id=\"p-themes\" style=\"margin:0\"></div>\n    </div>\n\n    <div id=\"p-turnbar\"></div>\n    <div class=\"banner ask hide\" id=\"p-request\"></div>\n    <div class=\"banner\" id=\"p-banner\">Normal roll</div>\n\n    <div id=\"p-sheetform\" class=\"hide\">\n      <p class=\"note\" style=\"margin:0 0 .6rem\">\n        Fill this in once. After you save it, your DM controls these numbers.\n      </p>\n      <div class=\"mini\">\n        <div class=\"grow\"><label for=\"p-hpmax\">Max HP</label><input id=\"p-hpmax\" type=\"number\" min=\"0\" max=\"999\" inputmode=\"numeric\"></div>\n        <div class=\"grow\"><label for=\"p-hpcur\">Current HP</label><input id=\"p-hpcur\" type=\"number\" min=\"0\" max=\"999\" inputmode=\"numeric\"></div>\n        <div class=\"grow\"><label for=\"p-ac\">AC</label><input id=\"p-ac\" type=\"number\" min=\"0\" max=\"99\" inputmode=\"numeric\"></div>\n      </div>\n      <div class=\"mini\" id=\"p-statinputs\" style=\"flex-wrap:wrap\"></div>\n      <div class=\"mini\">\n        <div class=\"grow\"><label for=\"p-melee\">Melee</label><input id=\"p-melee\" type=\"number\" value=\"0\" inputmode=\"numeric\"></div>\n        <div class=\"grow\"><label for=\"p-ranged\">Ranged</label><input id=\"p-ranged\" type=\"number\" value=\"0\" inputmode=\"numeric\"></div>\n        <div class=\"grow\"><label for=\"p-spell\">Spell</label><input id=\"p-spell\" type=\"number\" value=\"0\" inputmode=\"numeric\"></div>\n      </div>\n      <button type=\"button\" class=\"primary\" id=\"p-savesheet\">Save my sheet</button>\n    </div>\n\n    <div id=\"p-sheet\" class=\"hide\"></div>\n\n    <div class=\"stage\"><canvas id=\"die\" tabindex=\"0\" role=\"button\" aria-label=\"Roll your die\"></canvas></div>\n    <div class=\"total\" id=\"p-total\">&nbsp;</div>\n    <p class=\"breakdown\" id=\"p-break\">&nbsp;</p>\n\n    <div class=\"row\" id=\"p-dicerow\">\n      <div style=\"width:5.5rem\"><label for=\"p-count\">How many</label>\n        <input id=\"p-count\" type=\"number\" min=\"1\" max=\"20\" value=\"1\" inputmode=\"numeric\"></div>\n      <div style=\"width:6.5rem\"><label for=\"p-sides\">Die</label><select id=\"p-sides\"></select></div>\n      <div class=\"grow\"><label for=\"p-bonus\">Add</label><select id=\"p-bonus\"></select></div>\n    </div>\n    <button type=\"button\" class=\"primary\" id=\"p-roll\">Roll</button>\n    <div class=\"chips\" id=\"p-chips\"></div>\n\n    <details>\n      <summary>Change my name</summary>\n      <div class=\"row\" style=\"margin-top:.5rem\">\n        <input id=\"p-rename\" maxlength=\"24\" placeholder=\"Name\" class=\"grow\">\n        <button type=\"button\" class=\"sm\" id=\"p-save\">Save</button>\n      </div>\n    </details>\n\n    <p class=\"status\" id=\"p-status\"></p>\n    <footer>\n      Advantage, disadvantage, hit points and conditions are set by your DM.\n      Your rolls go to the DM. You do not see anyone else's.\n    </footer>\n  </div>\n</section>\n\n<script>\n\"use strict\";\n\nconst $ = id => document.getElementById(id);\nconst esc = s => String(s == null ? \"\" : s).replace(/[&<>\"']/g, c =>\n  ({ \"&\":\"&amp;\",\"<\":\"&lt;\",\">\":\"&gt;\",'\"':\"&quot;\",\"'\":\"&#39;\" }[c]));\n\n/* ============================================================ themes */\n\nconst THEMES = [\n  [\"bloodmoon\", \"Bloodmoon\"],\n  [\"emberfall\", \"Emberfall\"],\n  [\"drowned\", \"Drowned\"],\n  [\"witchlight\", \"Witchlight\"],\n];\n\nfunction setTheme(id) {\n  document.documentElement.setAttribute(\"data-theme\", id);\n  try { localStorage.setItem(\"dice-theme\", id); } catch {}\n  document.querySelectorAll(\"[data-theme-btn]\").forEach(b =>\n    b.classList.toggle(\"on\", b.dataset.themeBtn === id));\n  if (typeof draw === \"function\") draw();\n}\n\nfunction paintThemePickers() {\n  const html = THEMES.map(([id, name]) =>\n    `<button type=\"button\" data-theme-btn=\"${id}\">${name}</button>`).join(\"\");\n  [\"themes\", \"dm-themes\", \"p-themes\"].forEach(id => { if ($(id)) $(id).innerHTML = html; });\n  document.querySelectorAll(\"[data-theme-btn]\").forEach(b =>\n    b.addEventListener(\"click\", () => setTheme(b.dataset.themeBtn)));\n  let saved = \"bloodmoon\";\n  try { saved = localStorage.getItem(\"dice-theme\") || \"bloodmoon\"; } catch {}\n  setTheme(THEMES.some(t => t[0] === saved) ? saved : \"bloodmoon\");\n}\n\n/* ============================================================ screens */\n\nconst screens = {};\ndocument.querySelectorAll(\".screen\").forEach(s => screens[s.id.slice(2)] = s);\nfunction show(name) {\n  Object.values(screens).forEach(s => s.classList.remove(\"on\"));\n  screens[name].classList.add(\"on\");\n}\ndocument.querySelectorAll(\"[data-back]\").forEach(b =>\n  b.addEventListener(\"click\", () => show(\"landing\")));\n$(\"go-dm\").addEventListener(\"click\", () => show(\"create\"));\n$(\"go-player\").addEventListener(\"click\", () => show(\"join\"));\n\n/* ============================================================ die\n   Twelve golden ratio vertices, faces from shortest edge triples, numbered\n   so opposite faces sum to 21. The client only animates a given number. */\n\nconst PHI = (1 + Math.sqrt(5)) / 2;\nconst VERTS = [\n  [0,1,PHI],[0,1,-PHI],[0,-1,PHI],[0,-1,-PHI],\n  [1,PHI,0],[1,-PHI,0],[-1,PHI,0],[-1,-PHI,0],\n  [PHI,0,1],[PHI,0,-1],[-PHI,0,1],[-PHI,0,-1],\n].map(v => { const n = Math.hypot(...v); return v.map(x => x / n); });\n\nconst d2 = (a,b) => (a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2;\nlet minEdge = Infinity;\nfor (let i=0;i<12;i++) for (let j=i+1;j<12;j++) minEdge = Math.min(minEdge, d2(VERTS[i],VERTS[j]));\n\nconst FACES = [];\nfor (let i=0;i<12;i++) for (let j=i+1;j<12;j++) for (let k=j+1;k<12;k++) {\n  const near = x => Math.abs(x-minEdge) < 1e-6;\n  if (!near(d2(VERTS[i],VERTS[j])) || !near(d2(VERTS[j],VERTS[k])) || !near(d2(VERTS[i],VERTS[k]))) continue;\n  const a=VERTS[i], b=VERTS[j], c=VERTS[k];\n  const ab=[b[0]-a[0],b[1]-a[1],b[2]-a[2]], ac=[c[0]-a[0],c[1]-a[1],c[2]-a[2]];\n  const n=[ab[1]*ac[2]-ab[2]*ac[1], ab[2]*ac[0]-ab[0]*ac[2], ab[0]*ac[1]-ab[1]*ac[0]];\n  const cen=[(a[0]+b[0]+c[0])/3,(a[1]+b[1]+c[1])/3,(a[2]+b[2]+c[2])/3];\n  const out = n[0]*cen[0]+n[1]*cen[1]+n[2]*cen[2] > 0;\n  FACES.push({ idx: out ? [i,j,k] : [i,k,j], centroid: cen });\n}\n(function number(){\n  const taken = new Array(FACES.length).fill(false);\n  let n = 1;\n  for (let i=0;i<FACES.length;i++){\n    if (taken[i]) continue;\n    let opp=-1, best=Infinity;\n    for (let j=0;j<FACES.length;j++){\n      if (j===i||taken[j]) continue;\n      const c=FACES[j].centroid, o=FACES[i].centroid;\n      const dd=(c[0]+o[0])**2+(c[1]+o[1])**2+(c[2]+o[2])**2;\n      if (dd<best){best=dd;opp=j;}\n    }\n    FACES[i].value=n; FACES[opp].value=21-n; taken[i]=taken[opp]=true; n++;\n  }\n})();\nconst faceOf = v => FACES.find(f => f.value === v) || FACES[0];\nconst unitNormal = f => { const c=f.centroid, n=Math.hypot(...c); return c.map(x=>x/n); };\n\nconst qMul=(a,b)=>[\n  a[0]*b[0]-a[1]*b[1]-a[2]*b[2]-a[3]*b[3],\n  a[0]*b[1]+a[1]*b[0]+a[2]*b[3]-a[3]*b[2],\n  a[0]*b[2]-a[1]*b[3]+a[2]*b[0]+a[3]*b[1],\n  a[0]*b[3]+a[1]*b[2]-a[2]*b[1]+a[3]*b[0]];\nconst qAxis=(ax,ang)=>{const n=Math.hypot(...ax)||1,s=Math.sin(ang/2);\n  return [Math.cos(ang/2),ax[0]/n*s,ax[1]/n*s,ax[2]/n*s];};\nfunction qSlerp(a,b,t){\n  let dot=a[0]*b[0]+a[1]*b[1]+a[2]*b[2]+a[3]*b[3], bb=b.slice();\n  if(dot<0){dot=-dot;bb=bb.map(x=>-x);}\n  if(dot>0.9995){const r=a.map((x,i)=>x+(bb[i]-x)*t),n=Math.hypot(...r);return r.map(x=>x/n);}\n  const th=Math.acos(dot),s=Math.sin(th);\n  return a.map((x,i)=>x*Math.sin((1-t)*th)/s+bb[i]*Math.sin(t*th)/s);\n}\nfunction qRotate(q,v){const[w,x,y,z]=q;\n  const t=[2*(y*v[2]-z*v[1]),2*(z*v[0]-x*v[2]),2*(x*v[1]-y*v[0])];\n  return [v[0]+w*t[0]+(y*t[2]-z*t[1]),v[1]+w*t[1]+(z*t[0]-x*t[2]),v[2]+w*t[2]+(x*t[1]-y*t[0])];}\nfunction qFaceForward(f,spin){\n  const n=unitNormal(f), dot=n[2];\n  let q;\n  if(dot>0.99999) q=[1,0,0,0];\n  else if(dot<-0.99999) q=qAxis([1,0,0],Math.PI);\n  else q=qAxis([n[1],-n[0],0], Math.acos(Math.max(-1,Math.min(1,dot))));\n  return qMul(qAxis([0,0,1],spin),q);\n}\n\nconst canvas = $(\"die\"), ctx = canvas.getContext(\"2d\");\nlet cssSize = 280, orientation = qFaceForward(faceOf(20), 0);\nconst cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();\n\nfunction resize(){\n  const r = canvas.getBoundingClientRect();\n  cssSize = Math.max(140, Math.min(r.width, r.height) || 260);\n  const dpr = Math.min(window.devicePixelRatio||1, 3);\n  canvas.width = Math.round(cssSize*dpr); canvas.height = Math.round(cssSize*dpr);\n  ctx.setTransform(dpr,0,0,dpr,0,0);\n  draw();\n}\nconst LIGHT = (()=>{const v=[-0.42,-0.72,0.55],n=Math.hypot(...v);return v.map(x=>x/n);})();\n\nfunction draw(){\n  if (!ctx) return;\n  const S=cssSize, C=S/2, R=S*0.40;\n  ctx.clearRect(0,0,S,S);\n  const good = cssVar(\"--good\") || \"#8f8\", bad = cssVar(\"--bad\") || \"#f88\";\n  const pts = VERTS.map(v => qRotate(orientation, v));\n  const faces = FACES.map(f => {\n    const a=pts[f.idx[0]], b=pts[f.idx[1]], c=pts[f.idx[2]];\n    const ab=[b[0]-a[0],b[1]-a[1],b[2]-a[2]], ac=[c[0]-a[0],c[1]-a[1],c[2]-a[2]];\n    let n=[ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0]];\n    const ln=Math.hypot(...n)||1; n=n.map(x=>x/ln);\n    const cen=[(a[0]+b[0]+c[0])/3,(a[1]+b[1]+c[1])/3,(a[2]+b[2]+c[2])/3];\n    return {f,a,b,c,n,cen,depth:cen[2]};\n  }).filter(o=>o.n[2]>0.015).sort((p,q)=>p.depth-q.depth);\n  const X=p=>C+p[0]*R, Y=p=>C-p[1]*R;\n  ctx.save(); ctx.globalAlpha=.3; ctx.fillStyle=\"#000\";\n  ctx.beginPath(); ctx.ellipse(C,C+R*1.02,R*0.72,R*0.13,0,0,Math.PI*2);\n  ctx.filter=\"blur(10px)\"; ctx.fill(); ctx.restore();\n  for (const o of faces){\n    const lam=Math.max(0,o.n[0]*LIGHT[0]+o.n[1]*LIGHT[1]+o.n[2]*LIGHT[2]);\n    const spec=Math.pow(Math.max(0,o.n[2]),14);\n    const l=18+lam*44+spec*16;\n    ctx.beginPath(); ctx.moveTo(X(o.a),Y(o.a)); ctx.lineTo(X(o.b),Y(o.b));\n    ctx.lineTo(X(o.c),Y(o.c)); ctx.closePath();\n    ctx.fillStyle=`hsl(340 12% ${l.toFixed(1)}%)`; ctx.fill();\n    ctx.lineWidth=Math.max(1,S*0.004);\n    ctx.strokeStyle=`hsl(340 16% ${Math.min(80,l+18).toFixed(1)}%)`; ctx.stroke();\n    const face=o.n[2];\n    if (face>0.30){\n      const size=S*0.115*(0.55+face*0.45);\n      ctx.save(); ctx.globalAlpha=Math.min(1,(face-0.30)/0.34);\n      ctx.translate(C+o.cen[0]*R, C-o.cen[1]*R);\n      ctx.font=`700 ${size}px ui-sans-serif, system-ui, sans-serif`;\n      ctx.textAlign=\"center\"; ctx.textBaseline=\"middle\";\n      const v=o.f.value, hot=(v===20||v===1);\n      ctx.fillStyle = hot && face>0.9 ? (v===20?good:bad)\n        : `hsl(340 10% ${Math.min(92,l+44).toFixed(1)}%)`;\n      ctx.fillText(String(v),0,size*0.04);\n      if(v===6||v===9) ctx.fillRect(-size*0.22,size*0.44,size*0.44,Math.max(1.4,size*0.055));\n      ctx.restore();\n    }\n  }\n}\n\nconst REDUCED = window.matchMedia(\"(prefers-reduced-motion: reduce)\").matches;\nfunction animateTo(value, done){\n  const target = qFaceForward(faceOf(value), Math.random()*Math.PI*2);\n  if (REDUCED){ orientation=target; draw(); done(); return; }\n  const start=performance.now(), TUMBLE=520, SETTLE=760, TOTAL=TUMBLE+SETTLE;\n  const axis=[Math.random()-.5,Math.random()-.5,Math.random()-.5], from=orientation;\n  let atSettle=null;\n  (function frame(now){\n    const t=now-start;\n    if(t<TUMBLE){ orientation=qMul(qAxis(axis,(15-5*(t/TUMBLE))*(t/1000)),from); draw(); requestAnimationFrame(frame); }\n    else if(t<TOTAL){ if(!atSettle) atSettle=orientation;\n      const p=(t-TUMBLE)/SETTLE;\n      orientation=qSlerp(atSettle,target,1-Math.pow(1-p,3)); draw(); requestAnimationFrame(frame); }\n    else { orientation=target; draw(); done(); }\n  })(performance.now());\n}\n\n/* ============================================================ helpers */\n\nconst DICE = [4,6,8,10,12,20,100];\nconst MODE_LABEL = { norm:\"Normal roll\", adv:\"Advantage\", dis:\"Disadvantage\" };\nlet CONDS = {}, EXH = [], CFG = { stats:[], statMode:\"5e\", initStat:null, features:{} };\nlet FEATLIST = {};          // key -> human label, sent by the server\nlet newFeatures = {};       // what the create screen has selected\n\nconst on = k => CFG.features ? CFG.features[k] !== false : true;\n\nfunction featureCheckboxes(target, state, prefix){\n  $(target).className = \"feats\";\n  $(target).innerHTML = Object.entries(FEATLIST).map(([k, label]) =>\n    `<label class=\"feat ${state[k] === false ? \"off\" : \"\"}\">\n       <input type=\"checkbox\" data-${prefix}=\"${k}\" ${state[k] === false ? \"\" : \"checked\"}>\n       <span>${esc(label)}</span></label>`).join(\"\");\n}\n\n// The create screen needs the list before any socket exists, so it carries\n// its own copy. Kept in step with the server list by name only.\nconst FALLBACK_FEATURES = {\n  initiative:\"Initiative and turn order\", monsters:\"Monsters and NPCs\",\n  hp:\"Hit points\", tempHp:\"Temporary hit points\", ac:\"Armor class\",\n  conditions:\"Conditions\", exhaustion:\"Exhaustion\", concentration:\"Concentration\",\n  deathSaves:\"Death saves\", requests:\"Asking players to roll\",\n  secretRolls:\"Secret rolls\", stats:\"Ability scores\", attacks:\"Attack bonuses\",\n  advantage:\"Advantage and disadvantage\", modifiers:\"Flat roll modifiers\",\n  otherDice:\"Dice other than d20\", multiDice:\"Rolling several dice at once\",\n};\n\nfunction critClass(r){\n  if (!r || r.sides !== 20 || r.count !== 1) return \"\";\n  return r.kept === 20 ? \"crit\" : r.kept === 1 ? \"fumble\" : \"\";\n}\n\nfunction detail(r){\n  if (!r) return \"\";\n  let s;\n  if (r.dropped != null) s = `${r.kept} / <span class=\"drop\">${r.dropped}</span>`;\n  else if (r.count > 1) s = `${r.count}d${r.sides} [${r.dice.join(\", \")}]`;\n  else s = `d${r.sides} ${r.kept}`;\n  if (r.mode && r.mode !== \"norm\") s += r.mode === \"adv\" ? \" adv\" : \" dis\";\n  if (r.mod) s += ` ${r.mod>0?\"+\":\"\"}${r.mod}`;\n  if (r.label) s = `${esc(r.label)}: ` + s;\n  return s;\n}\n\nconst hpState = (cur, max) => (cur===null||max===null||!max) ? \"\"\n  : cur === 0 ? \"down\" : (cur/max <= .5 ? \"hurt\" : \"\");\n\nfunction hpBlock(c){\n  const st = hpState(c.hpCur, c.hpMax);\n  const pct = (c.hpMax && c.hpCur !== null) ? Math.round(c.hpCur/c.hpMax*100) : 0;\n  const temp = c.tempHp ? ` <span style=\"color:var(--accent2)\">+${c.tempHp}</span>` : \"\";\n  return `<div class=\"stats\">\n      <div class=\"stat ${st}\"><b>${c.hpCur===null?\"-\":c.hpCur} / ${c.hpMax===null?\"-\":c.hpMax}${temp}</b><span>Hit points</span></div>\n      <div class=\"stat\"><b>${c.ac===null?\"-\":c.ac}</b><span>AC</span></div>\n    </div>\n    <div class=\"hpbar\"><i class=\"${st}\" style=\"width:${pct}%\"></i></div>`;\n}\n\nfunction tagChips(c){\n  const out = [];\n  if (on(\"conditions\")) for (const k of c.conditions || []) {\n    const d = CONDS[k];\n    if (d) out.push(`<span class=\"chip cond\" title=\"${esc(d.text)}\" data-cond=\"${k}\">${esc(d.name)}</span>`);\n  }\n  if (on(\"exhaustion\") && c.exhaustion) out.push(`<span class=\"chip exh\" title=\"${esc(EXH[c.exhaustion]||\"\")}\">Exhaustion ${c.exhaustion}</span>`);\n  if (on(\"concentration\") && c.concentration && c.concentration.on)\n    out.push(`<span class=\"chip conc\" title=\"${esc(c.concentration.note||\"\")}\">Concentrating${c.concentration.note?\": \"+esc(c.concentration.note):\"\"}</span>`);\n  return out.join(\"\");\n}\n\nfunction fillSelect(sel, items, current){\n  sel.innerHTML = items.map(([v,t]) =>\n    `<option value=\"${esc(v)}\"${String(v)===String(current)?\" selected\":\"\"}>${esc(t)}</option>`).join(\"\");\n}\n\n/* ============================================================ socket */\n\nlet sock = null, myRoom = null, reconnectAt = 800;\n\nfunction connect(url, onMsg, statusEl){\n  (function open(){\n    sock = new WebSocket(url);\n    sock.addEventListener(\"open\", () => {\n      reconnectAt = 800;\n      statusEl.textContent = \"Connected.\"; statusEl.classList.remove(\"bad\");\n    });\n    sock.addEventListener(\"message\", e => {\n      let m; try { m = JSON.parse(e.data); } catch { return; }\n      onMsg(m);\n    });\n    sock.addEventListener(\"close\", () => {\n      statusEl.textContent = \"Disconnected. Reconnecting...\";\n      statusEl.classList.add(\"bad\");\n      setTimeout(open, reconnectAt);\n      reconnectAt = Math.min(reconnectAt*1.8, 12000);\n    });\n    sock.addEventListener(\"error\", () => { try { sock.close(); } catch {} });\n  })();\n}\nconst send = o => { if (sock && sock.readyState === 1) sock.send(JSON.stringify(o)); };\nconst wsURL = q => (location.protocol === \"https:\" ? \"wss://\" : \"ws://\") + location.host + \"/ws?\" + q;\n\n/* ============================================================ create and join */\n\nFEATLIST = FALLBACK_FEATURES;\nnewFeatures = Object.fromEntries(Object.keys(FEATLIST).map(k => [k, true]));\nfeatureCheckboxes(\"feature-list\", newFeatures, \"newfeat\");\n\n$(\"s-create\").addEventListener(\"change\", e => {\n  const k = e.target.dataset.newfeat;\n  if (!k) return;\n  newFeatures[k] = e.target.checked;\n  e.target.closest(\".feat\").classList.toggle(\"off\", !e.target.checked);\n});\n$(\"s-create\").addEventListener(\"click\", e => {\n  const b = e.target.closest(\"[data-feat-all],[data-feat-preset]\");\n  if (!b) return;\n  if (b.dataset.featAll !== undefined) {\n    const v = b.dataset.featAll === \"1\";\n    for (const k of Object.keys(newFeatures)) newFeatures[k] = v;\n  } else {\n    // Dice only: the table becomes a shared roller and nothing else.\n    for (const k of Object.keys(newFeatures)) newFeatures[k] = false;\n    newFeatures.advantage = true; newFeatures.modifiers = true;\n    newFeatures.otherDice = true; newFeatures.multiDice = true;\n  }\n  featureCheckboxes(\"feature-list\", newFeatures, \"newfeat\");\n});\n\n$(\"create\").addEventListener(\"click\", async () => {\n  const btn = $(\"create\"); btn.disabled = true; $(\"create-err\").textContent = \"\";\n  try {\n    const res = await fetch(\"/api/create\", {\n      method:\"POST\", headers:{\"content-type\":\"application/json\"},\n      body: JSON.stringify({ seats: Number($(\"seatcount\").value) || 4, features: newFeatures }),\n    });\n    if (!res.ok) throw new Error();\n    const { code, dmToken } = await res.json();\n    try { localStorage.setItem(\"dice-dm-\" + code, dmToken); } catch {}\n    startDM(code, dmToken);\n  } catch { $(\"create-err\").textContent = \"Could not create the table. Try again.\"; }\n  finally { btn.disabled = false; }\n});\n\n$(\"join\").addEventListener(\"click\", async () => {\n  const btn = $(\"join\"); btn.disabled = true; $(\"join-err\").textContent = \"\";\n  const code = $(\"joincode\").value.trim().toUpperCase();\n  const seat = $(\"seatcode\").value.trim().toUpperCase();\n  try {\n    const res = await fetch(\"/api/seat\", {\n      method:\"POST\", headers:{\"content-type\":\"application/json\"},\n      body: JSON.stringify({ code, seat }),\n    });\n    const data = await res.json();\n    if (!data.ok) { $(\"join-err\").textContent = data.error || \"Could not join.\"; return; }\n    startPlayer(code, seat);\n  } catch { $(\"join-err\").textContent = \"Could not reach the table.\"; }\n  finally { btn.disabled = false; }\n});\n\n[\"joincode\",\"seatcode\"].forEach(id =>\n  $(id).addEventListener(\"input\", e => e.target.value = e.target.value.toUpperCase()));\n\n/* ============================================================ DM */\n\nlet dmMode = \"norm\", addHidden = true, lastDM = null;\n\nfunction startDM(code, tok){\n  myRoom = code;\n  history.replaceState(null, \"\", \"#dm=\" + code);\n  $(\"dm-code\").textContent = code;\n  show(\"dm\");\n  fillSelect($(\"dm-sides\"), DICE.map(d => [d, \"d\"+d]), 20);\n  connect(wsURL(`code=${code}&role=dm&token=${encodeURIComponent(tok)}`), renderDM, $(\"dm-status\"));\n}\n\ndocument.querySelectorAll(\"#dm-tabs [data-tab]\").forEach(b =>\n  b.addEventListener(\"click\", () => {\n    document.querySelectorAll(\"#dm-tabs [data-tab]\").forEach(o => o.classList.toggle(\"on\", o===b));\n    document.querySelectorAll(\".pane\").forEach(p =>\n      p.classList.toggle(\"on\", p.id === \"pane-\" + b.dataset.tab));\n  }));\n\nfunction initBarHTML(m){\n  const i = m.initiative;\n  if (!i.active) {\n    return `<div class=\"initbar\"><div class=\"head\">\n      <span class=\"round\">Initiative</span>\n      <span class=\"grow\"></span>\n      <button type=\"button\" class=\"sm\" data-init=\"rollall\">Roll for everyone</button>\n      <button type=\"button\" class=\"sm on\" data-init=\"start\">Begin combat</button>\n    </div><p class=\"note\" style=\"margin:0\">Roll or type initiative, then begin. Hidden creatures stay hidden in the order.</p></div>`;\n  }\n  const chips = i.order.map((e, idx) => {\n    const c = e.kind === \"seat\" ? m.seats.find(s => s.id===e.id) : m.actors.find(a => a.id===e.id);\n    if (!c) return \"\";\n    const cls = [ \"turnchip\", idx===i.turn?\"now\":\"\", e.kind===\"actor\"?\"foe\":\"\",\n                  (c.hpCur===0?\"down\":\"\") ].filter(Boolean).join(\" \");\n    return `<div class=\"${cls}\" data-jump=\"${idx}\"><b>${esc(c.name)}</b><i>${e.value}</i></div>`;\n  }).join(\"\");\n  return `<div class=\"initbar\">\n    <div class=\"head\">\n      <span class=\"round\">Round ${i.round}</span>\n      <button type=\"button\" class=\"sm\" data-init=\"prev\">Back</button>\n      <button type=\"button\" class=\"sm on\" data-init=\"next\">Next turn</button>\n      <span class=\"grow\"></span>\n      <button type=\"button\" class=\"sm\" data-init=\"rollall\">Reroll all</button>\n      <button type=\"button\" class=\"sm ghost\" data-init=\"stop\">End combat</button>\n    </div>\n    <div class=\"order\">${chips || '<span class=\"note\">Nobody has an initiative value yet.</span>'}</div>\n  </div>`;\n}\n\nfunction condSelect(kind, id){\n  const opts = Object.entries(CONDS)\n    .map(([k,v]) => `<option value=\"${k}\">${esc(v.name)}</option>`).join(\"\");\n  return `<select class=\"sm\" data-addcond=\"${kind}:${id}\" style=\"padding:.3rem;font-size:.75rem\">\n    <option value=\"\">Add condition...</option>${opts}</select>`;\n}\n\nfunction combatantControls(c, kind){\n  const key = `${kind}:${c.id}`;\n  const exhOpts = EXH.map((t,i) => `<option value=\"${i}\"${i===c.exhaustion?\" selected\":\"\"}>${i===0?\"No exhaustion\":\"Exhaustion \"+i}</option>`).join(\"\");\n  const prompt = on(\"concentration\") && c.concentration && c.concentration.prompt\n    ? `<div class=\"prompt\">Concentration check, DC ${c.concentration.prompt.dc} after ${c.concentration.prompt.dealt} damage.\n        <button type=\"button\" class=\"sm\" data-conc=\"drop:${key}\">Ended</button>\n        <button type=\"button\" class=\"sm\" data-conc=\"keep:${key}\">Held</button></div>` : \"\";\n  const deaths = on(\"deathSaves\") && c.deathSaves && c.deathSaves.active\n    ? `<div class=\"deaths\"><span>Saves</span>\n        ${[1,2,3].map(n=>`<span class=\"pip ${c.deathSaves.s>=n?\"s\":\"\"}\" data-death=\"s:${key}:${n}\"></span>`).join(\"\")}\n        <span style=\"margin-left:.3rem\">Fails</span>\n        ${[1,2,3].map(n=>`<span class=\"pip ${c.deathSaves.f>=n?\"f\":\"\"}\" data-death=\"f:${key}:${n}\"></span>`).join(\"\")}\n        <span class=\"grow\"></span>\n        <button type=\"button\" class=\"sm ghost\" data-death=\"off:${key}:0\">Stable</button></div>` : \"\";\n  const bits = [];\n  if (on(\"hp\")) bits.push(hpBlock(c));\n  else if (on(\"ac\")) bits.push(`<div class=\"stats\"><div class=\"stat\"><b>${c.ac===null?\"-\":c.ac}</b><span>AC</span></div></div>`);\n  return bits.join(\"\") + (!on(\"hp\") ? \"\" : `\n    <div class=\"dmg\">\n      <button type=\"button\" data-dmg=\"5:${key}\">-5</button>\n      <button type=\"button\" data-dmg=\"1:${key}\">-1</button>\n      <input type=\"number\" min=\"1\" max=\"999\" placeholder=\"n\" data-amt=\"${key}\" inputmode=\"numeric\">\n      <button type=\"button\" data-dmg=\"custom:${key}\">Hit</button>\n      <button type=\"button\" data-heal=\"custom:${key}\">Heal</button>\n    </div>`)\n    + `<div class=\"mini\">\n      ${on(\"hp\") ? `<div class=\"grow\"><label>Max</label><input type=\"number\" min=\"0\" max=\"999\" value=\"${c.hpMax??\"\"}\" data-set=\"max:${key}\"></div>\n      <div class=\"grow\"><label>Cur</label><input type=\"number\" min=\"0\" max=\"999\" value=\"${c.hpCur??\"\"}\" data-set=\"cur:${key}\"></div>` : \"\"}\n      ${on(\"hp\") && on(\"tempHp\") ? `<div class=\"grow\"><label>Temp</label><input type=\"number\" min=\"0\" max=\"999\" value=\"${c.tempHp||\"\"}\" data-set=\"temp:${key}\"></div>` : \"\"}\n      ${on(\"ac\") ? `<div class=\"grow\"><label>AC</label><input type=\"number\" min=\"0\" max=\"99\" value=\"${c.ac??\"\"}\" data-set=\"ac:${key}\"></div>` : \"\"}\n      ${on(\"initiative\") ? `<div class=\"grow\"><label>Init</label><input type=\"number\" min=\"-99\" max=\"99\" value=\"${c.initiative??\"\"}\" data-set=\"init:${key}\"></div>` : \"\"}\n    </div>`\n    + (tagChips(c) ? `<div class=\"chips\">${tagChips(c)}</div>` : \"\")\n    + `<div class=\"row\" style=\"margin-top:.45rem\">\n      ${on(\"conditions\") ? condSelect(kind, c.id) : \"\"}\n      ${on(\"exhaustion\") ? `<select class=\"sm\" data-exh=\"${key}\" style=\"padding:.3rem;font-size:.75rem\">${exhOpts}</select>` : \"\"}\n      ${on(\"concentration\") ? `<button type=\"button\" class=\"sm\" data-conc=\"toggle:${key}\">${c.concentration && c.concentration.on ? \"End conc.\" : \"Concentrating\"}</button>` : \"\"}\n      ${on(\"concentration\") && c.concentration && c.concentration.on\n        ? `<input class=\"sm\" style=\"flex:1;min-width:6rem;padding:.3rem;font-size:.75rem\" placeholder=\"on what?\" value=\"${esc(c.concentration.note||\"\")}\" data-concnote=\"${key}\">` : \"\"}\n      ${on(\"deathSaves\") && kind===\"seat\" ? `<button type=\"button\" class=\"sm\" data-death=\"on:${key}:0\">Death saves</button>` : \"\"}\n    </div>`\n    + prompt + deaths;\n}\n\nfunction seatCard(s){\n  const key = `seat:${s.id}`;\n  const req = (on(\"requests\") && s.request) ? `<div class=\"prompt\">Waiting on: ${esc(s.request.label)}\n      <button type=\"button\" class=\"sm\" data-cancelreq=\"${s.id}\">Cancel</button></div>` : \"\";\n  const statLine = CFG.stats.map(k => `${k} ${s.stats && s.stats[k] != null ? s.stats[k] : \"-\"}`).join(\"  \");\n  return `<div class=\"card ${s.connected?\"\":\"off\"} ${s.hpCur===0?\"down\":\"\"}\">\n    <header>\n      <span class=\"dot ${s.connected?\"on\":\"\"}\"></span>\n      <span class=\"nm\">${esc(s.name)}</span>\n      <span class=\"sc\">${s.code}</span>\n    </header>\n    <div class=\"res ${critClass(s.last)}\">${s.last ? s.last.total : \"-\"}</div>\n    <div class=\"sub\">${s.last ? detail(s.last) : \"no rolls yet\"}</div>\n    ${on(\"advantage\") ? `<div class=\"seg\">\n      <button type=\"button\" data-mode=\"dis:${s.id}\" ${s.mode===\"dis\"?'class=\"on\"':\"\"}>Disadv</button>\n      <button type=\"button\" data-mode=\"norm:${s.id}\" ${s.mode===\"norm\"?'class=\"on\"':\"\"}>Normal</button>\n      <button type=\"button\" data-mode=\"adv:${s.id}\" ${s.mode===\"adv\"?'class=\"on\"':\"\"}>Adv</button>\n    </div>` : \"\"}\n    <div class=\"row\" style=\"margin-top:.45rem\">\n      ${on(\"modifiers\") ? `<button type=\"button\" class=\"sm\" data-mod=\"-1:${s.id}\">-</button>\n      <output style=\"min-width:2.2rem;text-align:center;font-family:ui-sans-serif,system-ui,sans-serif;font-weight:700;font-size:.8125rem\">${s.mod>=0?\"+\":\"\"}${s.mod}</output>\n      <button type=\"button\" class=\"sm\" data-mod=\"1:${s.id}\">+</button>` : \"\"}\n      <span class=\"grow\"></span>\n      <button type=\"button\" class=\"sm\" data-rollfor=\"${key}\">Roll</button>\n      ${on(\"secretRolls\") ? `<button type=\"button\" class=\"sm\" data-secret=\"${key}\">Secret</button>` : \"\"}\n      ${on(\"requests\") ? `<button type=\"button\" class=\"sm\" data-ask=\"${s.id}\">Ask</button>` : \"\"}\n    </div>\n    ${req}\n    ${combatantControls(s, \"seat\")}\n    ${(on(\"stats\")||on(\"attacks\")) ? `<details><summary>Sheet</summary>\n      <p class=\"note\" style=\"margin:.4rem 0\">${on(\"stats\") ? (esc(statLine) || \"no stats yet\") : \"\"}${on(\"stats\")&&on(\"attacks\")?\"<br>\":\"\"}\n        ${on(\"attacks\") ? `Melee ${s.atk?s.atk.melee:0}, ranged ${s.atk?s.atk.ranged:0}, spell ${s.atk?s.atk.spell:0}` : \"\"}</p>\n      ${s.sheetLocked\n        ? `<button type=\"button\" class=\"sm\" data-unlock=\"${s.id}\">Let them re-enter it</button>`\n        : `<span class=\"note\">Unlocked, waiting on the player.</span>`}\n    </details>` : \"\"}\n  </div>`;\n}\n\nfunction actorCard(a){\n  const key = `actor:${a.id}`;\n  return `<div class=\"card ${a.hidden?\"hidden-actor\":\"\"} ${a.hpCur===0?\"down\":\"\"}\">\n    <header>\n      <span class=\"nm\">${esc(a.name)}</span>\n      <button type=\"button\" class=\"sm ghost\" data-reveal=\"${a.id}:${a.hidden?\"show\":\"hide\"}\">${a.hidden?\"Hidden\":\"Visible\"}</button>\n      <button type=\"button\" class=\"sm ghost\" data-rmactor=\"${a.id}\">x</button>\n    </header>\n    <div class=\"res ${critClass(a.last)}\">${a.last ? a.last.total : \"-\"}</div>\n    <div class=\"sub\">${a.last ? detail(a.last) : \"no rolls yet\"}</div>\n    <div class=\"row\" style=\"margin-top:.4rem\">\n      <button type=\"button\" class=\"sm\" data-rollfor=\"${key}\">Roll</button>\n      ${on(\"secretRolls\") ? `<button type=\"button\" class=\"sm\" data-secret=\"${key}\">Secret</button>` : \"\"}\n      <span class=\"grow\"></span>\n    </div>\n    ${combatantControls(a, \"actor\")}\n  </div>`;\n}\n\nfunction renderDM(m){\n  if (m.t !== \"dm\") return;\n  lastDM = m;\n  CONDS = m.conditions; EXH = m.exhaustion; CFG = m.config;\n  FEATLIST = m.featureList || FEATLIST;\n\n  // hide whole tabs and controls for anything switched off\n  document.querySelector('#dm-tabs [data-tab=\"foes\"]').classList.toggle(\"hide\", !on(\"monsters\"));\n  if (!on(\"monsters\") && $(\"pane-foes\").classList.contains(\"on\")) {\n    document.querySelector('#dm-tabs [data-tab=\"party\"]').click();\n  }\n  $(\"ask-all\").classList.toggle(\"hide\", !on(\"requests\"));\n  if (!on(\"requests\")) $(\"ask-panel\").classList.add(\"hide\");\n  document.querySelectorAll(\"[data-all]\").forEach(b => b.classList.toggle(\"hide\", !on(\"advantage\")));\n\n  // keep focus and caret if an update lands mid-edit\n  const act = document.activeElement;\n  const keep = act && act.dataset && (act.dataset.set || act.dataset.amt)\n    ? { sel: act.dataset.set ? `[data-set=\"${act.dataset.set}\"]` : `[data-amt=\"${act.dataset.amt}\"]`,\n        start: act.selectionStart, end: act.selectionEnd, value: act.value } : null;\n\n  $(\"dm-initbar\").innerHTML = on(\"initiative\") ? initBarHTML(m) : \"\";\n  $(\"dm-seats\").innerHTML = m.seats.map(seatCard).join(\"\");\n  $(\"dm-actors\").innerHTML = m.actors.length\n    ? m.actors.map(actorCard).join(\"\")\n    : `<p class=\"note\">No creatures yet.</p>`;\n\n  if (keep) {\n    const el = document.querySelector(keep.sel);\n    if (el) { el.value = keep.value; el.focus();\n      try { el.setSelectionRange(keep.start, keep.end); } catch {} }\n  }\n\n  $(\"dm-chips\").innerHTML = m.dmHistory.slice(0,16)\n    .map(r => `<span class=\"chip plain ${critClass(r)}\" title=\"${esc(detail(r).replace(/<[^>]+>/g,\"\"))}\">${r.total}</span>`).join(\"\");\n\n  const logRow = r => `<div>\n      <span class=\"who\">${esc(r.name)}</span>\n      <span class=\"det\">${detail(r)}</span>\n      <span class=\"tot ${critClass(r)}\">${r.total}</span></div>`;\n  $(\"dm-log\").innerHTML = m.log.length ? m.log.map(logRow).join(\"\")\n    : `<div><span class=\"who\" style=\"color:var(--faint)\">Nothing rolled yet.</span></div>`;\n  $(\"dm-secret\").innerHTML = m.secretLog.length ? m.secretLog.map(logRow).join(\"\")\n    : `<div><span class=\"who\" style=\"color:var(--faint)\">No secret rolls.</span></div>`;\n\n  syncDiceControls();\n  if (document.activeElement !== $(\"dm-seatcount\")) $(\"dm-seatcount\").value = m.seats.length;\n  if (document.activeElement !== $(\"cfg-stats\")) $(\"cfg-stats\").value = CFG.stats.join(\", \");\n  $(\"cfg-mode\").value = CFG.statMode;\n  if (!document.querySelector(\"#dm-feature-list input:focus\"))\n    featureCheckboxes(\"dm-feature-list\", CFG.features || {}, \"dmfeat\");\n  fillSelect($(\"cfg-init\"), [[\"\",\"nothing\"]].concat(CFG.stats.map(s=>[s,s])), CFG.initStat || \"\");\n}\n\n/* ---- DM interactions ---- */\n\nfunction parseKey(v){ const [kind,id] = v.split(\":\"); return { kind, id: kind===\"actor\"?Number(id):Number(id) }; }\n\n$(\"s-dm\").addEventListener(\"click\", e => {\n  const b = e.target.closest(\"button, [data-jump], [data-death], [data-cond]\");\n  if (!b) return;\n  const d = b.dataset;\n\n  if (d.init) {\n    if (d.init === \"start\") send({ t:\"initStart\" });\n    else if (d.init === \"stop\") { if (confirm(\"End combat and clear initiative?\")) send({ t:\"initStop\" }); }\n    else if (d.init === \"next\") send({ t:\"initTurn\", dir:\"next\" });\n    else if (d.init === \"prev\") send({ t:\"initTurn\", dir:\"prev\" });\n    else if (d.init === \"rollall\") send({ t:\"initRoll\", who:\"all\" });\n    return;\n  }\n  if (d.mode) { const [mode,id] = d.mode.split(\":\"); send({ t:\"mode\", seat:Number(id), mode }); return; }\n  if (d.all) { send({ t:\"modeAll\", mode:d.all }); return; }\n  if (d.mod) {\n    const [delta,id] = d.mod.split(\":\");\n    const s = lastDM.seats.find(x => x.id === Number(id));\n    send({ t:\"mod\", seat:Number(id), mod:(s?s.mod:0) + Number(delta) });\n    return;\n  }\n  if (d.dmg || d.heal) {\n    const heal = !!d.heal;\n    const [raw, kind, id] = (heal ? d.heal : d.dmg).split(\":\");\n    let amount;\n    if (raw === \"custom\") {\n      const box = document.querySelector(`[data-amt=\"${kind}:${id}\"]`);\n      amount = Math.abs(Math.trunc(Number(box && box.value)));\n      if (!amount) return;\n      box.value = \"\";\n    } else amount = Number(raw);\n    send({ t:\"damage\", kind, id:Number(id), amount: heal ? -amount : amount });\n    return;\n  }\n  if (d.rollfor) { const k = parseKey(d.rollfor); send({ t:\"rollFor\", kind:k.kind, id:k.id }); return; }\n  if (d.secret)  { const k = parseKey(d.secret);  send({ t:\"rollSecret\", kind:k.kind, id:k.id, label:\"secret\" }); return; }\n  if (d.ask !== undefined) { askFor(Number(d.ask)); return; }\n  if (d.cancelreq !== undefined) { send({ t:\"cancelRequest\", seat:Number(d.cancelreq) }); return; }\n  if (d.unlock !== undefined) { send({ t:\"unlock\", seat:Number(d.unlock) }); return; }\n  if (d.cond) {\n    const card = b.closest(\".card\");\n    const sel = card && card.querySelector(\"[data-addcond]\");\n    if (sel) { const k = parseKey(sel.dataset.addcond); send({ t:\"condition\", kind:k.kind, id:k.id, cond:d.cond, on:false }); }\n    return;\n  }\n  if (d.conc) {\n    const [what, kind, id] = d.conc.split(\":\");\n    const c = kind === \"seat\" ? lastDM.seats.find(x=>x.id===Number(id)) : lastDM.actors.find(x=>x.id===Number(id));\n    if (what === \"toggle\") {\n      const isOn = !(c && c.concentration && c.concentration.on);\n      send({ t:\"concentration\", kind, id:Number(id), on:isOn,\n             note: isOn && c && c.concentration ? (c.concentration.note || \"\") : \"\" });\n    } else if (what === \"drop\") {\n      send({ t:\"concentration\", kind, id:Number(id), on:false });\n      send({ t:\"clearPrompt\", kind, id:Number(id) });\n    } else {\n      send({ t:\"clearPrompt\", kind, id:Number(id) });\n    }\n    return;\n  }\n  if (d.death) {\n    const [what, kind, id, n] = d.death.split(\":\");\n    if (what === \"on\") send({ t:\"deathSaves\", kind, id:Number(id), active:true });\n    else if (what === \"off\") send({ t:\"deathSaves\", kind, id:Number(id), active:false, s:0, f:0 });\n    else {\n      const c = kind === \"seat\" ? lastDM.seats.find(x=>x.id===Number(id)) : lastDM.actors.find(x=>x.id===Number(id));\n      const cur = c ? c.deathSaves[what] : 0;\n      send({ t:\"deathSaves\", kind, id:Number(id), [what]: cur >= Number(n) ? Number(n)-1 : Number(n) });\n    }\n    return;\n  }\n  if (d.reveal) { const [id, want] = d.reveal.split(\":\"); send({ t:\"reveal\", id:Number(id), hidden: want===\"hide\" }); return; }\n  if (d.rmactor) { send({ t:\"removeActor\", id:Number(d.rmactor) }); return; }\n  if (d.jump !== undefined) { /* informational only */ return; }\n});\n\n$(\"s-dm\").addEventListener(\"change\", e => {\n  const t = e.target;\n  if (t.dataset.set) {\n    const [what, kind, id] = t.dataset.set.split(\":\");\n    const v = t.value === \"\" ? null : Number(t.value);\n    if (what === \"ac\") send({ t:\"ac\", kind, id:Number(id), ac:v });\n    else if (what === \"init\") send({ t:\"initSet\", kind, id:Number(id), value:v });\n    else send({ t:\"hp\", kind, id:Number(id), [what]: v });\n  } else if (t.dataset.addcond) {\n    if (!t.value) return;\n    const k = parseKey(t.dataset.addcond);\n    send({ t:\"condition\", kind:k.kind, id:k.id, cond:t.value, on:true });\n    t.value = \"\";\n  } else if (t.dataset.concnote) {\n    const [kind, id] = t.dataset.concnote.split(\":\");\n    send({ t:\"concentration\", kind, id:Number(id), on:true, note:t.value });\n  } else if (t.dataset.exh) {\n    const [kind, id] = t.dataset.exh.split(\":\");\n    send({ t:\"exhaustion\", kind, id:Number(id), level:Number(t.value) });\n  }\n});\n$(\"s-dm\").addEventListener(\"keydown\", e => {\n  if (e.key === \"Enter\" && e.target.closest(\"[data-set],[data-amt]\")) e.target.blur();\n});\n\nlet askTarget = \"all\", askMode = \"norm\";\n\nfunction askFor(seat){\n  askTarget = seat;\n  const who = seat === \"all\" ? \"everyone\" :\n    ((lastDM && lastDM.seats.find(s => s.id === seat) || {}).name || \"this seat\");\n  $(\"ask-target\").textContent = \"Ask \" + who;\n  const opts = [[\"\", \"nothing\"]]\n    .concat(on(\"stats\") ? CFG.stats.map(k => [k, k]) : [])\n    .concat(on(\"attacks\") ? [[\"melee\",\"melee\"],[\"ranged\",\"ranged\"],[\"spell\",\"spell\"]] : []);\n  fillSelect($(\"ask-bonus\"), opts, \"\");\n  $(\"ask-panel\").classList.remove(\"hide\");\n  $(\"ask-label\").focus();\n}\n$(\"ask-close\").addEventListener(\"click\", () => $(\"ask-panel\").classList.add(\"hide\"));\ndocument.querySelectorAll(\"[data-askmode]\").forEach(b =>\n  b.addEventListener(\"click\", () => {\n    askMode = b.dataset.askmode;\n    document.querySelectorAll(\"[data-askmode]\").forEach(o => o.classList.toggle(\"on\", o===b));\n  }));\nfunction askPayload(){\n  return {\n    label: $(\"ask-label\").value.trim() || \"Roll\",\n    bonusFrom: $(\"ask-bonus\").value || null,\n    mode: askMode,\n    dc: $(\"ask-dc\").value === \"\" ? null : Number($(\"ask-dc\").value),\n  };\n}\n$(\"ask-send\").addEventListener(\"click\", () => {\n  send({ t:\"request\", seat: askTarget, ...askPayload() });\n  $(\"ask-panel\").classList.add(\"hide\");\n});\n$(\"ask-now\").addEventListener(\"click\", () => {\n  const p = askPayload();\n  const targets = askTarget === \"all\"\n    ? (lastDM ? lastDM.seats.map(s => s.id) : [])\n    : [askTarget];\n  targets.forEach(id => send({ t:\"rollFor\", kind:\"seat\", id, label:p.label,\n                               bonusFrom:p.bonusFrom, mode:p.mode }));\n  $(\"ask-panel\").classList.add(\"hide\");\n});\n$(\"ask-all\").addEventListener(\"click\", () => askFor(\"all\"));\n$(\"group-roll\").addEventListener(\"click\", () => askFor(\"all\"));\n\n$(\"a-hidden\").addEventListener(\"click\", () => {\n  addHidden = !addHidden;\n  $(\"a-hidden\").classList.toggle(\"on\", addHidden);\n  $(\"a-hidden\").setAttribute(\"aria-pressed\", String(addHidden));\n  $(\"a-hidden\").textContent = addHidden ? \"Add hidden\" : \"Add visible\";\n});\n$(\"a-add\").addEventListener(\"click\", () => {\n  send({ t:\"addActors\", name:$(\"a-name\").value, count:Number($(\"a-count\").value)||1,\n         hp:$(\"a-hp\").value, ac:$(\"a-ac\").value, hidden:addHidden });\n  $(\"a-name\").value = \"\"; $(\"a-hp\").value = \"\"; $(\"a-ac\").value = \"\"; $(\"a-count\").value = 1;\n});\n$(\"reveal-all\").addEventListener(\"click\", () => send({ t:\"reveal\", id:\"all\" }));\n$(\"roll-foe-init\").addEventListener(\"click\", () => send({ t:\"initRoll\", who:\"actors\" }));\n$(\"clear-foes\").addEventListener(\"click\", () => { if (confirm(\"Remove every creature?\")) send({ t:\"clearActors\" }); });\n\ndocument.querySelectorAll(\"[data-dmmode]\").forEach(b =>\n  b.addEventListener(\"click\", () => {\n    dmMode = b.dataset.dmmode;\n    document.querySelectorAll(\"[data-dmmode]\").forEach(o => o.classList.toggle(\"on\", o===b));\n  }));\nfunction syncDiceControls(){\n  $(\"dm-count\").parentElement.classList.toggle(\"hide\", !on(\"multiDice\"));\n  $(\"dm-sides\").parentElement.classList.toggle(\"hide\", !on(\"otherDice\"));\n  $(\"dm-mod\").parentElement.classList.toggle(\"hide\", !on(\"modifiers\"));\n  document.querySelectorAll(\"[data-dmmode]\").forEach(b =>\n    b.parentElement.classList.toggle(\"hide\", !on(\"advantage\")));\n  $(\"p-count\").parentElement.classList.toggle(\"hide\", !on(\"multiDice\"));\n  $(\"p-sides\").parentElement.classList.toggle(\"hide\", !on(\"otherDice\"));\n  $(\"p-bonus\").parentElement.classList.toggle(\"hide\", !(on(\"stats\") || on(\"attacks\")));\n}\n\n$(\"dm-roll\").addEventListener(\"click\", () => send({\n  t:\"rollDM\", sides:Number($(\"dm-sides\").value), count:Number($(\"dm-count\").value)||1,\n  mode:dmMode, mod:Number($(\"dm-mod\").value)||0, label:$(\"dm-label\").value }));\n$(\"dm-seatcount\").addEventListener(\"change\", e => send({ t:\"seats\", n:Number(e.target.value) }));\n$(\"pane-setup\").addEventListener(\"click\", e => {\n  const b = e.target.closest(\"[data-dmfeat-all]\");\n  if (!b) return;\n  const v = b.dataset.dmfeatAll === \"1\";\n  const feats = {};\n  for (const k of Object.keys(FEATLIST)) feats[k] = v;\n  send({ t:\"config\", features: feats });\n});\n$(\"pane-setup\").addEventListener(\"change\", e => {\n  const k = e.target.dataset.dmfeat;\n  if (!k) return;\n  send({ t:\"config\", features: { [k]: e.target.checked } });\n});\n$(\"cfg-save\").addEventListener(\"click\", () => send({\n  t:\"config\", stats:$(\"cfg-stats\").value.split(\",\").map(s=>s.trim()).filter(Boolean),\n  statMode:$(\"cfg-mode\").value, initStat:$(\"cfg-init\").value || null }));\n$(\"dm-clear\").addEventListener(\"click\", () => { if (confirm(\"Clear every roll on this table?\")) send({ t:\"clear\" }); });\n\n/* ============================================================ player */\n\nlet pending = false, lastMe = null;\n\nfunction startPlayer(code, seat){\n  myRoom = code;\n  history.replaceState(null, \"\", \"#p=\" + code + \".\" + seat);\n  show(\"player\");\n  fillSelect($(\"p-sides\"), DICE.map(d => [d, \"d\"+d]), 20);\n  resize();\n  connect(wsURL(`code=${code}&role=player&seat=${seat}`), renderPlayer, $(\"p-status\"));\n}\n\nfunction renderPlayer(m){\n  if (m.t !== \"me\") return;\n  lastMe = m;\n  CONDS = m.conditions; EXH = m.exhaustion; CFG = m.config;\n  FEATLIST = m.featureList || FEATLIST;\n  syncDiceControls();\n  const s = m.seat;\n\n  $(\"p-name\").textContent = s.name;\n  if (document.activeElement !== $(\"p-rename\")) $(\"p-rename\").value = s.name;\n\n  // turn order\n  const i = m.initiative;\n  if (on(\"initiative\") && i.active && i.order.length) {\n    const chips = i.order.map(e => {\n      const cls = [\"turnchip\", (i.current && i.current.kind===e.kind && i.current.id===e.id)?\"now\":\"\",\n                   e.me?\"mine\":\"\", e.kind===\"actor\"?\"foe\":\"\"].filter(Boolean).join(\" \");\n      return `<div class=\"${cls}\"><b>${esc(e.name)}</b><i>${e.value}</i></div>`;\n    }).join(\"\");\n    $(\"p-turnbar\").innerHTML = `<div class=\"initbar\">\n      <div class=\"head\"><span class=\"round\">Round ${i.round}</span>\n      ${i.current && i.current.mine ? '<span class=\"round\" style=\"color:var(--good)\">Your turn</span>' : \"\"}</div>\n      <div class=\"order\">${chips}</div></div>`;\n  } else $(\"p-turnbar\").innerHTML = \"\";\n\n  // roll request\n  const rq = $(\"p-request\");\n  if (on(\"requests\") && m.request) {\n    rq.classList.remove(\"hide\");\n    rq.innerHTML = `Your DM asks for: <b>${esc(m.request.label)}</b>${m.request.bonusFrom?` (adds ${esc(m.request.bonusFrom)})`:\"\"}`;\n  } else rq.classList.add(\"hide\");\n\n  const b = $(\"p-banner\");\n  const showBanner = on(\"advantage\") || (on(\"modifiers\") && s.mod);\n  b.classList.toggle(\"hide\", !showBanner);\n  b.className = \"banner \" + (s.mode === \"norm\" ? \"\" : s.mode) + (showBanner ? \"\" : \" hide\");\n  b.textContent = MODE_LABEL[s.mode] + (on(\"modifiers\") && s.mod ? `, ${s.mod>0?\"+\":\"\"}${s.mod}` : \"\");\n\n  // sheet\n  const anySheet = on(\"hp\") || on(\"ac\") || on(\"stats\") || on(\"attacks\");\n  const form = $(\"p-sheetform\");\n  form.classList.toggle(\"hide\", s.sheetLocked || !anySheet);\n  $(\"p-sheet\").classList.toggle(\"hide\", !s.sheetLocked || !anySheet);\n  form.querySelectorAll(\"[id^='p-hp'],#p-ac\").forEach(el =>\n    el.parentElement.classList.toggle(\"hide\", el.id === \"p-ac\" ? !on(\"ac\") : !on(\"hp\")));\n  [\"p-melee\",\"p-ranged\",\"p-spell\"].forEach(id =>\n    $(id).parentElement.classList.toggle(\"hide\", !on(\"attacks\")));\n  $(\"p-statinputs\").classList.toggle(\"hide\", !on(\"stats\"));\n  if (!s.sheetLocked && on(\"stats\") && $(\"p-statinputs\").childElementCount !== CFG.stats.length) {\n    $(\"p-statinputs\").innerHTML = CFG.stats.map(k =>\n      `<div style=\"flex:1;min-width:3.4rem\"><label>${esc(k)}</label>\n       <input type=\"number\" data-stat=\"${esc(k)}\" inputmode=\"numeric\"></div>`).join(\"\");\n  }\n  if (s.sheetLocked) {\n    const conc = s.concentration && s.concentration.on;\n    const deaths = on(\"deathSaves\") && s.deathSaves && s.deathSaves.active\n      ? `<div class=\"deaths\"><span>Saves</span>\n          ${[1,2,3].map(n=>`<span class=\"pip ${s.deathSaves.s>=n?\"s\":\"\"}\"></span>`).join(\"\")}\n          <span style=\"margin-left:.3rem\">Fails</span>\n          ${[1,2,3].map(n=>`<span class=\"pip ${s.deathSaves.f>=n?\"f\":\"\"}\"></span>`).join(\"\")}</div>` : \"\";\n    $(\"p-sheet\").innerHTML = (on(\"hp\") || on(\"ac\") ? hpBlock(s) : \"\")\n      + `<div class=\"chips\">${tagChips(s)}</div>` + deaths\n      + (conc && on(\"concentration\") ? `<button type=\"button\" class=\"sm\" id=\"p-endconc\" style=\"margin-top:.45rem\">Stop concentrating</button>` : \"\")\n      + `<p class=\"note\">Your DM adjusts these.</p>`;\n    const ec = $(\"p-endconc\");\n    if (ec) ec.addEventListener(\"click\", () => send({ t:\"concentrationEnd\" }));\n  }\n\n  // bonus dropdown\n  const opts = [[\"\", \"nothing\"]]\n    .concat(on(\"stats\") ? CFG.stats.map(k => [k, k]) : [])\n    .concat(on(\"attacks\") ? [[\"melee\",\"melee attack\"],[\"ranged\",\"ranged attack\"],[\"spell\",\"spell attack\"]] : []);\n  if ($(\"p-bonus\").options.length !== opts.length) fillSelect($(\"p-bonus\"), opts, \"\");\n  $(\"p-dicerow\").classList.toggle(\"hide\", !!m.request);\n\n  $(\"p-chips\").innerHTML = s.history.slice(0,16)\n    .map(r => `<span class=\"chip plain ${critClass(r)}\" title=\"${esc(detail(r).replace(/<[^>]+>/g,\"\"))}\">${r.total}</span>`).join(\"\");\n\n  const latest = s.history[0];\n  if (latest && pending) {\n    pending = false;\n    const finish = () => {\n      $(\"p-total\").textContent = latest.total;\n      $(\"p-total\").className = \"total \" + critClass(latest);\n      $(\"p-break\").innerHTML = detail(latest);\n      $(\"p-roll\").disabled = false;\n    };\n    if (latest.sides === 20 && latest.count === 1) animateTo(latest.kept, finish);\n    else finish();\n  } else if (latest && $(\"p-total\").textContent.trim() === \"\") {\n    if (latest.sides === 20 && latest.count === 1) {\n      orientation = qFaceForward(faceOf(latest.kept), 0); draw();\n    }\n    $(\"p-total\").textContent = latest.total;\n    $(\"p-total\").className = \"total \" + critClass(latest);\n    $(\"p-break\").innerHTML = detail(latest);\n  }\n}\n\nfunction playerRoll(){\n  if (pending || !sock || sock.readyState !== 1) return;\n  pending = true;\n  $(\"p-roll\").disabled = true;\n  $(\"p-total\").textContent = \"\"; $(\"p-total\").className = \"total\";\n  $(\"p-break\").innerHTML = \"&nbsp;\";\n  send({ t:\"roll\", sides:Number($(\"p-sides\").value)||20,\n         count:Number($(\"p-count\").value)||1, bonusFrom:$(\"p-bonus\").value || null });\n}\n$(\"p-roll\").addEventListener(\"click\", playerRoll);\ncanvas.addEventListener(\"click\", playerRoll);\ncanvas.addEventListener(\"keydown\", e => {\n  if (e.key === \"Enter\" || e.key === \" \") { e.preventDefault(); playerRoll(); }\n});\n$(\"p-save\").addEventListener(\"click\", () => {\n  const v = $(\"p-rename\").value.trim();\n  if (v) send({ t:\"name\", name:v });\n});\n$(\"p-savesheet\").addEventListener(\"click\", () => {\n  const num = id => $(id).value === \"\" ? null : Number($(id).value);\n  const stats = {};\n  document.querySelectorAll(\"[data-stat]\").forEach(i => {\n    stats[i.dataset.stat] = i.value === \"\" ? null : Number(i.value);\n  });\n  send({ t:\"sheet\", hpMax:num(\"p-hpmax\"), hpCur:num(\"p-hpcur\"), ac:num(\"p-ac\"), stats,\n         atk:{ melee:num(\"p-melee\")||0, ranged:num(\"p-ranged\")||0, spell:num(\"p-spell\")||0 } });\n});\n\n/* ============================================================ boot */\n\npaintThemePickers();\nwindow.addEventListener(\"resize\", resize);\nnew ResizeObserver(resize).observe(canvas);\n\n(function restore(){\n  const h = location.hash;\n  let m;\n  if ((m = h.match(/^#dm=([A-Z2-9]{5})$/))) {\n    let tok = null;\n    try { tok = localStorage.getItem(\"dice-dm-\" + m[1]); } catch {}\n    if (tok) { startDM(m[1], tok); return; }\n  }\n  if ((m = h.match(/^#p=([A-Z2-9]{5})\\.([A-Z2-9]{4})$/))) startPlayer(m[1], m[2]);\n})();\n\n</script>\n</body>\n</html>\n";
