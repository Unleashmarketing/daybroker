# Alpaca Trading Proxy (v2) — Paper account, order placement from anywhere

This is a Cloudflare Worker, the same kind of thing as your current read-only
proxy at `green-pond-4423.dung-78d.workers.dev`. This version adds the
ability to place, read and cancel orders, so Claude can do it for you from
your phone — no Mac needed.

It is hardcoded to Alpaca's **paper** endpoint (`paper-api.alpaca.markets`).
Going live would mean deliberately editing `ALPACA_BASE` in `worker.js` and
redeploying — it can't happen by accident.

## 1. Create the GitHub repo

1. On github.com, create a new **private** repo, e.g. `alpaca-trading-proxy`.
2. Add these three files to it: `worker.js`, `wrangler.toml`, this `README.md`.
3. Commit and push.

## 2. Connect it to Cloudflare

Easiest path — Cloudflare dashboard Git integration:

1. Go to the Cloudflare dashboard -> Workers & Pages -> Create -> Workers -> "Import a repository" (or "Connect to Git").
2. Pick your new GitHub repo. Cloudflare will detect `wrangler.toml` and `worker.js` automatically.
3. Deploy. You'll get a URL like `https://alpaca-trading-proxy.<your-subdomain>.workers.dev`.

Alternative — the `wrangler` CLI, if you'd rather do it from a terminal:

```bash
npm install -g wrangler
wrangler login
wrangler deploy
```

## 3. Set the three secrets

Do this once, after the first deploy (dashboard: Worker -> Settings ->
Variables and Secrets -> Add; or CLI):

```bash
wrangler secret put ALPACA_KEY_ID
wrangler secret put ALPACA_SECRET_KEY
wrangler secret put PROXY_TOKEN
```

- `ALPACA_KEY_ID` / `ALPACA_SECRET_KEY`: your **paper** trading API keys from
  the Alpaca dashboard (app.alpaca.markets -> API Keys, paper account
  PA3GLIHTY). These are different from any live-account keys.
- `PROXY_TOKEN`: a secret only you (and Claude, when you give it the URL)
  know. You can reuse the token your existing read-only proxy uses
  (`may7f7ucYNtugBfRDuusQIAn8R4ObPO0EZC-n4YdwYA`) so nothing else you've
  already set up needs to change, or pick a new one — your call.

## 4. Endpoints

All requests need `Authorization: Bearer <PROXY_TOKEN>`.

| Method | Path | What |
|---|---|---|
| GET | `/account` | account info (cash, equity, buying power) |
| GET | `/positions` | open positions |
| GET | `/orders` | order history (`?status=open\|closed\|all&limit=50`) |
| POST | `/orders` | place an order |
| DELETE | `/orders/:id` | cancel one open order |
| DELETE | `/orders` | cancel **all** open orders |

### Placing an order

`POST /orders` takes the exact JSON shape `trader-budget` already writes to
`trader/orders.json` — no translation needed:

```bash
curl -s -X POST https://<your-worker>.workers.dev/orders \
  -H "Authorization: Bearer <PROXY_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "CPRT",
    "side": "buy",
    "qty": "124",
    "type": "market",
    "time_in_force": "day",
    "order_class": "bracket",
    "take_profit_limit_price": "30.83",
    "stop_loss_stop_price": "29.84"
  }'
```

The worker only does basic sanity checks (symbol/side/qty present, a stop
required for a bracket order). It does **not** replace `trader-risk` — that
check still has to pass, and you still have to say "yes" in the chat, before
this endpoint is ever called. The gate belongs upstream of the proxy, same
as before.

## 5. How Claude uses this from your phone

Once this is deployed and you give Claude the new URL + token (the same way
you gave it the read-only one), the flow for a trade becomes:

1. `/trader-scanner`, `/trader-news`, `/trader-entry`, `/trader-exit`,
   `/trader-timemachine`, `/trader-budget`, `/trader-risk` — same as always,
   ending in a PASS and a proposed order.
2. Claude shows you the order ticket and asks for your explicit yes.
3. You type "yes" (or similar) in the chat, from your phone.
4. Claude calls `POST /orders` on this proxy. Alpaca fills it (or rejects it,
   e.g. if the market's closed).
5. Claude reads back the result: filled, price, or the rejection reason.

No Mac, no Alpaca app needed for this part.

## On "it should also be able to place orders automatically" (later)

Worth flagging before we build that: everything above still has a human
(you) saying yes to one specific order, every time — that's the same safety
model the trader skills already use (`trader-risk` PASS + your explicit yes
+ a manual approval click on the order tool, never "always allow"). Fully
automatic placement — Claude deciding and firing an order with nobody
checking it first — is a different, bigger decision: it means trusting the
scanner's setups and the risk limits alone to catch everything, with no
human catching a bad edge case before money (even paper money) moves.

When you're ready for that, it's worth a separate conversation about what
"automatic" should mean in practice — e.g. only within tight, pre-approved
limits (ticker allowlist, max position size, max trades/day — all of which
`trader-risk` already enforces), only during specific hours, and probably
still with a notification after every fill rather than silence. Happy to
design that with you once you've used the manual-with-one-yes version for a
while and trust it.
