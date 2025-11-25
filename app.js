const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const pool = require("./db"); // pool Postgres

const app = express();
const RESET_TOKEN = "LAPERLE_RESET_2024";

// ------------------ MIDDLEWARE ------------------
app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

// NON serve app.options("*", ...) – la CORS middleware sopra gestisce già le OPTIONS
app.use(express.json());


// dashboard statica
app.use("/dashboard", express.static(path.join(__dirname, "dashboard")));

// ------------------ UTILS ------------------
function anonymizeIp(ip) {
  if (!ip) return "";
  const parts = ip.split(".");
  if (parts.length === 4) {
    parts[3] = "0";
    return parts.join(".");
  }
  return ip;
}

// ------------------ /collect: riceve gli eventi dal tema Shopify ------------------
app.post("/collect", async (req, res) => {
  const clientIp =
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.socket.remoteAddress ||
    "";

  const entry = {
    occurred_at: new Date().toISOString(),
    ip: anonymizeIp(clientIp),
    userAgent: req.headers["user-agent"] || "",
    payload: req.body || {},
  };

  console.log("Evento /collect:", entry.payload?.type, entry.payload?.url || "");

  try {
    await pool.query(
      `INSERT INTO events (occurred_at, ip, user_agent, payload)
       VALUES ($1, $2, $3, $4)`,
      [entry.occurred_at, entry.ip, entry.userAgent, entry.payload]
    );
  } catch (err) {
    console.error("Errore inserendo evento in Postgres:", err);
    // non blocchiamo il browser
  }

  res.status(204).end();
});

// ------------------ helper: leggi ultimi N eventi ------------------
async function readLastEvents(limit = null) {
  let query = `
    SELECT occurred_at, ip, user_agent, payload
    FROM events
    ORDER BY occurred_at DESC
  `;
  const params = [];

  if (limit) {
    query += " LIMIT $1";
    params.push(limit);
  }

  const result = await pool.query(query, params);

  return result.rows.map((row) => ({
    receivedAt: row.occurred_at,
    ip: row.ip,
    userAgent: row.user_agent,
    payload: row.payload,
  }));
}

// ------------------ /api/events: per la tabella in basso ------------------
app.get("/api/events", async (req, res) => {
  const limit = Number(req.query.limit) || 300;
  const range = req.query.range || null; // opzionale, tipo '7d', '30d'

  const ranges = {
    "7d": "NOW() - INTERVAL '7 days'",
    "30d": "NOW() - INTERVAL '30 days'",
    "90d": "NOW() - INTERVAL '90 days'",
    "180d": "NOW() - INTERVAL '180 days'",
    "365d": "NOW() - INTERVAL '365 days'",
  };

  try {
    let whereClause = "";
    const params = [limit];

    if (range && ranges[range]) {
      whereClause = `WHERE occurred_at >= ${ranges[range]}`;
    }

    const query = `
      SELECT occurred_at, ip, user_agent, payload
      FROM events
      ${whereClause}
      ORDER BY occurred_at DESC
      LIMIT $1
    `;

    const result = await pool.query(query, params);

    const events = result.rows.map((row) => ({
      receivedAt: row.occurred_at,
      ip: row.ip,
      userAgent: row.user_agent,
      payload: row.payload,
    }));

    res.json(events);
  } catch (err) {
    console.error("Errore in /api/events:", err);
    res.status(500).json({ ok: false });
  }
});

// ------------------ /api/summary: numeri per la dashboard ------------------
app.get("/api/summary", async (req, res) => {
  try {
    // leggi al massimo 500 eventi recenti per evitare di saturare la memoria
    const events = await readLastEvents(500);

    const stats = {
      totalEvents: events.length,

      // funnel
      pageviews: 0,
      timeonpageEvents: 0,
      productViews: 0,
      addToCart: 0,
      purchases: 0,

      // visitatori / sessioni
      uniqueSessions: new Set(),
      uniqueVisitors: new Set(),
      newVisitors: 0,
      returningVisitors: 0,

      // device
      devices: { desktop: 0, mobile: 0, tablet: 0, other: 0 },

      // blocchi dashboard
      topPages: {},
      referrers: {},
      utmCombos: {},
      checkoutSteps: { cart: 0, checkout: 0, shipping: 0, payment: 0, thankyou: 0 },
      activeCartsByVisitor: new Map(),
      productCategories: {},
      gramsViews: {},
      mediaInteractions: {},
      countries: {},
      formStats: {},
      jsErrors: 0,
      paymentErrors: 0,
      perfSamples: [],
    };

    events.forEach((ev) => {
      const p = ev.payload || {};
      const type = p.type;
      const sessionId = p.sessionId || null;
      const visitorId = p.visitorId || null;
      const isNewVisitor = p.isNewVisitor === true;
      const path = p.path || p.url || "";
      const ref = p.referrer || "";
      const utmSource = p.utm_source || "";
      const utmMedium = p.utm_medium || "";
      const utmCampaign = p.utm_campaign || "";
      const deviceType = p.deviceType || "other";

      if (sessionId) stats.uniqueSessions.add(sessionId);
      if (visitorId) stats.uniqueVisitors.add(visitorId);

      // nuovi vs di ritorno (conteggiati sulle pageview)
      if (type === "pageview") {
        if (isNewVisitor) stats.newVisitors++;
        else stats.returningVisitors++;
      }

      // device
      if (deviceType === "desktop" || deviceType === "mobile" || deviceType === "tablet") {
        stats.devices[deviceType]++;
      } else {
        stats.devices.other++;
      }

      // top pages
      if (path) {
        stats.topPages[path] = (stats.topPages[path] || 0) + 1;
      }

      // referrer solo sulle pageview
      if (type === "pageview") {
        let key = "Direct / none";
        if (ref && ref !== "") {
          try {
            const url = new URL(ref);
            key = url.hostname;
          } catch (e) {
            key = ref;
          }
        }
        stats.referrers[key] = (stats.referrers[key] || 0) + 1;
      }

      // UTM solo sulle pageview
      if (type === "pageview") {
        const s = utmSource || "(none)";
        const m = utmMedium || "(none)";
        const c = utmCampaign || "(none)";
        const comboKey = `${s}|${m}|${c}`;
        stats.utmCombos[comboKey] = (stats.utmCombos[comboKey] || 0) + 1;
      }

      // conteggi funnel
      if (type === "pageview") stats.pageviews++;
      else if (type === "timeonpage") stats.timeonpageEvents++;
      else if (type === "view_product") stats.productViews++;
      else if (type === "add_to_cart") stats.addToCart++;
      else if (type === "purchase") stats.purchases++;

      // checkout steps
      if (type === "checkout_step") {
        const step = p.step || "checkout";
        if (stats.checkoutSteps[step] !== undefined) {
          stats.checkoutSteps[step]++;
        }
      }

      // carrelli attivi reali
      if (type === "cart_state" && visitorId) {
        const items = Array.isArray(p.items) ? p.items : [];
        stats.activeCartsByVisitor.set(visitorId, items);
      }

      // prodotti: categorie e grammi
      if (type === "view_product") {
        const cat = p.productCategory || "Altro";
        const grams = p.grams || 0;
        stats.productCategories[cat] = (stats.productCategories[cat] || 0) + 1;
        const gramsKey = String(grams);
        stats.gramsViews[gramsKey] = (stats.gramsViews[gramsKey] || 0) + 1;
      }

      // media interaction
      if (type === "media_interaction") {
        const key = `${p.mediaType || "media"}:${p.action || "action"}`;
        stats.mediaInteractions[key] = (stats.mediaInteractions[key] || 0) + 1;
      }

      // geo
      if (p.country) {
        stats.countries[p.country] = (stats.countries[p.country] || 0) + 1;
      }

      // form
      if (type === "form_interaction") {
        const formId = p.formId || "generic";
        const action = p.action || "submit";
        const key = `${formId}:${action}`;
        stats.formStats[key] = (stats.formStats[key] || 0) + 1;
      }

      // errori JS / pagamenti
      if (type === "js_error") {
        stats.jsErrors++;
        const msg = (p.message || "").toLowerCase();
        if (msg.includes("payment") || msg.includes("stripe") || msg.includes("paypal")) {
          stats.paymentErrors++;
        }
      }

      // performance
      if (type === "perf_metric") {
        stats.perfSamples.push({
          lcp: typeof p.lcp === "number" ? p.lcp : null,
          fcp: typeof p.fcp === "number" ? p.fcp : null,
          ttfb: typeof p.ttfb === "number" ? p.ttfb : null,
        });
      }
    });

    const sessionsCount = stats.uniqueSessions.size || 1;

    const crProductToCart =
      stats.productViews > 0 ? (stats.addToCart / stats.productViews) * 100 : 0;
    const crCartToPurchase =
      stats.addToCart > 0 ? (stats.purchases / stats.addToCart) * 100 : 0;
    const crPageviewToPurchase =
      stats.pageviews > 0 ? (stats.purchases / stats.pageviews) * 100 : 0;

    const topPagesArray = Object.entries(stats.topPages)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([path, count]) => ({ path, count }));

    const topReferrersArray = Object.entries(stats.referrers)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([source, count]) => ({ source, count }));

    const utmArray = Object.entries(stats.utmCombos)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([combo, count]) => {
        const [s, m, c] = combo.split("|");
        return { source: s, medium: m, campaign: c, count };
      });

    // carrelli attivi = visitor con almeno 1 item nel carrello
    let activeCarts = 0;
    stats.activeCartsByVisitor.forEach((items) => {
      if (Array.isArray(items) && items.length > 0) activeCarts++;
    });

    // performance media
    let perfSummary = { avgLcp: null, avgFcp: null, avgTtfb: null, samples: 0 };
    if (stats.perfSamples.length > 0) {
      const validLcp = stats.perfSamples.map(s => s.lcp).filter(x => typeof x === "number");
      const validFcp = stats.perfSamples.map(s => s.fcp).filter(x => typeof x === "number");
      const validTtfb = stats.perfSamples.map(s => s.ttfb).filter(x => typeof x === "number");

      function avg(arr) {
        if (!arr.length) return null;
        const sum = arr.reduce((a, b) => a + b, 0);
        return sum / arr.length;
      }

      perfSummary = {
        avgLcp: avg(validLcp),
        avgFcp: avg(validFcp),
        avgTtfb: avg(validTtfb),
        samples: stats.perfSamples.length,
      };
    }

    res.json({
      totalEvents: stats.totalEvents,
      pageviews: stats.pageviews,
      timeonpageEvents: stats.timeonpageEvents,
      productViews: stats.productViews,
      addToCart: stats.addToCart,
      purchases: stats.purchases,

      uniqueSessions: sessionsCount,
      uniqueVisitors: stats.uniqueVisitors.size,
      newVisitors: stats.newVisitors,
      returningVisitors: stats.returningVisitors,
      devices: stats.devices,

      crProductToCart,
      crCartToPurchase,
      crPageviewToPurchase,

      topPages: topPagesArray,
      topReferrers: topReferrersArray,
      utmCombos: utmArray,

      activeCarts,
      checkoutSteps: stats.checkoutSteps,
      productCategories: stats.productCategories,
      gramsViews: stats.gramsViews,
      mediaInteractions: stats.mediaInteractions,
      countries: stats.countries,
      formStats: stats.formStats,
      jsErrors: stats.jsErrors,
      paymentErrors: stats.paymentErrors,
      perfSummary,
    });
  } catch (err) {
    console.error("Error in /api/summary", err);
    res.status(500).json({ ok: false });
  }
});

app.get("/admin/backup-csv", async (req, res) => {
  const token = req.query.token;
  if (token !== RESET_TOKEN) {
    return res.status(403).send("Accesso negato");
  }
  try {
    const result = await pool.query(
      `SELECT occurred_at, ip, user_agent, payload
       FROM events
       ORDER BY occurred_at ASC`
    );
    let csv = "occurred_at,ip,user_agent,payload_json\n";
    for (const row of result.rows) {
      const occurred = row.occurred_at.toISOString();
      const ip = row.ip ? row.ip.replace(/"/g, '""') : "";
      const ua = row.user_agent ? row.user_agent.replace(/"/g, '""') : "";
      const payload = row.payload
        ? JSON.stringify(row.payload).replace(/"/g, '""')
        : "";
      csv += `"${occurred}","${ip}","${ua}","${payload}"\n`;
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="events-backup-${new Date()
        .toISOString()
        .slice(0, 10)}.csv"`
    );
    res.send(csv);
  } catch (err) {
    console.error("Errore backup CSV:", err);
    res.status(500).send("Errore nel generare il backup.");
  }
});

// ------------------ AVVIO SERVER ------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Tracker attivo sulla porta " + PORT);
});
