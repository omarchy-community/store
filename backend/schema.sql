-- Omarchy Store backend database (Cloudflare D1)

-- Page views. No IP addresses are stored: `visitor` is a hash of IP + browser that changes every day,
-- so we can count unique visitors per day but can never track a person across days.
CREATE TABLE IF NOT EXISTS hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,              -- YYYY-MM-DD (UTC)
  ts INTEGER NOT NULL,
  path TEXT NOT NULL,
  ref TEXT,                       -- referring site (host only)
  country TEXT,
  device TEXT,                    -- desktop-app | phone | computer
  visitor TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS hits_day ON hits(day);
CREATE INDEX IF NOT EXISTS hits_day_path ON hits(day, path);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,             -- install | open | theme | plugin | usb
  item TEXT NOT NULL,
  visitor TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_day ON events(day, kind);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title TEXT,
  body TEXT,
  name TEXT,
  ts INTEGER NOT NULL,
  visitor TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS reviews_app ON reviews(app, hidden, ts);

CREATE TABLE IF NOT EXISTS developers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  website TEXT,
  github TEXT,
  app_name TEXT,
  app_desc TEXT,
  app_url TEXT,
  wants_paid INTEGER NOT NULL DEFAULT 0,
  price_usd REAL,
  payout TEXT,                    -- JSON {btc, base, sol, xrp} public addresses for the developer's 90%
  note TEXT,                      -- owner's note
  telegram_chat_id INTEGER        -- set once the developer confirms via the Telegram bot deep link
);

-- Crypto orders. The buyer pays the exact amount to a public address; the backend checks the
-- blockchain (read-only) and marks the order paid. No private keys anywhere.
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,            -- random order id (also the license key once paid)
  ts INTEGER NOT NULL,
  app TEXT NOT NULL,
  chain TEXT NOT NULL,            -- btc (more chains later)
  address TEXT NOT NULL,
  usd REAL NOT NULL,
  amount_sats INTEGER NOT NULL DEFAULT 0,
  amount TEXT,                    -- exact unique amount in the coin's smallest unit
  tag INTEGER,                    -- XRP destination tag
  status TEXT NOT NULL DEFAULT 'waiting',   -- waiting | seen | paid | expired
  txid TEXT,
  paid_ts INTEGER,
  email TEXT
);
CREATE INDEX IF NOT EXISTS orders_status ON orders(status, ts);
