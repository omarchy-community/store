# Omarchy Store Backend API Design

## Overview
This document describes the backend API endpoints and VM-based testing infrastructure needed for:
1. Developer application submissions
2. Community issue reporting
3. Automated malware scanning and app validation

---

## 1. Developer Application Endpoint

### `POST /api/developers`

**Request Body:**
```json
{
  "company": "string (required, 1-80 chars)",
  "name": "string (required, 1-80 chars)",
  "email": "string (required, valid email, max 120)",
  "website": "string (optional, valid URL, max 200)",
  "github": "string (optional, max 100)",
  "repo_url": "string (required, valid GitHub URL, max 200)",
  "app_name": "string (required, 1-80 chars)",
  "app_desc": "string (required, 20-3000 chars)",
  "app_url": "string (optional, valid URL, max 300)",
  "wants_paid": "boolean",
  "price_usd": "number (optional, 0.99-999, 2 decimal places)",
  "p_evm": "string (optional, Ethereum/Base address, 0x..., 42 chars)",
  "p_sol": "string (optional, Solana address, 44 chars)",
  "p_btc": "string (optional, Bitcoin address, bc1..., 74 chars)",
  "p_xrp": "string (optional, XRP address, r..., 35 chars)",
  "agree": "boolean (required, must be true)",
  "turnstile_token": "string (required, Cloudflare Turnstile token)"
}
```

**Response (201):**
```json
{
  "success": true,
  "id": "dev_abc123",
  "message": "Application submitted successfully"
}
```

**Response (400):**
```json
{
  "success": false,
  "errors": {
    "company": "Company name is required",
    "repo_url": "Must be a valid GitHub repository URL",
    ...
  }
}
```

**Implementation Notes:**
- Store in Cloudflare D1 or KV
- Send notification email to admin
- Trigger automated repo analysis (see section 3)

---

## 2. Issue Reporting Endpoint

### `POST /api/report`

**Request Body:**
```json
{
  "category": "string (required, enum: unresponsive|not_working|malware|privacy|scam|broken|other)",
  "title": "string (required, 5-100 chars)",
  "description": "string (required, 20-2000 chars)",
  "email": "string (optional, valid email, max 120)",
  "app_id": "string (required, the app/plugin/theme ID being reported)",
  "turnstile_token": "string (required, Cloudflare Turnstile token)"
}
```

**Categories:**
- `unresponsive` - App crashes, freezes, or doesn't launch
- `not_working` - Features don't work as described
- `malware` - Potential malware, spyware, or malicious behavior
- `privacy` - Privacy concerns, data collection issues
- `scam` - Phishing, fake app, or fraudulent listing
- `broken` - Broken features, missing files, install fails
- `other` - Other issues not covered above

**Response (201):**
```json
{
  "success": true,
  "id": "rpt_xyz789",
  "message": "Report submitted successfully"
}
```

---

## 3. VM-Based Testing Infrastructure

### Architecture Overview

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Webhook/Queue  │────▶│  Test Runner    │────▶│  VM Pool        │
│  (GitHub Actions│     │  (Orchestrator) │     │  (Firecracker/  │
│   / Cloudflare) │     │                 │     │   QEMU/KVM)     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                 │                       │
                                 ▼                       ▼
                        ┌─────────────────┐     ┌─────────────────┐
                        │  Results DB     │     │  Report Gen     │
                        │  (D1/PostgreSQL)│     │  (Markdown/JSON)│
                        └─────────────────┘     └─────────────────┘
```

### Test Pipeline Stages

#### Stage 1: Static Analysis (Fast, ~30s)
- **License check** - Verify SPDX identifier matches allowed licenses (MIT, GPL, Apache, BSD, CC0, etc.)
- **Dependency audit** - Scan for known vulnerabilities (GitHub Advisory Database, OSV)
- **Secrets scan** - Detect API keys, tokens, passwords (gitleaks, trufflehog)
- **Malware signatures** - YARA rules for known malware patterns
- **Code quality** - Basic linting, suspicious patterns (eval, obfuscation)

#### Stage 2: Build Verification (Medium, ~2-5 min)
- **Clone repo** - Shallow clone at specific commit/tag
- **Build test** - Run `makepkg`, `cargo build`, `npm run build`, `go build`, etc. based on detected build system
- **Package inspection** - Verify built artifacts match expected outputs
- **Checksum verification** - Compare with released artifacts

#### Stage 3: Dynamic Analysis in VM (Slow, ~5-15 min)
- **VM Setup** - Fresh Arch Linux VM (Firecracker microVM, ~128MB RAM, 1 vCPU)
- **Install app** - Use pacman/yay/AUR helper to install in clean environment
- **Behavioral monitoring** - strace, syscall audit, network captures
- **File system monitoring** - Track file reads/writes outside expected paths
- **Network monitoring** - Capture outbound connections, DNS queries
- **Resource monitoring** - CPU, memory, disk usage
- **Functional test** - Launch app, verify basic functionality

#### Stage 4: Report Generation
- **Summary report** - Pass/Fail per stage, risk score (0-100)
- **Detailed findings** - JSON with all detected issues
- **Recommendation** - Approve / Request changes / Reject
- **Artifacts** - Logs, screenshots, network captures

### VM Configuration

```yaml
# vm-template.yaml
image: archlinux-minimal
cpu: 1
memory: 512M
disk: 2G
network: bridged (isolated VLAN)
kernel: linux-hardened
init: systemd
packages:
  - base
  - base-devel
  - git
  - yay
  - strace
  - audit
  - tcpdump
timeout: 600s
snapshot: clean-base
```

### Test Runner Implementation (Cloudflare Worker + GitHub Actions)

**Option A: GitHub Actions (Recommended for Start)**
```yaml
# .github/workflows/app-test.yml
on:
  repository_dispatch:
    types: [test-app]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Setup Firecracker
        run: |
          # Install firecracker, create microVM
      - name: Run Static Analysis
        run: ./scripts/static-analysis.sh ${{ github.event.client_payload.repo_url }}
      - name: Run Build Test
        run: ./scripts/build-test.sh ${{ github.event.client_payload.repo_url }}
      - name: Run Dynamic Test
        run: ./scripts/dynamic-test.sh ${{ github.event.client_payload.repo_url }}
      - name: Generate Report
        run: ./scripts/generate-report.sh
      - name: Store Results
        run: |
          curl -X POST https://api.omarchystore.com/api/test-results \
            -H "Authorization: Bearer ${{ secrets.API_TOKEN }}" \
            -d @report.json
```

**Option B: Dedicated Test Runner Service**
- Persistent VM pool (Firecracker on bare metal or cloud)
- Queue-based (Redis/RabbitMQ)
- Horizontal scaling
- Better isolation, faster cold starts

### Scanning Tools Stack

| Purpose | Tool | Notes |
|---------|------|-------|
| Secrets | gitleaks, trufflehog | Fast, low false positives |
| Malware | YARA + custom rules | ClamAV for binaries |
| Dependencies | OSV-Scanner, GitHub Advisory DB | Language-agnostic |
| Static Analysis | Semgrep, CodeQL | Configurable rules |
| Dynamic | strace, auditd, sysdig | In-VM monitoring |
| Network | tcpdump, Zeek | PCAP analysis |
| License | scancode-toolkit | SPDX detection |

### Report Format

```json
{
  "test_id": "test_abc123",
  "app_id": "dev_abc123",
  "repo_url": "https://github.com/user/app",
  "commit": "a1b2c3d",
  "timestamp": "2026-10-13T12:00:00Z",
  "duration_seconds": 420,
  "stages": {
    "static": { "passed": true, "findings": [], "duration": 25 },
    "build": { "passed": true, "findings": [], "duration": 180 },
    "dynamic": { "passed": true, "findings": [], "duration": 215 }
  },
  "risk_score": 15,
  "recommendation": "approve",
  "summary": "App builds cleanly, installs successfully, no suspicious behavior detected.",
  "details": {
    "license": "MIT",
    "dependencies": 42,
    "vulnerabilities": 0,
    "secrets_found": 0,
    "network_connections": ["api.github.com:443"],
    "file_operations": ["/etc/app.conf", "/usr/bin/app"],
    "syscalls": ["open", "read", "write", "connect"]
  },
  "artifacts": {
    "logs_url": "https://storage.omarchystore.com/test_abc123/logs.txt",
    "pcap_url": "https://storage.omarchystore.com/test_abc123/capture.pcap",
    "screenshots": []
  }
}
```

---

## 4. Admin Dashboard Features

### Developer Applications View
- List all pending/approved/rejected applications
- Show: company, name, email, app_name, repo_url, submitted_at
- Actions: Approve, Reject, Request Changes
- On Approve: Create draft app listing, notify developer

### Issue Reports View
- List all reports with filters (category, app_id, status)
- Show: category, title, description, email, app_id, submitted_at
- Actions: Investigate, Mark Resolved, Dismiss, Ban App
- On Ban: Remove from store, notify users

### Test Results View
- Show test results per application
- Risk score visualization
- Download artifacts (logs, PCAPs)
- Re-run test button

---

## 5. Implementation Roadmap

### Phase 1: API Endpoints (Week 1-2)
- [ ] Cloudflare Worker for `/api/developers`
- [ ] Cloudflare Worker for `/api/report`
- [ ] Cloudflare D1 database schema
- [ ] Turnstile verification
- [ ] Email notifications (Cloudflare Email Workers or SendGrid)

### Phase 2: Static Analysis Pipeline (Week 2-3)
- [ ] GitHub Action for static analysis
- [ ] License detection
- [ ] Dependency vulnerability scan
- [ ] Secrets detection
- [ ] Basic YARA malware rules

### Phase 3: Build & Dynamic Testing (Week 3-5)
- [ ] Firecracker microVM setup
- [ ] Arch Linux base image creation
- [ ] Build system detection & execution
- [ ] strace/auditd integration
- [ ] Network capture & analysis

### Phase 4: Report Generation & Dashboard (Week 5-6)
- [ ] Automated report generation
- [ ] Risk scoring algorithm
- [ ] Admin dashboard (separate admin site)
- [ ] Notification system (email, Discord, Telegram)

### Phase 5: Production Hardening (Week 6-8)
- [ ] VM pool scaling
- [ ] Rate limiting & abuse prevention
- [ ] False positive reduction
- [ ] Performance optimization
- [ ] Documentation & runbooks

---

## 6. Security Considerations

- **VM Isolation**: Each test runs in fresh microVM, destroyed after
- **Network Isolation**: Test VMs on isolated VLAN, no internet except allowlisted (GitHub, package repos)
- **Data Handling**: No secrets stored in test results, only hashes
- **Rate Limiting**: Max 10 tests/hour per IP, 100/day per repo
- **Audit Trail**: All test executions logged with operator ID

---

## 7. Cost Estimation

| Component | Monthly Cost (Est.) |
|-----------|---------------------|
| Cloudflare Workers (API) | $5-10 |
| Cloudflare D1 (Database) | $5 |
| Cloudflare R2 (Artifacts) | $5-15 |
| GitHub Actions (CI) | Free (public repos) / $0.008/min (private) |
| Firecracker VMs (Hetzner/Equinix) | $50-200 |
| **Total** | **~$65-230/month** |

---

## 8. Next Steps

1. **Immediate**: Deploy API endpoints with basic storage
2. **Short-term**: Build static analysis GitHub Action
3. **Medium-term**: Implement VM-based dynamic testing
4. **Long-term**: Full admin dashboard with approval workflow