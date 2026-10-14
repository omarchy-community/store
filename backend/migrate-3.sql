-- Marketing assets are required for new developer applications (logo, tagline, write-up, screenshots).
ALTER TABLE developers ADD COLUMN tagline TEXT;
ALTER TABLE developers ADD COLUMN logo_url TEXT;
ALTER TABLE developers ADD COLUMN screenshots TEXT;      -- JSON array of https image URLs
ALTER TABLE developers ADD COLUMN telegram TEXT;         -- @username they gave us (optional)
