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

-- ===== Portal v2 (migrate-4.sql) =====
-- Portal v2: developer status links + messages, advertiser requests, donations, supporters wall,
-- admin activity log, and an accounts table reserved for future developer/advertiser log-ins.

-- Developer submissions: fields the form already sent but were dropped, a private status-link token,
-- the listing they became, and (later) the account that owns them.
ALTER TABLE developers ADD COLUMN company TEXT;
ALTER TABLE developers ADD COLUMN repo_url TEXT;
ALTER TABLE developers ADD COLUMN category TEXT;
ALTER TABLE developers ADD COLUMN license TEXT;
ALTER TABLE developers ADD COLUMN install_hint TEXT;      -- e.g. "aur:myapp" or "pacman:myapp" or "release"
ALTER TABLE developers ADD COLUMN token_hash TEXT;        -- sha256 of the private status-link token
ALTER TABLE developers ADD COLUMN updated_ts INTEGER;
ALTER TABLE developers ADD COLUMN listing_id TEXT;        -- registry/apps/<id>.json once published
ALTER TABLE developers ADD COLUMN account_id INTEGER;     -- future: developer accounts

-- Conversation between the store and a developer (shown on their status page).
CREATE TABLE IF NOT EXISTS dev_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dev_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  sender TEXT NOT NULL,           -- store | developer
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS dev_messages_dev ON dev_messages(dev_id, ts);

-- "Advertise with us" booking requests.
CREATE TABLE IF NOT EXISTS ad_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  updated_ts INTEGER,
  status TEXT NOT NULL DEFAULT 'new',   -- new | quoted | approved | paid | live | declined | done
  company TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  website TEXT,
  telegram TEXT,
  slot TEXT NOT NULL,             -- banner | sponsored-app | search | artist
  app TEXT,                       -- registry id for sponsored-app
  starts TEXT,                    -- YYYY-MM-DD
  ends TEXT,
  budget TEXT,
  headline TEXT,
  body TEXT,
  cta TEXT,
  url TEXT,
  image_url TEXT,
  notes TEXT,
  quote_usd REAL,
  admin_note TEXT,                -- private
  campaign_id TEXT,               -- registry/ads.json campaign id once created
  token_hash TEXT,
  account_id INTEGER
);
CREATE TABLE IF NOT EXISTS ad_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ad_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  sender TEXT NOT NULL,           -- store | advertiser
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ad_messages_ad ON ad_messages(ad_id, ts);

-- Donations seen arriving at the public wallets (read-only blockchain scan).
CREATE TABLE IF NOT EXISTS donations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  chain TEXT NOT NULL,            -- btc | eth | eth-base | usdc-base | usdc-eth | sol | usdc-sol | xrp
  txid TEXT NOT NULL UNIQUE,      -- real tx hash, or "bal:<chain>:<ts>" for balance-change detections
  units TEXT NOT NULL,
  coin TEXT NOT NULL,
  usd REAL,
  ignored INTEGER NOT NULL DEFAULT 0   -- owner marked "not a donation" (e.g. his own transfer)
);
CREATE INDEX IF NOT EXISTS donations_ts ON donations(ts);

-- Optional public thank-you wall. Hidden until the owner approves each entry.
CREATE TABLE IF NOT EXISTS supporters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  name TEXT NOT NULL,
  message TEXT,
  chain TEXT,
  approved INTEGER NOT NULL DEFAULT 0,
  visitor TEXT
);

-- Everything the admin changes, newest first.
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT
);

-- Small key/value store (scan cursors, last balances).
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);

-- Reserved for future developer/advertiser accounts (Google Play Console-style). Not used yet.
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,             -- developer | advertiser
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  company TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active'
);
