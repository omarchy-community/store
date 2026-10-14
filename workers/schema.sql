-- Omarchy Store D1 Database Schema
-- Run with: wrangler d1 execute omarchy-store --file=./schema.sql

-- Developer Applications
CREATE TABLE IF NOT EXISTS developer_applications (
  id TEXT PRIMARY KEY,
  company TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  website TEXT,
  github TEXT,
  repo_url TEXT NOT NULL,
  app_name TEXT NOT NULL,
  app_desc TEXT NOT NULL,
  app_url TEXT,
  wants_paid INTEGER NOT NULL DEFAULT 0,
  price_usd REAL,
  p_evm TEXT,
  p_sol TEXT,
  p_btc TEXT,
  p_xrp TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending, approved, rejected, changes_requested
  admin_notes TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dev_apps_status ON developer_applications(status);
CREATE INDEX IF NOT EXISTS idx_dev_apps_email ON developer_applications(email);
CREATE INDEX IF NOT EXISTS idx_dev_apps_created ON developer_applications(created_at);

-- Issue Reports
CREATE TABLE IF NOT EXISTS issue_reports (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL, -- unresponsive, not_working, malware, privacy, scam, broken, other
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  email TEXT,
  app_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- open, investigating, resolved, dismissed
  admin_notes TEXT,
  resolved_by TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_issues_status ON issue_reports(status);
CREATE INDEX IF NOT EXISTS idx_issues_category ON issue_reports(category);
CREATE INDEX IF NOT EXISTS idx_issues_app ON issue_reports(app_id);
CREATE INDEX IF NOT EXISTS idx_issues_created ON issue_reports(created_at);

-- Test Results (for VM-based testing)
CREATE TABLE IF NOT EXISTS test_results (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL, -- references developer_applications.id
  repo_url TEXT NOT NULL,
  commit_hash TEXT,
  timestamp TEXT NOT NULL,
  duration_seconds INTEGER,
  risk_score INTEGER, -- 0-100
  recommendation TEXT, -- approve, request_changes, reject
  summary TEXT,
  static_passed INTEGER, -- 0 or 1
  static_findings TEXT, -- JSON
  static_duration INTEGER,
  build_passed INTEGER,
  build_findings TEXT, -- JSON
  build_duration INTEGER,
  dynamic_passed INTEGER,
  dynamic_findings TEXT, -- JSON
  dynamic_duration INTEGER,
  license TEXT,
  dependencies_count INTEGER,
  vulnerabilities_count INTEGER,
  secrets_found INTEGER,
  network_connections TEXT, -- JSON array
  file_operations TEXT, -- JSON array
  syscalls TEXT, -- JSON array
  artifacts_logs_url TEXT,
  artifacts_pcap_url TEXT,
  artifacts_screenshots TEXT, -- JSON array
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tests_app ON test_results(app_id);
CREATE INDEX IF NOT EXISTS idx_tests_recommendation ON test_results(recommendation);
CREATE INDEX IF NOT EXISTS idx_tests_created ON test_results(created_at);

-- Admin Users (for dashboard auth)
CREATE TABLE IF NOT EXISTS admin_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin', -- admin, reviewer
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login TEXT
);

-- Audit Log
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  action TEXT NOT NULL, -- approve_app, reject_app, ban_app, resolve_issue, etc.
  target_type TEXT NOT NULL, -- developer_application, issue_report, app_listing
  target_id TEXT NOT NULL,
  details TEXT, -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_admin ON audit_log(admin_id);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

-- Triggers for updated_at
CREATE TRIGGER IF NOT EXISTS update_dev_app_timestamp
AFTER UPDATE ON developer_applications
BEGIN
  UPDATE developer_applications SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS update_issue_timestamp
AFTER UPDATE ON issue_reports
BEGIN
  UPDATE issue_reports SET updated_at = datetime('now') WHERE id = NEW.id;
END;