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
