# SokoMtaani — Duka la Mboga · Nairobi

**SokoMtaani** ("our market" in Swahili) is a phone-first Point-of-Sale and stock-management system for a Kenyan small shop. It replaces paper/mental bookkeeping with:

- a fast, one-thumb **POS till** for attendants (weighed produce, piece/bunch items, fixed-price buttons),
- **FIFO stock batches** with computed cost-per-unit and exact per-sale cost/profit snapshots,
- an **offline-first sale queue** — sales are never lost because the network blinked,
- **attendant PIN** login with per-attendant sales attribution,
- owner screens for **products, stock batches, sales, wastage, dashboard, and team**.

This document is the complete reference for the system as it exists today. For the product brief see [`PRODUCT.md`](PRODUCT.md); for the technical audit and the V1 blueprint see [`POS_V1_AUDIT.md`](POS_V1_AUDIT.md).

---

## Table of contents

1. [Features](#features)
2. [Tech stack](#tech-stack)
3. [Repository layout](#repository-layout)
4. [Getting started](#getting-started)
5. [Configuration](#configuration)
6. [Data model](#data-model)
7. [Pricing & costing model](#pricing--costing-model)
8. [Offline-first sales & sync](#offline-first-sales--sync)
9. [Voiding](#voiding)
10. [Business day & timezone](#business-day--timezone)
11. [Money precision invariant](#money-precision-invariant)
12. [API reference](#api-reference)
13. [Frontend structure](#frontend-structure)
14. [Testing](#testing)
15. [Deployment](#deployment)
16. [Related documents](#related-documents)

---

## Features

**Till (POS)**
- Large tappable product grid, decimal quantity steppers, fixed-price buttons ("1/4 kg", "3 @ KSh20").
- Two pricing modes per product: **weighed** (sold by weight/measure) and **counted** (sold by piece/bunch).
- PIN-gated checkout — every sale is attributed to the attendant whose PIN was entered.
- Offline indicator + queued-sale badge with manual "Sync now".

**Owner screens**
- **Dashboard** — today's revenue/cost/profit (Kenya business day), per-product margins, low-margin sales, low-stock alerts, revenue/profit chart.
- **Products** — card grid, CRUD, base-unit selector (kg/piece/litre), pricing mode, price buttons.
- **Stock batches** — record bulk purchases, auto-computed cost-per-base-unit, open/close batches, per-batch P&L for counted products.
- **Sales** — filterable (date range, attendant, product), paginated, transaction grouping, CSV export, void.
- **Attendants** — list, PIN reset.
- **Wastage** — log losses (spoilage/damage/other); deducted from stock FIFO; visible to attendants too.

**Reliability**
- Offline queue persisted to `localStorage`, idempotent per-line sync with conflict detection.
- Exact void restore — stock returns to the batches that actually supplied it.
- Money kept at full float precision end-to-end; rounding only at display/export.

---

## Tech stack

**Frontend** (`src/`) — React 19, TypeScript, Vite 8, Tailwind CSS v4, React Router 7, Recharts, lucide-react. No component library or state library — hand-rolled Tailwind components and a small reducer store.

**Backend** (`backend/`) — Flask 3 app factory, Flask-SQLAlchemy, Flask-Migrate (Alembic), Flask-JWT-Extended, Flask-Cors, marshmallow (+ marshmallow-sqlalchemy), bcrypt (PIN hashing), python-dotenv. Served with gunicorn; `psycopg2-binary` for PostgreSQL.

**Database** — SQLite for development (`backend/sokomtaani_dev.db`), PostgreSQL in production (via `DATABASE_URL`).

**Hosting** — Frontend on Vercel; backend on Render. `vercel.json` rewrites `/api/*` to the Render backend and serves the SPA.

---

## Repository layout

```
├── src/                        # React frontend
│   ├── App.tsx                 # Routing + login gate + role guards
│   ├── components/
│   │   ├── layout/             # AppShell, nav (nav.ts), RequireOwner
│   │   ├── pos/                # ProductTile, ButtonPicker, PinModal, posMeta, ...
│   │   └── ui/                 # Buttons, cards, forms, modals, empty states
│   ├── hooks/useOffline.ts     # online/offline detection + demo toggle
│   ├── lib/                    # api, auth, calc, constants, format, id, store, sync, types, utils
│   └── pages/                  # Pos, Dashboard, Products, Batches, Sales, Wastage, Attendants, Login
├── backend/
│   ├── app/
│   │   ├── __init__.py         # create_app() app factory
│   │   ├── extensions.py       # db, migrate, jwt, cors + bcrypt PIN helpers
│   │   ├── models/             # attendant, product, price_button, stock_batch, sale, wastage
│   │   ├── routes/             # auth, products, batches, sales, wastage, attendants, dashboard
│   │   ├── schemas/            # marshmallow schemas per entity
│   │   └── utils/              # timezone.py (Kenya business day), unit_conversion.py
│   ├── migrations/             # Alembic migrations (8 versions)
│   ├── tests/                  # 6 standalone test suites (43 tests)
│   ├── config.py               # Dev (SQLite) / Prod (PostgreSQL) configs
│   ├── requirements.txt
│   ├── run.py                  # dev entry point
│   └── seed.py                 # idempotent demo-data seeder
├── vercel.json                 # /api proxy → Render + SPA fallback
├── vite.config.ts              # dev server + /api proxy to :5000
└── package.json
```

---

## Getting started

### Prerequisites
- Node.js ≥ 20 and npm
- Python 3.10+ (3.12 recommended)

### Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env             # optional — sensible dev defaults exist
flask db upgrade                 # apply the 8 Alembic migrations
python seed.py                   # optional — realistic Kenyan demo data
python run.py                    # http://localhost:5000
```

> Use the venv's interpreter for tests too: `backend/.venv/bin/python backend/tests/<file>.py`.

### Frontend

```bash
npm install
npm run dev        # http://localhost:5173 — /api is proxied to :5000
```

Other scripts: `npm run build` (typecheck + production build), `npm run typecheck` (`tsc -b --noEmit`), `npm run preview`.

### Demo login (from `seed.py`)

| Name | Role | PIN |
|---|---|---|
| Wanjiku Kamau | owner | 1240 |
| Otieno Ochieng | attendant | 3168 |
| Achieng Adhiambo | attendant | 2057 |
| Maina Kariuki | attendant | 4821 |

The seed script clears existing data first and is safe to re-run. Seeded data is **demonstration data only**, not real client records.

---

## Configuration

All settings live in `backend/config.py`, driven by environment variables (`.env` in `backend/` for dev):

| Variable | Default | Notes |
|---|---|---|
| `FLASK_ENV` | `development` | `development` → SQLite, `production` → PostgreSQL |
| `DATABASE_URL` | `sqlite:///backend/sokomtaani_dev.db` | PostgreSQL URI in production (`postgres://` is auto-upgraded to `postgresql://`) |
| `SECRET_KEY` | dev fallback | **Required in production** — `create_app("production")` raises if unset |
| `JWT_SECRET_KEY` | dev fallback | **Required in production** — same fail-fast guard |
| `CORS_ORIGINS` | `http://localhost:5173` | Comma-separated list |
| `LOW_MARGIN_THRESHOLD` | `0.10` | Fraction; dashboard flags sales below this margin |
| `SHOP_TIMEZONE` | `Africa/Nairobi` | All business-day calculations |
| `DEFAULT_PAGE_SIZE` | `100` | Pagination default |

JWT access tokens expire after **12 hours** (the till session). Tokens travel in the `Authorization: Bearer <token>` header.

---

## Data model

Six tables (see `backend/app/models/`):

### Attendant (`attendants`)
Staff and owner. `id`, `name`, `pin_hash` (bcrypt — **never serialized in any API response**), `shop_role` (`owner` | `attendant`), `active`.

### Product (`products`)
A single sellable item. `name` (globally unique), `category` (`produce` | `dry` | `packaging`), `base_unit` (`kg` | `piece` | `litre`), `pricing_mode` (`weighed` | `counted`), `avg_piece_weight` (kg per piece, for piece→kg conversion), `sell_price` (per base unit), `current_cost_per_unit` (cached from the oldest open batch), `reorder_threshold` (low-stock alert), and a list of `price_buttons`.

### PriceButton (`price_buttons`)
A fixed-price option on the till. `label` (e.g. `"1/4 kg"`, `"3 @ KSh20"`), `price` (Numeric 10,2, KES), `sort_order`, and **`kg_amount`** (Numeric 10,3) — the exact amount of the product's base unit the option consumes from stock. Despite the historical name, it is an *amount in base unit*, used by both modes (see [Pricing & costing](#pricing--costing-model)). `NULL` on legacy counted buttons (untracked estimate options).

### StockBatch (`stock_batches`)
One bulk purchase of a product. `bulk_quantity`, `bulk_unit` (e.g. `bag`, `crate`, `kg`), `total_cost` (KES), `cost_per_base_unit` (computed as `total_cost / base-unit quantity`), `quantity_remaining` (base unit, decremented by sales/wastage), `date_received`, `status` (`open` | `closed`), `closed_at`. Batches auto-close when `quantity_remaining` hits 0. For counted products, `revenue_so_far` and `profit_loss` provide batch-level P&L (`revenue − total_cost`).

### Sale (`sales`)
**One row per line item** — a cart of N lines becomes N Sale rows sharing a transaction id. Key fields:

- `client_uuid` (unique) — phone-generated id, the basis of offline idempotency.
- `product_id`, `batch_id` (the batch that supplied the sale), `attendant_id`.
- `quantity_sold`, `unit_sold_in` (`kg`/`piece`/`litre`), `price_charged` (KES per unit sold).
- `cost_at_sale`, `profit` — **snapshots taken at sync time, never recalculated**.
- `sync_status` (`pending` | `synced` — the server stores only `synced`), `created_at` (client timestamp), `synced_at` (server timestamp).
- `voided_at`, `voided_by` — null unless voided (rows are kept, stock restored).
- `batch_allocations` (JSON) — the exact per-batch deduction map `[{"batch_id": int, "qty": float}]`, used for exact void restore.
- `sale_uuid` — transaction-level id (the phone's cart id) that groups a checkout's lines.
- Snapshots so history survives edits: `product_name_snapshot`, `button_label_snapshot`, `button_count_snapshot` (how many times the button was sold, e.g. "3 × 1 tomato"), `quantity_base` (base-unit amount actually consumed).

### Wastage (`wastage`)
Stock written off. `product_id`, `batch_id` (FIFO-resolved), `quantity` (base unit), `reason` (`spoilage` | `damage` | `other`), `date`, `recorded_by` — **always derived from the JWT identity server-side, never from the client payload**.

---

## Pricing & costing model

The heart of the system. Every sellable option on the till is **`(label, amount in base unit, fixed price)`**, and the pricing mode only changes *how the amount is expressed*:

### Weighed mode (default) — "sold by weight/measure"
- Stock is tracked in the base unit; buttons carry an exact `kg_amount` (`0.25` for "1/4 kg").
- A sale logs `quantity_sold = kg_amount`, `price_charged = price / kg_amount` (e.g. KSh40 for ¼ kg → 160/kg).
- Cost is computed **FIFO across open batches** (oldest first), per-sale cost/profit are exact, stock deducts exactly the amount.

### Counted mode — "sold by piece/bunch"
- Stock is still tracked in the base unit; buttons are fixed prices ("1 @ KSh5", "3 @ KSh20").
- A button **may carry an amount** (`kg_amount = 3` pieces). Such a sale routes through the *exact same FIFO path* as weighed: deduct 3 pieces, snapshot cost/profit. `amount_in_base_unit` is sent with the sync payload to trigger this.
- A button **without an amount** is a *legacy untracked estimate option*: the sale logs at the button's price against the oldest open batch, deducts nothing, and its profit lives at the **batch level** (`revenue_so_far − total_cost`). This keeps pre-existing data and history working exactly as before.

### Rules enforced by the API
- Weighed buttons must all carry an amount; counted buttons may carry one (recommended) or none (legacy).
- **New** counted products must have at least one button, and every button must carry an amount (full stock tracking).
- A product's `pricing_mode` or `base_unit` **cannot change while open batches exist** — the accounting model of live stock can't be safely reinterpreted; close the batches first.
- In sync, when a tracked counted option is sold in its base unit, `amount_in_base_unit` must equal `quantity_sold` or the line is rejected (prevents silent deduction drift).

### Stock / FIFO (`_fifo_deduct` in `routes/sales.py`)
Walks open batches oldest-first, takes `min(remaining, needed)` from each, and computes a **weighted-average cost across all consumed batches** (so a portion spanning several batches gets the honest blended cost). Returns `(cost_per_base_unit, first_batch, allocations)`. Wastage reuses the same function. Overselling is rejected per-line with "Insufficient stock…" and sibling lines still sync.

---

## Offline-first sales & sync

### The queue
- Every checkout dispatches `CHECKOUT`, which appends the sale to the offline queue in `localStorage` (`soko-mtaani/v2`) as **`pending` — always**.
- If online, the sale is pushed to the server immediately; the local record is removed **only after the server acknowledges** (`REMOVE_SALE`). If the phone dies mid-flight, the sale stays `pending` and retries — it can never be marked synced without a server ack.
- On a **server rejection** (e.g. insufficient stock, uuid conflict), the sale stays queued and the server's reason is stored on it (`syncError`) and shown to the attendant.
- On a **network failure** (no verdict), it stays queued and retries silently.
- Auto-sync fires on reconnect; there is also a manual "Sync now" from the connection badge. A demo offline toggle (`soko-mtaani/demo-offline` in localStorage) simulates flaky connectivity.

### The sync endpoint — `POST /api/sales/sync`
Body: `{ "sales": [ SyncSaleItem, ... ] }`. Each line is processed independently and gets its own result, so the client retries only the failures:

1. **Idempotency** — the server dedups by `client_uuid` (format `${saleId}-${productId}-${lineIndex}`, which keeps repeated lines for the same product distinct). A genuine retry (same uuid, identical payload within a 2s timestamp tolerance) is acked as `duplicate`; the **same uuid with different content** is surfaced as a hard `error` (cross-device id collision) rather than silently dropped.
2. **Attribution trust** — a non-owner's payload `attendant_id` is ignored; the JWT identity is authoritative. Only the owner (who PIN-verifies at the till) may attribute a sale to a different attendant.
3. **Validation → product/attendant lookup → costing (weighed / tracked-counted FIFO, or legacy estimate) → persist** with snapshots and allocations.

### The till flow
Tap product tile → price-button picker (or stepper for flat-rate items) → cart lines carry `productId, qty, unit, unitPrice, tierLabel, amountInBaseUnit, count` → **Charge** → PIN modal (`verify-pin`) → `CHECKOUT` → queue + push.

---

## Voiding

`POST /api/sales/<id>/void` reverses a synced sale and restores its stock:

- **Authorization** — owners void anything, anytime; attendants may void only their own sales within 15 minutes of the sale.
- **Restore** — stock goes back per `batch_allocations` (each unit returns to the batch that supplied it); a batch that auto-closed is reopened. Legacy rows without allocations restore to the recorded batch (preferring the stored `quantity_base` so the restore is exact even if conversion config changed since).
- **Legacy counted sales** (never deducted) have nothing to restore — their revenue just leaves the batch's P&L.

Voided rows are kept and flagged; they are hidden from lists unless the owner opts in with `include_voided=true`, and excluded from dashboard/daily figures.

---

## Business day & timezone

The shop's business day is **Africa/Nairobi (EAT, UTC+3)**, not UTC. "Today's" numbers, `?date=` filters, and the dashboard series are computed in Kenya time (`backend/app/utils/timezone.py`):

- A Kenya business day (00:00–24:00 EAT, UTC+3) runs **21:00 UTC → 21:00 UTC**, so a sale at 00:30 EAT belongs to the Kenyan day that started the previous UTC calendar day.
- The dashboard `/series?days=N` endpoint aggregates **server-side** per Kenya day, zero-filled (no chart holes), excluding voided sales — bulk history never crosses the wire.

---

## Money precision invariant

`price_charged`, `quantity_sold`, `cost_at_sale`, and `profit` are stored at **full float precision**. KES rounding happens **only at serialisation/display** (`round(x, 2)`). This matters for odd-sized buttons: KSh20 for 0.75 kg means `price_charged = 20/0.75 = 26.666…`, and that full-precision rate must flow through revenue and profit so they round back to the exact shillings. The test `test_odd_sized_button_sales_keep_exact_money` pins this invariant — it fails if anything rounds mid-chain.

---

## API reference

Base: `/api` (proxied by Vite in dev; by `vercel.json` in production). All endpoints except login require `Authorization: Bearer <jwt>`. Owner-only endpoints return 403 for attendants.

### Auth — `routes/auth.py`
| Method | Path | Body / params | Notes |
|---|---|---|---|
| POST | `/auth/login` | `{ attendant_id, pin }` | Returns `{ access_token, attendant }`. JWT identity = attendant id; `role` in claims. |
| POST | `/auth/logout` | — | Stateless; client discards the token. |
| POST | `/auth/verify-pin` | `{ attendant_id, pin }` | Till PIN check without issuing a token; 200 on match, 401 otherwise. |
| GET | `/auth/me` | — | Current attendant info. |

### Products — `routes/products.py` (owner-only writes)
| Method | Path | Notes |
|---|---|---|
| GET | `/products` | All products with stock level + low-stock flag. |
| POST | `/products` | Create. Counted products need ≥1 button; new counted buttons all need amounts. |
| PUT | `/products/<id>` | Update. `pricing_mode`/`base_unit` switches blocked while open batches exist. |
| GET | `/products/<id>/stock` | `{ total_stock, is_low_stock, reorder_threshold }`. |

### Batches — `routes/batches.py` (owner-only writes)
| Method | Path | Notes |
|---|---|---|
| GET | `/batches` | Filter by `?product_id=&status=open\|closed`. |
| POST | `/batches` | `{ product_id, bulk_quantity, bulk_unit, total_cost, date_received? }` → computes `cost_per_base_unit`. |
| PUT | `/batches/<id>/close` | Manually close a batch (409 if already closed). |

### Sales — `routes/sales.py`
| Method | Path | Notes |
|---|---|---|
| POST | `/sales/sync` | Bulk offline sync; per-line results `synced \| duplicate \| error` with reasons. |
| GET | `/sales` | Filter `?date=&attendant_id=&product_id=&include_voided=`; capped at 500; Kenya-day `date` filter. |
| GET | `/sales/page` | Paginated (`?from=&to=&attendant_id=&product_id=&page=&per_page=`); returns `{ items, total, page, per_page, has_more }`. |
| GET | `/sales/export` | CSV of the current Sales view; same filters + role scoping; voided flagged; BOM + formula-injection neutralised. |
| GET | `/sales/daily-summary` | `?date=` or `?from=&to=`; revenue/cost/profit/count/margin for Kenya business day(s). |
| POST | `/sales/<id>/void` | Void + exact stock restore (owner anytime; attendant own-sale < 15 min). |

### Wastage — `routes/wastage.py`
| Method | Path | Notes |
|---|---|---|
| POST | `/wastage` | `{ product_id, quantity, reason?, date? }` — `recorded_by` derived from JWT; deducts FIFO. |
| GET | `/wastage` | Filter `?product_id=&attendant_id=&date=`. |

### Attendants — `routes/attendants.py`
| Method | Path | Notes |
|---|---|---|
| GET | `/attendants` | List (never includes PIN hashes). |
| POST | `/attendants/<id>/reset-pin` | Owner-only; `{ pin }` must be 4 digits. |

### Dashboard — `routes/dashboard.py`
| Method | Path | Notes |
|---|---|---|
| GET | `/dashboard/summary` | Today (Kenya day): revenue/cost/profit, per-product margins, low-margin sales, low-stock products. Counted products without tracked sales report `margin_pct: null`. |
| GET | `/dashboard/series` | `?days=N` (1–90, default 14): zero-filled per-day revenue/profit/count. |

### Health
| Method | Path | Notes |
|---|---|---|
| GET | `/health` | `{ "status": "ok", "app": "SokoMtaani" }`. |

---

## Frontend structure

- **`App.tsx`** — login gate (no JWT → `LoginPage`), routes: `/pos` (any role), `/` Dashboard, `/products`, `/batches`, `/attendants`, `/sales` (all `RequireOwner`), `/wastage` (any role). Route-level code-splitting via `lazy()`.
- **`components/layout/nav.ts`** — nav model. Owners see Till / Sales / Goods / Owner sections; attendants only see Till (POS) and Goods → Wastage.
- **`components/pos/`** — the till: `ProductTile`, `ButtonPicker`, `PinModal`, `posMeta` (line-unit-price math), cart.
- **`lib/api.ts`** — thin fetch wrapper; injects the JWT, parses JSON, treats 401 as a dead session (except on login/verify-pin, where it's just a wrong PIN). One redirect per page load.
- **`lib/store.tsx`** — `useReducer` store persisted to `localStorage` (`soko-mtaani/v2`); holds **only the offline queue** (`OfflineSale[]` + `nextSaleNumber`). Synced sales are not kept locally.
- **`lib/sync.ts`** — builds per-line sync payloads and pushes to the server, distinguishing server rejections from network failures.
- **`lib/auth.ts`** — token/user persistence (`soko-jwt`, `soko-user`), login/logout, role checks.
- **`hooks/useOffline.ts`** — `navigator.onLine` + persisted demo-offline toggle.
- **`lib/calc.ts`, `lib/format.ts`, `lib/id.ts`, `lib/utils.ts`, `lib/constants.ts`** — money/quantity math, KES formatting, id generation, shared helpers, wastage reasons.

---

## Testing

43 tests across 6 suites in `backend/tests/`. They are **plain-assert standalone scripts** (no pytest) — each creates its own app with an isolated throwaway SQLite DB and guards that the engine points at the temp DB, so they can never touch the dev/prod database.

Run any suite from the repo root with the backend venv:

```bash
backend/.venv/bin/python backend/tests/test_stock_guard.py
```

| Suite | Tests | Coverage |
|---|---|---|
| `test_stock_guard.py` | 11 | Oversell guard per-line, sibling-line sync, counted path, money invariants (incl. `test_odd_sized_button_sales_keep_exact_money`), multi-batch voids |
| `test_counted_tracking.py` | 10 | Counted buttons with amounts consume real stock via FIFO; legacy NULL-amount buttons keep estimate behavior |
| `test_pos_count.py` | 10 | Till count control (e.g. "3 × 1 tomato") round-trips through sync and snapshots |
| `test_sales_page.py` | 6 | Paginated sales listing, filters, role scoping |
| `test_timezone.py` | 5 | Kenya business-day boundaries, daily summary, series aggregation (voided excluded), production secret fail-fast |
| `test_wastage_identity.py` | 1 | Wastage `recorded_by` is JWT-derived, never client-supplied |

All 43 pass (verified). The `test_timezone.py` series test was made date-relative so it never goes stale.

---

## Deployment

### Backend (Render / any gunicorn host)
1. Set env vars: `FLASK_ENV=production`, `DATABASE_URL` (PostgreSQL), `SECRET_KEY`, `JWT_SECRET_KEY`, `CORS_ORIGINS` (the frontend origin). Production **refuses to start** if the secrets are missing.
2. Run: `gunicorn "app:create_app('production')"` from `backend/`.
3. Apply migrations: `flask db upgrade`.

### Frontend (Vercel)
- Build command `npm run build` (runs `tsc -b && vite build`); output `dist/`.
- `vercel.json` rewrites `/api/:path*` to `https://sokomtaani-mr2h.onrender.com/api/:path*` and falls back all non-asset routes to `/index.html` (SPA + reload support).

---

## Related documents

- **`PRODUCT.md`** — the product brief: users, positioning, confirmed capabilities/decisions, brand commitments.
- **`POS_V1_AUDIT.md`** — a read-only technical audit of the system plus the POS V1 blueprint (pricing unification, reliability fixes, sales page, timezone, migration strategy). Much of the blueprint has since been implemented — the tests above pin it.
