# GVMC Streetlight Command Center — Complete Demo & Operations Guide
## Unified Municipal Streetlight Audit & Governance Platform
### Visakhapatnam — 2,00,000 Streetlight Poles

http://localhost:3000/login.html

Email:    admin@gvmc.gov.in
Password: password

✅ admin@gvmc.gov.in          → SUPER_ADMIN
        Password: password
✅ commissioner@gvmc.gov.in   → GVMC_COMMISSIONER
✅ ee.north@gvmc.gov.in       → GVMC_EE (North Zone)
✅ ee.south@gvmc.gov.in       → GVMC_EE (South Zone)
✅ contractor1@vizagsmartinfra.com → CONTRACTOR
✅ field.raju@gvmc.gov.in     → FIELD_ENGINEER
✅ audit@gvmc.gov.in          → READ_ONLY

All passwords: Gvmc@1234

To Start server->
taskkill /F /IM node.exe
npm start

This is a DNS resolution error — your computer cannot reach Supabase right now. This is a network issue, not a code issue.
Quick Fixes to Try
Fix 1 — Check internet connection:
In bash type - ping google.com

Fix 2 — Test Supabase specifically:
In bash type - ping db.gwfhqapuzmynlqzddgmz.supabase.co

Fix 3 — Flush DNS cache:
In bash type - ipconfig /flushdns

Then try again:
In bash type - npm start

If Still Failing — Check Your .env
Run this to verify your .env is correct:
bashtype .env
Make sure DB_HOST looks exactly like:
DB_HOST=db.gwfhqapuzmynlqzddgmz.supabase.co

Most Likely Cause
Possible reasons:
├── WiFi disconnected or unstable
├── VPN blocking Supabase
├── ISP DNS issue (try Google DNS)
└── Supabase temporary outage

1. Open Docker Desktop     → wait for Engine running
2. docker-compose up -d    → starts database
3. npm run dev             → starts API
4. Open Chrome → localhost:3000

docker-compose up -d   -> wait for   ✔ Container streetlight_db   Healthy
                                     ✔ Container streetlight_api  Started
npm run dev            -> wait for  Visakhapatnam Streetlight Platform
                                    Poles: 2,00,000  |  Port: 3000
http://localhost:3000  ->   Dashboard opens

---

## 📋 TABLE OF CONTENTS
1. System Overview
2. What is Installed on This Laptop
3. Step-by-Step Startup (Every Time)
4. Verification Checklist
5. Dashboard Walkthrough
6. API Testing via Postman
7. Database Queries
8. Troubleshooting
9. Shutdown Procedure
10. Important URLs & Credentials
11. Future Roadmap

---

## 1. SYSTEM OVERVIEW
WHAT THIS PLATFORM DOES:
─────────────────────────────────────────────────────────────
✔ Monitors 2,00,000 streetlight poles across Visakhapatnam
✔ Detects faults automatically (driver failure, cable fault, day burning)
✔ Creates work orders automatically when fault detected
✔ Tracks contractor performance and SLA compliance
✔ Calculates penalties when contractors miss 48-hour deadline
✔ Supports future smart city sensors (environmental, traffic, flood)
✔ Real-time dashboard with live map of Visakhapatnam
✔ Excel export of monthly SLA reports
─────────────────────────────────────────────────────────────
TECHNOLOGY STACK:
─────────────────────────────────────────────────────────────
Database     : PostgreSQL 15 + PostGIS + TimescaleDB
(runs inside Docker container)
Backend API  : Node.js + Express.js
(runs via npm run dev)
Dashboard    : HTML + Leaflet.js + OpenStreetMap
(opens in browser)
Version Control : GitHub
(github.com/Vineeth2002/streetlight-platform)
─────────────────────────────────────────────────────────────
DATABASE TABLES:
─────────────────────────────────────────────────────────────

zones                 — 7 GVMC administrative zones
wards                 — 98 wards with Ward Amenity Secretaries
contractors           — 7 contractors, one per zone
junction_boxes        — CCMS feeder cabinets
poles                 — 2,00,000 streetlight poles
work_orders           — fault tickets with SLA tracking
node_telemetry        — real-time electrical readings (hypertable)
smart_city_attachments — future sensor registry (seed table)
attachment_telemetry  — future sensor data (JSONB hypertable)
spatial_ref_sys       — PostGIS spatial reference (auto-created)
─────────────────────────────────────────────────────────────


---

## 2. WHAT IS INSTALLED ON THIS LAPTOP
SOFTWARE REQUIRED:
──────────────────────────────────────────────────────────
✔ VS Code          — code editor
Download: code.visualstudio.com
✔ Node.js v24      — runs the backend API
Download: nodejs.org (LTS version)
✔ Docker Desktop   — runs the database
Download: docker.com
✔ Postman          — API testing tool
Download: postman.com
✔ Git              — version control
Download: git-scm.com
✔ Google Chrome    — for viewing dashboard
──────────────────────────────────────────────────────────
PROJECT LOCATION:
──────────────────────────────────────────────────────────
C:\streetlight-platform
──────────────────────────────────────────────────────────
GITHUB REPOSITORY:
──────────────────────────────────────────────────────────
https://github.com/Vineeth2002/streetlight-platform
──────────────────────────────────────────────────────────

---

## 3. STEP-BY-STEP STARTUP (EVERY TIME)

### ⚠️ IMPORTANT — Always follow this exact order

---

### STEP 1 — Start Docker Desktop
ACTION:

Press Windows key
Search "Docker Desktop"
Click to open it
Wait until bottom-left shows: "Engine running"
(takes 30-60 seconds)
You will see whale icon 🐳 in taskbar

DO NOT PROCEED until Docker shows "Engine running"

---

### STEP 2 — Open VS Code
ACTION:

Press Windows key
Search "VS Code" or "Visual Studio Code"
Click to open
Click File → Open Folder
Navigate to C:\streetlight-platform
Click "Select Folder"

You should see all project files in left sidebar

---

### STEP 3 — Open Terminal in VS Code
ACTION:
Press Ctrl + ` (backtick key, top-left of keyboard)
OR
Click Terminal → New Terminal from top menu
A terminal opens at the bottom of VS Code
You should see: C:\streetlight-platform>

---

### STEP 4 — Start the Database
TYPE THIS COMMAND AND PRESS ENTER:
docker-compose up -d
WAIT FOR THIS OUTPUT:
✔ Container streetlight_db   Healthy
✔ Container streetlight_api  Started
TIME: Takes 15-20 seconds
IF YOU SEE ERROR "port 3000 already in use":
Run: netstat -ano | findstr :3000
Note the PID number (last number in output)
Run: taskkill /PID <that number> /F
Then run docker-compose up -d again

---

### STEP 5 — Start the API Server
TYPE THIS COMMAND AND PRESS ENTER:
npm run dev
WAIT FOR THIS OUTPUT:
═══════════════════════════════════════
Visakhapatnam Streetlight Platform
Poles: 2,00,000  |  Port: 3000
http://localhost:3000/api/v1
═══════════════════════════════════════
TIME: Takes 3-5 seconds
⚠️  KEEP THIS TERMINAL OPEN
Do not close it while showing demo
Do not press Ctrl+C while showing demo

---

### STEP 6 — Verify Everything is Running
Open Google Chrome browser
Go to: http://localhost:3000/health
YOU SHOULD SEE:
{
"ok": true,
"service": "Streetlight Platform",
"city": "Visakhapatnam",
"total_poles": 200000,
"db": "connected",
"websocket": { "connected": 0 },
"uptime_s": 42
}
IF YOU SEE THIS — PLATFORM IS READY ✔
IF YOU SEE ERROR — CHECK TROUBLESHOOTING SECTION

---

### STEP 7 — Open Dashboard
Open Google Chrome browser
Go to: http://localhost:3000
YOU SHOULD SEE:
✔ Dark blue dashboard
✔ "GVMC STREETLIGHT COMMAND CENTER" header
✔ 4 KPI cards at top (Total Poles, Uptime, Faults, Penalty)
✔ Zone tracker on left side
✔ Visakhapatnam map in center
✔ Audit log at bottom
✔ Live dot 🟢 pulsing next to "LIVE"
Dashboard auto-updates every 10 seconds ✔

---

## 4. VERIFICATION CHECKLIST
Before showing demo — check all these:
[ ] Docker Desktop is open and shows "Engine running"
[ ] Terminal shows "Visakhapatnam Streetlight Platform ONLINE"
[ ] http://localhost:3000/health shows "ok": true
[ ] http://localhost:3000 shows dashboard
[ ] Map of Visakhapatnam is visible
[ ] Zone tracker shows 7 zones with glow rates
[ ] Audit log shows fault entries
[ ] Numbers update every 10 seconds
[ ] Export button downloads Excel file
[ ] No red errors in browser console (F12)

---

## 5. DASHBOARD WALKTHROUGH

### How to explain to GVMC officials:

---

**TOP HEADER — 4 KPI Cards:**
2,00,000        — Total streetlight poles in Visakhapatnam
97.6%           — Current city-wide glow rate (uptime)
Target is 98% as per contractor agreement
4,800           — Number of active faults right now
₹4,25,120       — Total penalty accrued this month
Auto-deducted from contractor invoices

---

**SEARCH BAR:**
WHAT IT DOES:
Search by Pole ID    — e.g. VSP-N-04521
Search by Zone       — e.g. North Zone
Search by Team       — e.g. Team Alpha
RESULT:
Map zooms to that location automatically

---

**LEFT PANEL — Zonal Real-Time Tracker:**
Shows glow rate for each of 7 zones:
✔ Green  = above 98% (meeting SLA target)
🟡 Amber  = 96-98% (needs attention)
🔴 Red    = below 96% (SLA violation risk)
Click any zone → map zooms to that zone

---

**LEFT PANEL — Live Component Diagnostics:**
Motherboard (Salt Decay)  — LED driver PCB corroded by sea air
Visakhapatnam coastal city problem
Overhead Cable Shorts     — cable damage, physical breaks
CCMS Box Failures         — feeder cabinet failures
Day Burning Faults        — lights ON during daytime (wasting energy)

---

**LEFT PANEL — Line Failure Density:**
Single-Pole Outages  — individual pole failures
Partial Line Outages — section of poles failing
Total Loop Blackouts — entire feeder circuit down

---

**CENTER — Live Map:**
Map shows: Visakhapatnam city (OpenStreetMap)
COLORED DOTS:
🟢 Green  = Operational poles
🔴 Red    = Faulty poles
🟡 Amber  = Day burning faults
🔵 Blue   = Under repair
Click any dot → shows Pole ID, fault type, zone, team

---

**BOTTOM — Master Audit Log:**
COLUMNS:
Time Reported  — when fault was detected
Pole/Box ID    — unique identifier (e.g. VSP-N-04521)
Zone           — which zone
Fault Type     — what went wrong
O&M Team       — which contractor team assigned
Status         — 🆕 Just Now / ⚙ In Progress / ✔ Resolved / 🚨 SLA BREACH
Resolution Time — how long it took to fix
SLA            — OK (within 48h) or FAIL (exceeded 48h)
AUTO-UPDATES: Every 10 seconds new faults appear at top

---

**EXPORT BUTTON:**
Click: "📥 Export Monthly SLA Report (Excel)"
Downloads: GVMC_SLA_Report_<Month Year>.xlsx
EXCEL CONTAINS:

All fault records
Resolution times
SLA pass/fail status
Team assignments
Used for contractor invoice audit


---

## 6. API TESTING VIA POSTMAN

### Open Postman and test these endpoints:

---

**TEST 1 — Health Check**
Method : GET
URL    : http://localhost:3000/health
Expected: { "ok": true, "db": "connected" }

---

**TEST 2 — All Zone Glow Rates**
Method : GET
URL    : http://localhost:3000/api/v1/poles/zones
Expected: 7 zones with glow_rate_pct values

---

**TEST 3 — All Contractor KPIs**
Method : GET
URL    : http://localhost:3000/api/v1/poles/contractors
Expected: 7 contractors with invoice and penalty data

---

**TEST 4 — Work Order Statistics**
Method : GET
URL    : http://localhost:3000/api/v1/work-orders/stats
Expected: city_totals with counts by status

---

**TEST 5 — Penalty Simulator**
Method : GET
URL    : http://localhost:3000/api/v1/billing/simulate?wattage=70&days_overdue=3&unresolved_poles=25
Expected:
{
"penalty_a_energy_inr": "27.72",
"penalty_b_demurrage_inr": "1875.00",
"applied_penalty": "DEMURRAGE",
"final_penalty_inr": "1875.00"
}
EXPLAIN TO GVMC:
Penalty A = Energy savings recoupment
2 × (70W × 11h × 3days × ₹6/kWh) = ₹27.72
Penalty B = Late demurrage
₹25 × 3days × 25poles = ₹1875.00
System automatically applies HIGHER of the two ✔

---

**TEST 6 — SLA Breach Audit Dry Run**
Method : POST
URL    : http://localhost:3000/api/v1/billing/audit/dry-run
Expected: preview of penalties without writing to database

---

**TEST 7 — Create Manual Work Order**
Method  : POST
URL     : http://localhost:3000/api/v1/work-orders
Headers : Content-Type: application/json
Body (JSON):
{
"pole_id": 1,
"fault_category": "DRIVER_FAULT",
"fault_description": "LED driver not responding",
"reported_by": "Ward Amenity Secretary"
}

---

**TEST 8 — Simulate Pole Telemetry (Fault Detection)**
Method  : POST
URL     : http://localhost:3000/api/v1/telemetry/node
Headers : Content-Type: application/json
Body (JSON):
{
"pole_number": "VSP-N-00001",
"voltage_rms": 225,
"current_rms": 0,
"active_power": 0,
"power_factor": 0.9,
"cabinet_on": true
}
EXPECTED RESPONSE:
{
"ok": true,
"diagnosis": {
"status": "DRIVER_FAULT",
"severity": "MEDIUM",
"message": "LED driver or lamp failure"
}
}
EXPLAIN TO GVMC:
Voltage is 225V (line is live) but current is 0A
= LED driver has failed
System detects this automatically
Creates work order automatically
No manual inspection needed

---

## 7. DATABASE QUERIES

### Run these in terminal to show live database data:

---

**Connect to database:**
```bash
docker exec -it streetlight_db psql -U streetlight_admin -d streetlight_vssp
```

---

**Show all zones:**
```sql
SELECT zone_id, zone_name, zonal_commissioner FROM zones;
```

---

**Show all contractors with invoice amounts:**
```sql
SELECT company_name, zone_name, monthly_invoice_base, target_glow_rate
FROM v_contractor_kpis;
```

---

**Show all wards:**
```sql
SELECT ward_number, secretariat_code, ward_amenity_sec_name, ward_amenity_sec_phone
FROM wards ORDER BY ward_number;
```

---

**Show work orders:**
```sql
SELECT work_order_id, fault_category, ticket_status, reported_timestamp
FROM work_orders ORDER BY reported_timestamp DESC LIMIT 10;
```

---

**Show SLA violations:**
```sql
SELECT * FROM v_sla_breaches;
```

---

**Show contractor KPIs:**
```sql
SELECT * FROM v_contractor_kpis;
```

---

**Exit database:**
```sql
\q
```

---

## 8. TROUBLESHOOTING

---

**Problem: `docker-compose up -d` gives port 3000 error**
ERROR: ports are not available: port 3000
FIX:

Run: netstat -ano | findstr :3000
Note the PID (last number)
Run: taskkill /PID <number> /F
Run: docker-compose up -d again


---

**Problem: `npm run dev` gives "Database connection failed"**
CAUSE: Docker database not running
FIX:

Check Docker Desktop is open
Run: docker-compose up -d
Wait for "streetlight_db Healthy"
Run: npm run dev again


---

**Problem: Dashboard map is blank**
FIX:

Press Ctrl+Shift+R (hard refresh)
Check internet connection (map needs OpenStreetMap)
Check F12 console for CSP errors


---

**Problem: `npm run dev` gives "logger.error is not a function"**
FIX:
Check src/utils/logger.js exists and has module.exports = logger at bottom

---

**Problem: Docker Desktop not starting**
FIX:

Restart computer
Open Docker Desktop as Administrator
(Right click → Run as Administrator)
Wait 60 seconds for engine to start


---

**Problem: Everything stopped working after laptop restart**
FIX — Run these in order:

Open Docker Desktop → wait for "Engine running"
Open VS Code → open C:\streetlight-platform
Open terminal (Ctrl+`)
Run: docker-compose up -d
Run: npm run dev
Open: http://localhost:3000


---

## 9. SHUTDOWN PROCEDURE

### At end of demo — shut down cleanly:
STEP 1 — Stop the API:
In VS Code terminal where npm run dev is running
Press: Ctrl + C
You will see: "HTTP server closed"
STEP 2 — Stop the database:
In VS Code terminal run:
docker-compose down
Wait for:
✔ Container streetlight_api  Removed
✔ Container streetlight_db   Removed
STEP 3 — Close applications:
Close VS Code
Minimise Docker Desktop (do not quit — or quit if done for the day)
⚠️  NOTE: docker-compose down stops the database
All data is preserved in Docker volume
Next startup: docker-compose up -d restores everything

---

## 10. IMPORTANT URLs & CREDENTIALS
DASHBOARD:
http://localhost:3000
API INDEX:
http://localhost:3000/api/v1
HEALTH CHECK:
http://localhost:3000/health
GITHUB REPO:
https://github.com/Vineeth2002/streetlight-platform
DATABASE:
Host     : localhost
Port     : 5432
Database : streetlight_vssp
Username : streetlight_admin
Password : Vizag@1234
API ENDPOINTS:
GET  /api/v1/poles/zones              — Zone glow rates
GET  /api/v1/poles/contractors        — Contractor KPIs
GET  /api/v1/work-orders              — List work orders
GET  /api/v1/work-orders/stats        — City statistics
GET  /api/v1/work-orders/sla-breaches — Active SLA violations
GET  /api/v1/billing/simulate         — Penalty calculator
POST /api/v1/billing/audit/dry-run    — Preview billing audit
POST /api/v1/telemetry/node           — Ingest pole reading
POST /api/v1/telemetry/attachment     — Smart city sensor data

---

## 11. FUTURE ROADMAP
PHASE 1 — CURRENT (Demo Ready)
✔ Backend API — 21 files
✔ Database — 10 tables
✔ Live dashboard with map
✔ Billing engine with penalty calculation
✔ Excel export
✔ GitHub repository
PHASE 2 — AFTER GVMC APPROVAL
[ ] Connect real CCMS devices from Visakhapatnam poles
[ ] Replace demo data with live telemetry
[ ] Deploy to NIC Cloud / government server
[ ] Add login system for GVMC staff
[ ] Mobile app for Ward Amenity Secretaries
PHASE 3 — SMART CITY EXPANSION
[ ] Environmental sensors (air quality, temperature)
[ ] Traffic camera integration
[ ] Flood/drain monitoring
[ ] Crowd density sensors
[ ] All plug into existing attachment_telemetry table
Zero database changes needed
PHASE 4 — ADVANCED
[ ] Predictive maintenance using AI
[ ] Automated contractor invoice generation
[ ] Integration with GVMC billing system
[ ] WhatsApp alerts to Ward Amenity Secretaries
[ ] Integration with Entro Labs legacy data

---

## 12. SLA PENALTY FORMULAS
48-HOUR SLA RULE:
Every fault must be resolved within 48 hours of reporting.
If not resolved → penalty is automatically calculated.
PENALTY A — Energy Savings Recoupment:
Formula: 2 × (Wattage_kW × 11 hours × Days_Overdue × ₹6.00/kWh)
Example: 70W lamp, 3 days overdue
= 2 × (0.07 × 11 × 3 × 6) = ₹27.72 per pole
PENALTY B — Late Demurrage:
Formula: ₹25 × Days_Overdue × Total_Unresolved_Poles
Example: 3 days overdue, 25 poles unresolved
= ₹25 × 3 × 25 = ₹1,875.00
RULE: System automatically applies HIGHER of A or B
Deducted from contractor monthly invoice

---

## 13. ZONES & CONTRACTORS
ZONE                CONTRACTOR                    MONTHLY INVOICE
────────────────────────────────────────────────────────────────
North Zone        — Vizag Smart Infra Pvt Ltd     ₹42,00,000
South Zone        — Andhra LED Solutions Ltd       ₹38,00,000
Central Zone      — GVMC Street Light Works        ₹51,00,000
East Zone         — Eastern Coastal Electricals    ₹36,00,000
West Zone         — Western Hills Power Services   ₹39,00,000
Gajuwaka Zone     — Gajuwaka Lighting Consortium   ₹45,00,000
Bheemunipatnam    — Coastal Smart Energy Ltd       ₹28,00,000
────────────────────────────────────────────────────────────────
TOTAL CITY INVOICE: ₹2,79,00,000 per month

---

*Document last updated: May 2026*
*Platform version: 1.0.0*
*City: Visakhapatnam — 2,00,000 poles*
*GitHub: github.com/Vineeth2002/streetlight-platform*