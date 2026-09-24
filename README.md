# Dice Table

A shared d20 table. The DM sets advantage and disadvantage and sees every
roll. Players see only their own.

***

## Why this needs a server

The single-file roller works entirely in the browser. This one cannot,
for two reasons.

**Hiding rolls in the browser is not hiding them.** Anything sent to a
player's browser can be read in devtools, whatever the interface shows.
The only real enforcement is a server that never sends a player another
player's result in the first place. That is what this does: a player
socket receives their own seat and nothing else. No other seat's name,
mode, modifier, or result is in the payload.

**Rolling in the browser can be edited.** Dice are rolled inside the
Durable Object and pushed out. The client animates a number it was given
and has no say in it.

***

## Running it

    npm install
    npx wrangler dev        # local, at http://127.0.0.1:8787
    npx wrangler deploy     # live, at dice-table.<your-subdomain>.workers.dev

This is a Worker, not a static Pages site, because it needs Durable
Objects. Deploy with `wrangler deploy` rather than dragging a folder.

SQLite-backed Durable Objects are on the Workers free plan. A table for a
weekly group sits far inside the free limits.

**If wrangler rejects the `exports` block**, your version predates the
current syntax. Either update wrangler, or replace that block with the
legacy equivalent:

    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Table"] }]

***

## How a session runs

1. The DM opens the site, chooses **Start a table**, picks a player count.
2. They get a 5-character table code and a 4-character seat code per seat.
3. Each player gets the table code plus their own seat code, and joins.
4. The DM sets advantage or disadvantage per seat, or for everyone at once.
5. Players tap their die. The DM sees every result; players see only theirs.

The DM link is held in that browser's localStorage. Opening the same
browser again restores the table from the address bar. **There is no
recovery if that browser data is cleared**, so for a long campaign,
note the table code and DM token somewhere.

***

## What each role can do

| | DM | Player |
|---|---|---|
| Roll own die | yes | yes |
| Roll for a seat | yes | no |
| Set advantage or disadvantage | yes, any seat | no |
| Set a seat modifier | yes | no |
| Change seat count | yes | no |
| Rename | any seat | own seat only |
| See own rolls | yes | yes |
| See other rolls | yes, all | no |
| Clear history | yes | no |

A player asking the server to change their own mode is ignored rather
than rejected loudly. Advantage is the DM's call.

***

## Limits and honest edges

- **Anyone holding a seat code can take that seat.** Seat codes are the
  only thing standing between a table and a stranger. They are per seat
  rather than shared, so one leaked code does not open the whole table,
  but treat them like a door key.
- **The DM token is a bearer secret.** Anyone with it is the DM.
- **Up to 12 seats**, 40 rolls of history per seat, 200 in the DM log.
- **No accounts, no email, nothing stored about a person** beyond the
  display name a player types.
- A table persists in Durable Object storage until Cloudflare's storage
  is cleared. There is no automatic expiry, so delete the Worker if you
  want the data gone.

***

## Randomness

Server side, in `src/index.js`:

    const LIMIT = Math.floor(0x100000000 / 20) * 20;

`crypto.getRandomValues` draws from the OS entropy pool. The rejection
sampling matters as much: 2^32 is not divisible by 20, so a plain modulo
would make the low faces very slightly more likely. Draws landing in the
short tail are discarded and retried, about once in ten million rolls.

This is a cryptographically secure pseudorandom generator seeded from
real system entropy, not a physical random source. It is unpredictable in
any practical sense, but that is the accurate description.

***

## Files

    src/index.js       Worker routing plus the Table Durable Object
    public/index.html  Client. Landing, DM view, player view, die renderer
    wrangler.jsonc     Bindings and Durable Object class declaration
    e2e.mjs            End to end tests, including the isolation checks

Run the tests against a local dev server:

    npx wrangler dev &
    node e2e.mjs
