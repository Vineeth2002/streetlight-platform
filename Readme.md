# GVMC Streetlight Monitoring Platform

**Municipal Infrastructure Asset Intelligence Platform — Streetlight Module**

A role-based command center for managing streetlight infrastructure across Greater Visakhapatnam Municipal Corporation (GVMC). Built as a proof-of-concept demonstrating asset monitoring, SLA tracking, contractor accountability, and automated billing for 2,00,000 streetlight poles across 7 zones and 98 wards.

🔗 **Live Demo:** https://streetlight-platform.onrender.com

---

## Platform Philosophy

> **Decision Support System, NOT Decision Making System**

The platform detects, analyzes, and recommends. Final decisions — penalty approval, fault verification, closure — remain with authorized GVMC officials.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express |
| Database | PostgreSQL (Neon, Singapore region) |
| Auth | JWT + bcrypt, refresh tokens, brute-force protection |
| Real-time | WebSocket |
| Maps | Leaflet + OpenStreetMap |
| Charts | Chart.js |
| Email | Nodemailer (SMTP) |
| Hosting | Render |
| Scheduling | node-cron |

---

## User Roles

| Role | Dashboard | Access |
|---|---|---|
| `SUPER_ADMIN` | `/index.html` | Full access + user management |
| `GVMC_COMMISSIONER` | `/index.html` | Full read access + reports |
| `GVMC_EE` | `/ee-dashboard.html` | Zone-scoped view |
| `CONTRACTOR` | `/contractor.html` | Own work orders + billing |
| `FIELD_ENGINEER` | `/field.html` | Assigned jobs (mobile-first) |
| `READ_ONLY` | `/index.html` | View-only, no exports |

Demo credentials: see `db/003_seed.sql` and `scripts/create-users.js`.

---

## Project Structure

```
streetlight-platform/
├── config/
│   └── database.js          — PostgreSQL connection (SSL auto-detect for Neon/Supabase)
├── db/
│   ├── 001_schema.sql       — Core tables (zones, wards, poles, work_orders, etc.)
│   ├── 002_triggers.sql     — SLA auto-flagging, timestamp triggers
│   ├── 003_seed.sql         — Zones, wards, contractors seed data
│   ├── 004_security.sql     — Users, audit_log, api_keys, refresh_tokens, glow snapshots
│   └── migrate.js
├── public/
│   ├── login.html           — Government-standard login page
│   ├── index.html           — Main command center (Admin/Commissioner/Read-Only)
│   ├── ee-dashboard.html    — Executive Engineer zone dashboard
│   ├── contractor.html      — Contractor portal
│   ├── field.html           — Field engineer mobile app
│   ├── admin.html           — User management UI
│   └── demo-data.js         — Shared demo data store (window.SL_DEMO)
├── scripts/
│   └── create-users.js      — Seed the 6 role-based demo users
└── src/
    ├── index.js             — Express app entry point
    ├── middleware/
    │   └── auth.js          — JWT verification, RBAC, audit logging
    ├── routes/
    │   ├── auth.js          — Login, refresh, logout, change password
    │   ├── admin.js         — User CRUD (SUPER_ADMIN only)
    │   ├── poles.js         — Pole CRUD, zone glow rates, search
    │   ├── workOrders.js    — Work order CRUD, role-filtered
    │   ├── telemetry.js     — CCMS node ingestion (API key or JWT)
    │   ├── attachments.js   — Smart city sensor attachments
    │   └── billing.js       — SLA penalty engine, monthly reports
    ├── services/
    │   ├── diagnosticEngine.js   — Fault detection from telemetry
    │   ├── slaBillingService.js  — Penalty calculation + monthly cron
    │   ├── reportService.js      — HTML monthly report generator
    │   ├── emailService.js       — SMTP wrapper
    │   └── modbusService.js      — CCMS command dispatch (mock)
    ├── utils/
    │   └── logger.js
    └── websocket/
        └── wsServer.js       — Live telemetry broadcast
```

---

## Setup — Local Development

### 1. Clone and install
```bash
git clone https://github.com/Vineeth2002/streetlight-platform.git
cd streetlight-platform
npm install
```

### 2. Environment variables
Copy `.env.example` to `.env` and fill in your values (see below).

### 3. Database setup
Create a free [Neon](https://neon.tech) PostgreSQL project (Singapore region recommended), then run these SQL files in order via the Neon SQL Editor:
```
db/001_schema.sql
db/002_triggers.sql
db/003_seed.sql
db/004_security.sql
```

### 4. Seed users
```bash
node scripts/create-users.js
```

### 5. Start the server
```bash
npm start
```
Visit `http://localhost:3000`

---

## Deployment (Render)

1. Push to GitHub
2. Connect repo on [Render](https://render.com) as a Web Service
3. Set all environment variables (see `.env.example`) in Render's dashboard
4. Set `NODE_ENV=production` and `ALLOWED_ORIGINS=https://your-app.onrender.com`
5. Deploy — Render auto-redeploys on every push to `main`

**Note:** Render free tier sleeps after inactivity; first request after sleep takes ~30s to wake.

---

## Key Features

- **Role-based dashboards** — each role sees only what's relevant to them
- **SLA engine** — 48-hour resolution window, auto-flags violations
- **Dual penalty formula** — energy-loss based (Penalty A) vs demurrage (Penalty B), higher applies
- **Monthly glow-rate tracking** — 95% minimum threshold, 97% target, with historical snapshots
- **5-layer Component Inspector** — location/accountability, electrical params, ticket lifecycle, maintenance history, smart-city port status
- **Shared demo data store** (`demo-data.js`) — consistent data across all role dashboards until real pole data is imported
- **Session timeout** — 30 minutes of inactivity auto-logs out
- **Audit logging** — every login, user action, and data change is logged
- **Mobile responsive** — all dashboards adapt to phone/tablet screens

---

## Known Limitations (Demo Stage)

- No real pole inventory yet — uses consistent demo data (`window.SL_DEMO`)
- No live CCMS/telemetry hardware connected — `diagnosticEngine.js` is ready but unfed
- Penalty auto-applies rather than routing through an approval workflow (planned)
- SMTP email configured but not yet connected to a production mailbox
- Currently hosted on Neon (AWS Singapore) — plan is migration to NIC / AP State Data Centre for production

---

## Roadmap

| Phase | Focus |
|---|---|
| 1 | Asset Registry — real pole/CCMS inventory from GVMC |
| 2 | Approval workflow — human-in-the-loop for fault verification & penalties |
| 3 | Real telemetry — CCMS hardware integration |
| 4 | AI recommendation engine — confidence-scored fault diagnosis |

See `/areas/streetlight-platform` notes for the full GVMC field-visit questionnaire and stakeholder feedback log.

---

## License

Internal municipal project — not currently licensed for public redistribution.

