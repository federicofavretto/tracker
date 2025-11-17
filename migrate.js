const pool = require('./db');

(async () => {
  await pool.query(`
    DROP TABLE IF EXISTS events;

    CREATE TABLE events (
      id           BIGSERIAL PRIMARY KEY,
      occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ip           TEXT,
      user_agent   TEXT,
      payload      JSONB
    );

    CREATE INDEX idx_events_occurred_at ON events(occurred_at);
  `);

  console.log('Migration ok');
  process.exit(0);
})().catch(err => {
  console.error('Migration error', err);
  process.exit(1);
});
