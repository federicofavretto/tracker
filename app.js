const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
const RESET_TOKEN = "LAPERLE_RESET_2024"; // scegli tu la parola
const pool = require('./db');   // <-- importa il pool di Postgres

/**
 * CORS – consenti SOLO i tuoi domini
 */
app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true); // richieste server-side

      const allowedOrigins = [
        "https://laperleducaviar.com",
        "https://laperleducaviar.myshopify.com",
        "https://laperledu-caviar.myshopify.com", // visto nei log
      ];

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS: " + origin));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

app.options("/collect", cors());
app.options("/api/events", cors());
app.options("/api/summary", cors());

app.use(express.json());
app.use("/dashboard", express.static(path.join(__dirname, "dashboard")));

/**
 * Helpers logging
 */

function ensureLogsDir() {
  const logsDir = path.join(__dirname, "logs");
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir);
  }
  return logsDir;
}

function clearAllLogs() {
  const logsDir = ensureLogsDir();
  const files = fs.readdirSync(logsDir);
  files.forEach((file) => {
    if (file.startsWith("visitors-") && file.endsWith(".log")) {
      fs.unlinkSync(path.join(logsDir, file));
    }
  });
}

function getLogFilePath(date = new Date()) {
  const logsDir = ensureLogsDir();
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return path.join(logsDir, `visitors-${yyyy}-${mm}-${dd}.log`);
}

function anonymizeIp(ip) {
  if (!ip) return "";
  const parts = ip.split(".");
  if (parts.length === 4) {
    parts[3] = "0";
    return parts.join(".");
  }
  return ip;
}

function logEvent(entry) {
  const logPath = getLogFilePath();
  fs.appendFile(logPath, JSON.stringify(entry) + "\n", () => {});
}

/**
 * /collect – endpoint principale
 * type:
 *  - pageview
 *  - timeonpage
 *  - view_product
 *  - add_to_cart
 *  - purchase
 */
app.post("/collect", async (req, res) => {
  const clientIp =
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.socket.remoteAddress;

  const entry = {
    receivedAt: new Date().toISOString(),
    ip: anonymizeIp(clientIp),
    userAgent: req.headers["user-agent"] || "",
    payload: req.body,
  };

  console.log("Evento /collect:", entry.payload);
  logEvent(entry); // continuiamo anche a loggare su file, se vuoi

  try {
    await pool.query(
      `INSERT INTO events (occurred_at, ip, user_agent, payload)
       VALUES ($1, $2, $3, $4)`,
      [entry.receivedAt, entry.ip, entry.userAgent, entry.payload]
    );
  } catch (err) {
    console.error('Error inserting event into Postgres', err);
    // NON blocchiamo la risposta al browser
  }

  res.status(204).end();
});


app.post('/api/track', async (req, res) => {
  try {
    const { event_type, url, session_id, meta } = req.body;

    await pool.query(
      `INSERT INTO events (event_type, url, session_id, user_agent, meta)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        event_type,
        url || null,
        session_id || null,
        req.headers['user-agent'] || null,
        meta || {}
      ]
    );

    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('Error inserting event', err);
    res.status(500).json({ ok: false });
  }
});

/**
 * Legge gli ultimi N eventi dai file log (partendo dai più recenti)
 */
async function readLastEvents(limit = 200) {
  const result = await pool.query(
    `SELECT occurred_at, ip, user_agent, payload
     FROM events
     ORDER BY occurred_at DESC
     LIMIT $1`,
    [limit]
  );

  // Ricostruiamo lo stesso formato dei vecchi log:
  return result.rows.map(row => ({
    receivedAt: row.occurred_at,
    ip: row.ip,
    userAgent: row.user_agent,
    payload: row.payload
  }));
}


/**
 * /api/events – per tabella dettagli
 */
app.get('/api/events', async (req, res) => {
  const limit = Number(req.query.limit) || 300;
  const range = req.query.range || null; // '7d', '30d', ecc.

  const ranges = {
    '7d':   "NOW() - INTERVAL '7 days'",
    '30d':  "NOW() - INTERVAL '30 days'",
    '90d':  "NOW() - INTERVAL '90 days'",
    '180d': "NOW() - INTERVAL '180 days'",
    '365d': "NOW() - INTERVAL '365 days'"
  };

  try {
    let whereClause = '';
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

    const events = result.rows.map(row => ({
      receivedAt: row.occurred_at,
      ip: row.ip,
      userAgent: row.user_agent,
      payload: row.payload
    }));

    res.json(events);
  } catch (err) {
    console.error('Error fetching events', err);
    res.status(500).json({ ok: false });
  }
});



/**
 * /api/summary – statistiche per la dashboard (funnel)
 * calcolate sugli ultimi 2000 eventi (puoi regolare)
 */
app.get("/api/summary", async (req, res) => {
  try {
    const events = await readLastEvents(2000);

    const stats = {
      totalEvents: events.length,
      pageviews: 0,
      timeonpageEvents: 0,
      productViews: 0,
      addToCart: 0,
      purchases: 0,
      uniqueSessions: new Set(),
      uniqueVisitors: new Set(),
      newVisitors: 0,
      returningVisitors: 0,
      devices: { desktop: 0, mobile: 0, tablet: 0, other: 0 },
      topPages: {},
      referrers: {},
      utmCombos: {}
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

      if (type === "pageview") {
        if (isNewVisitor) stats.newVisitors++;
        else stats.returningVisitors++;
      }

      if (deviceType === "desktop" || deviceType === "mobile" || deviceType === "tablet") {
        stats.devices[deviceType]++;
      } else {
        stats.devices.other++;
      }

      if (path) {
        stats.topPages[path] = (stats.topPages[path] || 0) + 1;
      }

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

      if (type === "pageview") {
        const s = utmSource || "(none)";
        const m = utmMedium || "(none)";
        const c = utmCampaign || "(none)";
        const comboKey = `${s}|${m}|${c}`;
        stats.utmCombos[comboKey] = (stats.utmCombos[comboKey] || 0) + 1;
      }

      if (type === "pageview") stats.pageviews++;
      else if (type === "timeonpage") stats.timeonpageEvents++;
      else if (type === "view_product") stats.productViews++;
      else if (type === "add_to_cart") stats.addToCart++;
      else if (type === "purchase") stats.purchases++;
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
      utmCombos: utmArray
    });
  } catch (err) {
    console.error('Error in /api/summary', err);
    res.status(500).json({ ok: false });
  }
});

app.get("/admin/reset-db", async (req, res) => {
  const token = req.query.token;

  if (token !== RESET_TOKEN) {
    return res.status(403).send("Accesso negato");
  }

  try {
    await pool.query("TRUNCATE TABLE events RESTART IDENTITY");
    res.send("Database eventi azzerato. Ora parti da zero!");
  } catch (err) {
    console.error("Errore nel reset del DB", err);
    res.status(500).send("Errore nel cancellare gli eventi.");
  }
});


// Endpoint per AZZERARE tutti i log (uso interno)
app.get("/admin/reset-logs", (req, res) => {
  const token = req.query.token;

  if (token !== RESET_TOKEN) {
    return res.status(403).send("Accesso negato");
  }

  clearAllLogs();
  res.send("Log cancellati. La dashboard ripartirà da zero.");
});

app.get("/admin/reset-db", async (req, res) => {
  const token = req.query.token;

  if (token !== RESET_TOKEN) {
    return res.status(403).send("Accesso negato");
  }

  try {
    await pool.query("TRUNCATE TABLE events RESTART IDENTITY;");
    res.send("Database eventi azzerato. Ora parti da zero!");
  } catch (err) {
    console.error("Errore nel reset del DB", err);
    res.status(500).send("Errore nel cancellare gli eventi.");
  }
});


/**
 * /dashboard – dashboard avanzata
 */
/*app.get("/dashboard", (req, res) => {
  res.send(`
<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8" />
  <title>Analytics – La Perle du Caviar</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; margin: 0; background: #020617; color: #e5e7eb; }
    .page { padding: 20px 24px 40px; max-width: 1200px; margin: 0 auto; }
    h1 { margin: 0 0 6px; font-size: 24px; }
    .subtitle { color: #9ca3af; margin-bottom: 20px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 20px; }
    .card { background: #030712; border: 1px solid #111827; border-radius: 10px; padding: 10px 14px; }
    .card-title { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: #9ca3af; margin-bottom: 4px; }
    .card-value { font-size: 20px; font-weight: 600; }
    .card-sub { font-size: 11px; color: #6b7280; margin-top: 2px; }

    .funnel { display: flex; gap: 12px; margin-bottom: 24px; flex-wrap: wrap; }
    .funnel-step { flex: 1; min-width: 160px; background: #030712; border-radius: 10px; padding: 10px 12px; border: 1px solid #111827; position: relative; }
    .funnel-step h3 { margin: 0 0 4px; font-size: 13px; }
    .funnel-count { font-size: 18px; font-weight: 600; }
    .funnel-cr { font-size: 11px; color: #9ca3af; margin-top: 2px; }
    .funnel-step::after { content: '→'; position: absolute; right: -10px; top: 50%; transform: translateY(-50%); color: #4b5563; font-size: 16px; }
    .funnel-step:last-child::after { content: ''; }

    .section-title { font-size: 15px; margin: 20px 0 8px; }
    table { border-collapse: collapse; width: 100%; font-size: 12px; }
    th, td { border: 1px solid #111827; padding: 6px 8px; vertical-align: top; }
    th { background: #020617; position: sticky; top: 0; z-index: 1; }
    tr:nth-child(even) { background: #020617; }
    tr:nth-child(odd) { background: #030712; }

    .tag { display: inline-block; padding: 2px 6px; border-radius: 999px; font-size: 11px; background: #374151; color: #e5e7eb; }
    .tag-pageview { background: #2563eb; }
    .tag-timeonpage { background: #16a34a; }
    .tag-view_product { background: #ea580c; }
    .tag-add_to_cart { background: #ca8a04; }
    .tag-purchase { background: #a855f7; }

    .filters { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
    select, input { background: #020617; color: #e5e7eb; border-radius: 6px; border: 1px solid #111827; padding: 4px 6px; font-size: 12px; }
    input::placeholder { color: #6b7280; }

    .pill { display:inline-block; padding:2px 6px; border-radius:999px; background:#020617; color:#9ca3af; font-size:11px; border:1px solid #111827; margin-right:4px; }

  </style>
</head>
<body>
  <div class="page">
    <h1>Analytics – La Perle du Caviar</h1>
    <div class="subtitle">Ultimi eventi registrati (dati interni, nessun cookie di terze parti).</div>

    <div id="overview" class="grid"></div>

    <div class="section-title">Funnel principale</div>
    <div class="funnel" id="funnel"></div>

<div class="section-title">Pagine più viste</div>
<div id="topPages"></div>

<div class="section-title">Fonti di traffico</div>
<div class="grid">
  <div id="trafficSources"></div>
  <div id="utmSources"></div>
</div>

<div class="section-title">Eventi recenti</div>

    <div class="filters">
      <label>Tipo:
        <select id="filterType">
          <option value="">Tutti</option>
          <option value="pageview">pageview</option>
          <option value="timeonpage">timeonpage</option>
          <option value="view_product">view_product</option>
          <option value="add_to_cart">add_to_cart</option>
          <option value="purchase">purchase</option>
        </select>
      </label>
      <input id="filterSearch" placeholder="Cerca in URL / titolo / dettagli..." />
      <span class="pill" id="eventsCount"></span>
    </div>

    <table>
      <thead>
        <tr>
          <th>Quando</th>
          <th>Tipo</th>
          <th>Pagina / URL</th>
          <th>Dettagli</th>
        </tr>
      </thead>
      <tbody id="rows"></tbody>
    </table>
  </div>

<script>
function formatTs(ts) {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    return d.toLocaleString();
  } catch(e) { return ts; }
}

function tag(type) {
  const cls = "tag tag-" + type;
  return '<span class="' + cls + '">' + type + '</span>';
}

function esc(str) {
  if (!str && str !== 0) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

let ALL_EVENTS = [];

function renderOverview(summary) {
  const el = document.getElementById("overview");
  const devices = summary.devices || {desktop:0, mobile:0, tablet:0, other:0};

  const cards = [
    { label: "Sessioni uniche", value: summary.uniqueSessions },
    { label: "Visitatori unici", value: summary.uniqueVisitors },
    { label: "Nuovi / di ritorno", value: (summary.newVisitors || 0) + " / " + (summary.returningVisitors || 0) },
    { label: "Pageview", value: summary.pageviews },
    { label: "Viste prodotto", value: summary.productViews },
    { label: "Add to cart", value: summary.addToCart },
    { label: "Acquisti", value: summary.purchases },
    { label: "Device (M/D/T)", value: (devices.mobile||0) + " / " + (devices.desktop||0) + " / " + (devices.tablet||0) }
  ];

  el.innerHTML = cards.map(c => (
    '<div class="card">' +
      '<div class="card-title">' + esc(c.label) + '</div>' +
      '<div class="card-value">' + esc(c.value) + '</div>' +
    '</div>'
  )).join("");
}


function renderFunnel(summary) {
  const el = document.getElementById("funnel");
  const steps = [
    {
      label: "Pageview",
      count: summary.pageviews,
      cr: summary.crPageviewToPurchase,
      note: "→ purchase"
    },
    {
      label: "View product",
      count: summary.productViews,
      cr: summary.crProductToCart,
      note: "→ add_to_cart"
    },
    {
      label: "Add to cart",
      count: summary.addToCart,
      cr: summary.crCartToPurchase,
      note: "→ purchase"
    },
    {
      label: "Purchase",
      count: summary.purchases,
      cr: null,
      note: ""
    }
  ];
  el.innerHTML = steps.map(s => (
    '<div class="funnel-step">' +
      '<h3>' + esc(s.label) + '</h3>' +
      '<div class="funnel-count">' + esc(Math.round(s.count)) + '</div>' +
      (s.cr != null ? '<div class="funnel-cr">CR: ' + esc(s.cr.toFixed(1)) + '% ' + esc(s.note) + '</div>' : '') +
    '</div>'
  )).join("");
}

function renderTopPages(summary) {
  const el = document.getElementById("topPages");
  if (!summary.topPages || !summary.topPages.length) {
    el.innerHTML = '<div class="card"><div class="card-title">Top pages</div><div class="card-sub">Nessun dato sufficiente</div></div>';
    return;
  }
  el.innerHTML =
    '<div class="card">' +
      '<div class="card-title">Top pages (ultimi eventi)</div>' +
      summary.topPages.map(p => (
        '<div class="card-sub">' + esc(p.path) + ' – ' + esc(p.count) + ' eventi</div>'
      )).join("") +
    '</div>';
}

function renderTrafficSources(summary) {
  const el = document.getElementById("trafficSources");
  if (!el) return;

  let html = '<div class="card"><div class="card-title">Fonti di traffico (referrer)</div>';

  if (!summary.topReferrers || !summary.topReferrers.length) {
    html += '<div class="card-sub">Nessun dato referrer disponibile.</div></div>';
    el.innerHTML = html;
    return;
  }

  summary.topReferrers.forEach(r => {
    html += '<div class="card-sub">' + esc(r.source) + ' – ' + esc(r.count) + ' pageview</div>';
  });

  html += '</div>';
  el.innerHTML = html;
}

function renderUtm(summary) {
  const el = document.getElementById("utmSources");
  if (!el) return;

  let html = '<div class="card"><div class="card-title">UTM (ultime campagne)</div>';

  if (!summary.utmCombos || !summary.utmCombos.length) {
    html += '<div class="card-sub">Nessuna UTM rilevata.</div></div>';
    el.innerHTML = html;
    return;
  }

  summary.utmCombos.forEach(u => {
    html += '<div class="card-sub">' +
      'source: <strong>' + esc(u.source) + '</strong> · ' +
      'medium: <strong>' + esc(u.medium) + '</strong> · ' +
      'campaign: <strong>' + esc(u.campaign) + '</strong> ' +
      ' (' + esc(u.count) + ' pageview)' +
      '</div>';
  });

  html += '</div>';
  el.innerHTML = html;
}

function renderTable() {
  const tbody = document.getElementById("rows");
  const typeFilter = document.getElementById("filterType").value;
  const search = document.getElementById("filterSearch").value.toLowerCase();
  let filtered = ALL_EVENTS.slice();

  if (typeFilter) {
    filtered = filtered.filter(ev => (ev.payload || {}).type === typeFilter);
  }
  if (search) {
    filtered = filtered.filter(ev => {
      const p = ev.payload || {};
      const url = (p.url || p.path || "");
      const details = JSON.stringify(p);
      return url.toLowerCase().includes(search) ||
             details.toLowerCase().includes(search);
    });
  }

  document.getElementById("eventsCount").textContent =
    filtered.length + " eventi mostrati";

  tbody.innerHTML = filtered.map(ev => {
    const p = ev.payload || {};
    const type = p.type || "";
    const url = p.url || p.path || "";
    let details = "";

    if (type === "pageview") {
      details =
        "Referrer: " + esc(p.referrer || "-") +
        "<br>Title: " + esc(p.title || "-") +
        "<br>UTM: " + esc(p.utm_source || "-") + " / " +
        esc(p.utm_medium || "-") + " / " +
        esc(p.utm_campaign || "-");
    } else if (type === "timeonpage") {
      details = "Durata: " + Math.round((p.millis || 0) / 1000) + "s";
    } else if (type === "view_product") {
      details =
        "Prodotto: " + esc(p.productTitle || "-") +
        "<br>ID: " + esc(p.productId || "-") +
        "<br>Prezzo: " + esc(p.productPrice || "-") +
        "<br>Variant: " + esc(p.variantTitle || "-");
    } else if (type === "add_to_cart") {
      details =
        "Variant ID: " + esc(p.variantId || "-") +
        "<br>Qty: " + esc(p.quantity || "-") +
        (p.productTitle ? "<br>Prodotto: " + esc(p.productTitle) : "");
    } else if (type === "purchase") {
      details =
        "Order: " + esc(p.orderNumber || p.orderId || "-") +
        "<br>Totale: " + esc(p.total || p.orderPrice || "-") +
        " " + esc(p.currency || "") +
        "<br>Items: " + esc(p.itemsCount || (p.items ? p.items.length : "-"));
    } else {
      details = "<code>" + esc(JSON.stringify(p)) + "</code>";
    }

    return (
      "<tr>" +
        "<td>" + esc(formatTs(ev.receivedAt || p.ts)) + "</td>" +
        "<td>" + tag(type) + "</td>" +
        "<td>" + esc(url || "-") + "</td>" +
        "<td>" + details + "</td>" +
      "</tr>"
    );
  }).join("");
}

document.getElementById("filterType").addEventListener("change", renderTable);
document.getElementById("filterSearch").addEventListener("input", renderTable);

// Carica dati
Promise.all([
  fetch("/api/summary").then(r => r.json()),
  fetch("/api/events?limit=300").then(r => r.json())
]).then(([summary, events]) => {
  ALL_EVENTS = events || [];
  renderOverview(summary);
  renderFunnel(summary);
  renderTopPages(summary);
  renderTrafficSources(summary);
  renderUtm(summary);
  renderTable();
}).catch(err => {
  console.error("Errore nel caricamento dashboard", err);
});

</script>
</body>
</html>
  `);
});
*/

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Tracker attivo sulla porta " + PORT);
});
