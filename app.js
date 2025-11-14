const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();

/**
 * CORS – consenti SOLO il tuo sito e il negozio Shopify
 */
app.use(
  cors({
    origin: function (origin, callback) {
      // richieste server-to-server (senza origin) -> ok
      if (!origin) return callback(null, true);

      const allowedOrigins = [
        "https://laperleducaviar.com",
        "https://laperleducaviar.myshopify.com", // modifica se il tuo myshopify è diverso
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

// preflight per /collect e /api/events
app.options("/collect", cors());
app.options("/api/events", cors());

app.use(express.json());

/**
 * Helpers per logging "professionale"
 * - directory logs/
 * - 1 file per giorno: visitors-YYYY-MM-DD.log
 */

function ensureLogsDir() {
  const logsDir = path.join(__dirname, "logs");
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir);
  }
  return logsDir;
}

function getLogFilePath() {
  const logsDir = ensureLogsDir();
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return path.join(logsDir, `visitors-${yyyy}-${mm}-${dd}.log`);
}

function anonymizeIp(ip) {
  if (!ip) return "";
  // semplice anonimizzazione IPv4: azzera l'ultimo blocco
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
 * /collect – endpoint principale di tracking
 * Riceve:
 * - pageview
 * - timeonpage
 * - view_product
 * - add_to_cart
 * - purchase
 * ... e qualsiasi altro tipo di evento
 */
app.post("/collect", (req, res) => {
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
  logEvent(entry);

  res.status(204).end(); // nessun contenuto, ma ok
});

/**
 * /api/events – API per la dashboard
 * restituisce gli ultimi N eventi (default 200)
 */
app.get("/api/events", (req, res) => {
  const limit = Number(req.query.limit) || 200;
  const logsDir = ensureLogsDir();

  const files = fs
    .readdirSync(logsDir)
    .filter((f) => f.startsWith("visitors-") && f.endsWith(".log"))
    .sort()
    .reverse(); // i più recenti prima

  const events = [];

  for (const file of files) {
    const fullPath = path.join(logsDir, file);
    const content = fs.readFileSync(fullPath, "utf-8").trim();
    if (!content) continue;
    const lines = content.split("\n");

    // leggi dal fondo (eventi più recenti)
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        events.push(obj);
        if (events.length >= limit) break;
      } catch (e) {}
    }

    if (events.length >= limit) break;
  }

  res.json(events);
});

/**
 * /dashboard – dashboard HTML semplice
 */
app.get("/dashboard", (req, res) => {
  res.send(`
<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8" />
  <title>Analytics - La Perle du Caviar</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; margin: 20px; background: #05060a; color: #f4f4f4; }
    h1 { margin-bottom: 0.25rem; }
    .subtitle { margin-bottom: 1.5rem; color: #9ca3af; }
    table { border-collapse: collapse; width: 100%; font-size: 13px; }
    th, td { border: 1px solid #1f2937; padding: 6px 8px; vertical-align: top; }
    th { background: #111827; position: sticky; top: 0; z-index: 1; }
    tr:nth-child(even) { background: #0b1120; }
    tr:nth-child(odd) { background: #020617; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
    .tag { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 11px; background: #374151; }
    .tag-pageview { background: #2563eb; }
    .tag-timeonpage { background: #16a34a; }
    .tag-view_product { background: #ea580c; }
    .tag-add_to_cart { background: #ca8a04; }
    .tag-purchase { background: #a855f7; }
  </style>
</head>
<body>
  <h1>Dashboard visite</h1>
  <div class="subtitle">Ultimi eventi registrati dal tracker custom (solo uso interno).</div>
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
<script>
  function formatTs(ts) {
    if (!ts) return "";
    try {
      const d = new Date(ts);
      return d.toLocaleString();
    } catch (e) { return ts; }
  }

  function renderTag(type) {
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

  fetch('/api/events?limit=200')
    .then(r => r.json())
    .then(data => {
      const tbody = document.getElementById('rows');
      tbody.innerHTML = '';
      data.forEach(ev => {
        const p = ev.payload || {};
        const type = p.type || '';
        const url = p.url || p.path || '';
        let details = '';

        if (type === 'pageview') {
          details =
            'Referrer: ' + esc(p.referrer || '-') +
            '<br>Title: ' + esc(p.title || '-') +
            '<br>UTM: ' +
              esc(p.utm_source || '-') + ' / ' +
              esc(p.utm_medium || '-') + ' / ' +
              esc(p.utm_campaign || '-');
        } else if (type === 'timeonpage') {
          details = 'Durata: ' + Math.round((p.millis || 0) / 1000) + 's';
        } else if (type === 'view_product') {
          details =
            'Prodotto: ' + esc(p.productTitle || '-') +
            '<br>ID prodotto: ' + esc(p.productId || '-') +
            '<br>Prezzo: ' + esc(p.productPrice || '-') +
            '<br>Variant: ' + esc(p.variantTitle || '-');
        } else if (type === 'add_to_cart') {
          details =
            'Variant ID: ' + esc(p.variantId || '-') +
            '<br>Quantità: ' + esc(p.quantity || '-') +
            (p.productTitle ? '<br>Prodotto: ' + esc(p.productTitle) : '');
        } else if (type === 'purchase') {
          details =
            'Ordine: ' + esc(p.orderId || '-') +
            '<br>Totale: ' + esc(p.total || '-') + ' ' + esc(p.currency || '') +
            '<br>Articoli: ' + esc(p.itemsCount || '-') +
            '<br>UTM: ' +
              esc(p.utm_source || '-') + ' / ' +
              esc(p.utm_medium || '-') + ' / ' +
              esc(p.utm_campaign || '-');
        } else {
          details = '<code>' + esc(JSON.stringify(p)) + '</code>';
        }

        const tr = document.createElement('tr');
        tr.innerHTML =
          '<td>' + esc(formatTs(ev.receivedAt || p.ts)) + '</td>' +
          '<td>' + renderTag(type) + '</td>' +
          '<td>' + esc(url || '-') + '</td>' +
          '<td>' + details + '</td>';
        tbody.appendChild(tr);
      });
    });
</script>
</body>
</html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Tracker attivo sulla porta " + PORT);
});
