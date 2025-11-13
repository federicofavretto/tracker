const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();

// === CORS globale: consenti tutte le origini (per ora) ===
app.use(cors());            // Access-Control-Allow-Origin: *
app.options("*", cors());   // gestisce tutte le richieste OPTIONS

// === Body JSON ===
app.use(express.json());

// funzione per "anonimizzare" un po' l'IP
function anonymizeIp(ip) {
  if (!ip) return "";
  const parts = ip.split(".");
  if (parts.length === 4) {
    parts[3] = "0";
    return parts.join(".");
  }
  return ip;
}

// === Endpoint di tracking ===
app.post("/collect", (req, res) => {
  const clientIp =
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.socket.remoteAddress;

  const entry = {
    receivedAt: new Date().toISOString(),
    ip: anonymizeIp(clientIp),
    payload: req.body,
  };

  const logPath = path.join(__dirname, "visitors.log");
  fs.appendFile(logPath, JSON.stringify(entry) + "\n", () => {});

  console.log("Richiesta /collect ricevuta:", entry.payload);

  // Risposta vuota ma valida
  res.status(204).end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Tracker attivo sulla porta " + PORT);
});
