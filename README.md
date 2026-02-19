# Artico Sales — Territory Intelligence App

Internal sales tool for Artico PTY LTD field reps. Provides revenue visibility, visit tracking, alerts, product intelligence, and a public rep scoreboard. Live at **sales.artico.au**.

---

## Stack

| Layer | Tech |
|---|---|
| Server | Node.js 20 + Express |
| Database | PostgreSQL (Render managed) |
| Sessions | connect-pg-simple (stored in DB) |
| Revenue data | Zoho Books API v3 (OAuth2) |
| Frontend | Vanilla JS SPA — no framework |
| Hosting | Render (paid plan) |
| CI/CD | GitHub → auto-deploy on push to `main` |

---

## Setup (local dev)

```bash
npm install
cp .env.example .env   # fill in values below
npm start              # runs on http://localhost:3000
```

### Environment variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `SESSION_SECRET` | Random secret for session cookies (32+ chars) |
| `ZOHO_CLIENT_ID` | OAuth2 client ID from Zoho API Console |
| `ZOHO_CLIENT_SECRET` | OAuth2 client secret |
| `ZOHO_REFRESH_TOKEN` | Long-lived refresh token (see Zoho setup below) |
| `ZOHO_ORG_ID` | Zoho Books organisation ID (`689159620`) |
| `PORT` | Server port (default `3000`) |
| `NODE_ENV` | Set to `production` on Render |

---

## Database

Schema lives in `src/db/migrations/`. Apply in order:

```
001_initial.sql       — users, stores, sessions
002_visits.sql        — visits table
003_targets.sql       — rep_targets, brand_targets
004_alerts.sql        — alert_log
```

Run migrations manually on first deploy:
```bash
psql $DATABASE_URL -f src/db/migrations/001_initial.sql
# ... repeat for 002, 003, 004
```

Idempotent startup migrations (alert_log columns) run automatically on server boot.

---

## Zoho Books Integration

**API base:** `https://www.zohoapis.com/books/v3`
**Org ID:** `689159620`
**Auth scope:** `ZohoBooks.fullaccess.all`

### Getting a refresh token

1. Create an OAuth2 client in [Zoho API Console](https://api-console.zoho.com/)
2. Use the "Self Client" flow to generate a one-time authorization code with scope `ZohoBooks.fullaccess.all`
3. Exchange for tokens:
   ```bash
   curl -X POST https://accounts.zoho.com/oauth/v2/token \
     -d "grant_type=authorization_code&client_id=...&client_secret=...&code=..."
   ```
4. Store the `refresh_token` in `ZOHO_REFRESH_TOKEN` env var

### Sync schedule

Invoices are cached in memory and refreshed every **60 minutes** via a background scheduler (`src/services/sync.js`). First request after a cold boot may take up to 30 seconds.

---

## User Roles

| Role | Capabilities |
|---|---|
| `rep` | Own dashboard, own visits, own stores, scoreboard |
| `manager` | Everything above + all reps' data, targets, team admin, products |
| `executive` | Same as manager |

First login: user is prompted to set a password (no password stored until they do).

---

## Alert Engine

Runs nightly at **02:00 AEST/AEDT** via node-cron. Managers can also trigger it manually from the dashboard.

**Tier 1 (action required):**
- A-grade visit breach (not visited in 30d)
- High-value unvisited (top revenue, no visit in 60d)
- Churn risk (no order in 90d, had 12m history)
- SKU gap (grade A store, ≤2 SKUs)
- Rep activity drop (visit count dropped significantly)

**Tier 2 (insights):**
- Outperforming store (revenue up >50% vs prior 6m)
- New door — high value (first order >$500)
- Brand under-index (grade A store missing a brand)
- Focus line (high-reorder SKU not stocked at grade A store)

---

## Product Intelligence

`src/services/productIntelligence.js` — all calculations operate on the in-memory invoice cache.

- **SKU reorder rate** — % of stores that re-ordered a SKU
- **Time to reorder** — median days between consecutive orders
- **Line survival rate** — % of early adopters still stocking at 6m / 12m
- **Brand reorder rate** — brand-level reorder aggregation
- **Repeat vs new mix** — % of order value from repeat vs new SKUs
- **Store behaviour classification** — Replenisher / Rotator / Opportunistic / Under-Optimised

---

## TODO — Zoho Data Configuration

These items require configuration in Zoho and/or `src/config/brands.js` before product intelligence is meaningful:

### Zoho Custom Fields (on Contact)

| Field | API name | Purpose |
|---|---|---|
| Store Grade | `cf_store_grade` | A / B / C grading, synced to `stores.grade` |
| Sales Rep | `cf_sales_rep` | Maps Zoho contact → rep (for store assignment) |
| Category/Channel | `cf_category` | Gift / Toy / Book etc — used in product filters |

**Check these exist** in Zoho Books → Settings → Custom Fields → Contacts. Create if missing.

### SKU Prefix Mapping

`src/config/brands.js` defines brand matching logic. Currently uses keyword matching on item names. For reliable matching, populate `skuPrefixes` with the actual item ID prefixes used in Zoho:

```javascript
// Example:
{ slug: 'name-a-star', skuPrefixes: ['NAS-', 'STAR-'], ... }
{ slug: 'shall-we-bloom', skuPrefixes: ['SWB-'], ... }
```

Contact the Zoho admin or export a CSV of item names to identify prefixes.

### Zoho Item Group IDs

Optionally set `zohoItemGroupId` on each brand in `src/config/brands.js` to enable direct group-based filtering instead of prefix/keyword matching.

---

## Deployment (Render)

- **Service type:** Web Service (Node)
- **Build command:** `npm install`
- **Start command:** `node server.js`
- **Environment:** Set all env vars listed above in the Render dashboard
- **Auto-deploy:** Connected to GitHub `main` branch

DNS: GoDaddy CNAME `sales` → Render service URL.

---

## Feature Summary (Prompts 1–7)

| Prompt | Feature |
|---|---|
| 1 | Foundation: schema, auth, session |
| 2 | Zoho sync: invoices, stores, 60min cache |
| 3 | Auth flows, target grid (rep × month) |
| 4 | Revenue dashboards (rep + team), brand mix, sparkline |
| 5 | Visit logging, store detail, new doors tracking |
| 6 | Alert engine (9 alert types, nightly cron) |
| 7 | Product intelligence, store behaviour, public scoreboard |
