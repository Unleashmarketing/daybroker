/**
 * Dung's Alpaca Trading Proxy — v2
 *
 * Read endpoints (as before):
 *   GET  /account             -> Alpaca GET /v2/account
 *   GET  /positions           -> Alpaca GET /v2/positions
 *   GET  /orders              -> Alpaca GET /v2/orders   (?status=open|closed|all, ?limit=, ?after=, ?until=)
 *
 * New write endpoints (gated by the same bearer token):
 *   POST   /orders            -> Alpaca POST /v2/orders   (place an order)
 *   DELETE /orders/:id        -> Alpaca DELETE /v2/orders/:id  (cancel one open order)
 *   DELETE /orders            -> Alpaca DELETE /v2/orders      (cancel ALL open orders — use with care)
 *
 * Safety:
 *   - Hardcoded to Alpaca's PAPER endpoint (paper-api.alpaca.markets). To ever go live you would
 *     have to deliberately change ALPACA_BASE below and re-deploy — it can never happen by accident.
 *   - Every request needs "Authorization: Bearer <PROXY_TOKEN>" (your own secret, not the Alpaca keys).
 *   - POST /orders accepts the same flat JSON shape trader-budget already writes to trader/orders.json
 *     (symbol, side, qty, type, time_in_force, order_class, take_profit_limit_price, stop_loss_stop_price,
 *     limit_price) and translates it into Alpaca's nested bracket-order shape. No transformation needed
 *     on the Claude side — the exact file trader-budget writes can be POSTed here as-is.
 *   - Does basic sanity checks only (symbol/side/qty present, a stop required for a bracket order). It does
 *     NOT replace trader-risk — that check must still pass, and a human must still say "yes" in chat, before
 *     this is ever called. This proxy will do exactly what it's told, so the gate belongs upstream of it.
 */

const ALPACA_BASE = "https://paper-api.alpaca.markets"; // PAPER ONLY. Never point this at api.alpaca.markets without re-reading the warning above.

function alpacaHeaders(env) {
  return {
    "APCA-API-KEY-ID": env.ALPACA_KEY_ID,
    "APCA-API-SECRET-KEY": env.ALPACA_SECRET_KEY,
    "Content-Type": "application/json",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function unauthorized() {
  return json({ error: "unauthorized" }, 401);
}

function checkAuth(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const expected = `Bearer ${env.PROXY_TOKEN}`;
  return auth === expected;
}

// Translate the flat trader-budget order shape into Alpaca's native nested shape.
function buildAlpacaOrderBody(input) {
  const body = {
    symbol: input.symbol,
    side: input.side,
    type: input.type || "market",
    time_in_force: input.time_in_force || "day",
  };

  if (input.qty !== undefined) body.qty = String(input.qty);
  if (input.notional !== undefined) body.notional = String(input.notional);
  if (input.limit_price !== undefined) body.limit_price = String(input.limit_price);
  if (input.stop_price !== undefined) body.stop_price = String(input.stop_price);
  if (input.client_order_id) body.client_order_id = input.client_order_id;
  if (input.extended_hours !== undefined) body.extended_hours = input.extended_hours;

  const orderClass = input.order_class || "simple";
  if (orderClass !== "simple") {
    body.order_class = orderClass;
  }

  if (orderClass === "bracket" || orderClass === "oto") {
    if (input.take_profit_limit_price !== undefined) {
      body.take_profit = { limit_price: String(input.take_profit_limit_price) };
    }
    if (input.stop_loss_stop_price !== undefined) {
      body.stop_loss = {
        stop_price: String(input.stop_loss_stop_price),
        ...(input.stop_loss_limit_price !== undefined
          ? { limit_price: String(input.stop_loss_limit_price) }
          : {}),
      };
    }
  }

  return body;
}

function validateOrderInput(input) {
  const errors = [];
  if (!input.symbol) errors.push("symbol is required");
  if (!input.side || !["buy", "sell"].includes(input.side)) errors.push("side must be buy or sell");
  if (input.qty === undefined && input.notional === undefined) errors.push("qty or notional is required");
  if (input.qty !== undefined && input.notional !== undefined) errors.push("give qty or notional, not both");

  const orderClass = input.order_class || "simple";
  if (orderClass === "bracket") {
    if (input.stop_loss_stop_price === undefined) errors.push("bracket order needs stop_loss_stop_price");
    if (input.take_profit_limit_price === undefined) errors.push("bracket order needs take_profit_limit_price");
  }
  if ((input.type || "market") === "limit" && input.limit_price === undefined) {
    errors.push("limit order needs limit_price");
  }
  return errors;
}

export default {
  async fetch(request, env) {
    if (!checkAuth(request, env)) return unauthorized();

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method;

    try {
      // --- GET /account ---
      if (method === "GET" && path === "/account") {
        const r = await fetch(`${ALPACA_BASE}/v2/account`, { headers: alpacaHeaders(env) });
        return new Response(await r.text(), { status: r.status, headers: { "Content-Type": "application/json" } });
      }

      // --- GET /positions ---
      if (method === "GET" && path === "/positions") {
        const r = await fetch(`${ALPACA_BASE}/v2/positions`, { headers: alpacaHeaders(env) });
        return new Response(await r.text(), { status: r.status, headers: { "Content-Type": "application/json" } });
      }

      // --- GET /orders (history / open orders) ---
      if (method === "GET" && path === "/orders") {
        const qs = url.searchParams.toString();
        const r = await fetch(`${ALPACA_BASE}/v2/orders${qs ? `?${qs}` : "?status=all&limit=50"}`, {
          headers: alpacaHeaders(env),
        });
        return new Response(await r.text(), { status: r.status, headers: { "Content-Type": "application/json" } });
      }

      // --- POST /orders (place an order) ---
      if (method === "POST" && path === "/orders") {
        let input;
        try {
          input = await request.json();
        } catch {
          return json({ error: "body must be JSON" }, 400);
        }

        const errors = validateOrderInput(input);
        if (errors.length) return json({ error: "invalid order", details: errors }, 400);

        const body = buildAlpacaOrderBody(input);
        const r = await fetch(`${ALPACA_BASE}/v2/orders`, {
          method: "POST",
          headers: alpacaHeaders(env),
          body: JSON.stringify(body),
        });
        const text = await r.text();
        return new Response(text, { status: r.status, headers: { "Content-Type": "application/json" } });
      }

      // --- DELETE /orders/:id (cancel one order) ---
      const cancelOneMatch = path.match(/^\/orders\/([A-Za-z0-9-]+)$/);
      if (method === "DELETE" && cancelOneMatch) {
        const orderId = cancelOneMatch[1];
        const r = await fetch(`${ALPACA_BASE}/v2/orders/${orderId}`, {
          method: "DELETE",
          headers: alpacaHeaders(env),
        });
        const text = await r.text();
        return new Response(text || JSON.stringify({ ok: r.ok, status: r.status }), {
          status: r.status,
          headers: { "Content-Type": "application/json" },
        });
      }

      // --- DELETE /orders (cancel ALL open orders) ---
      if (method === "DELETE" && path === "/orders") {
        const r = await fetch(`${ALPACA_BASE}/v2/orders`, {
          method: "DELETE",
          headers: alpacaHeaders(env),
        });
        const text = await r.text();
        return new Response(text || JSON.stringify({ ok: r.ok, status: r.status }), {
          status: r.status,
          headers: { "Content-Type": "application/json" },
        });
      }

      return json({ error: "not found", path, method }, 404);
    } catch (err) {
      return json({ error: "proxy error", message: String(err) }, 500);
    }
  },
};
