const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();

// === CORS globale: consenti tutte le origini (per ora) ===
app.use(cors({
  origin: "*",
  methods: ["POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

// Gestione preflight SOLO per /collect (niente "*")
app.options("/collect", cors());

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

  res.status(204).end(); // risposta vuota ma valida
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Tracker attivo sulla porta " + PORT);
});
