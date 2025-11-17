// reset-db.js
const pool = require('./db');

(async () => {
  try {
    await pool.query("TRUNCATE TABLE events RESTART IDENTITY;");
    console.log("Tabella events azzerata.");
  } catch (err) {
    console.error("Errore nel reset del DB:", err);
  } finally {
    await pool.end();
    process.exit(0);
  }
})();
