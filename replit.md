# ATM Command — Back Office

## Overview

Enterprise ATM back-office management application for ATM operators managing 80-100+ machines across multiple states.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **Frontend**: React + Vite + TanStack Query + wouter + Recharts + Framer Motion

## Artifacts

- `artifacts/atm-dashboard` — React frontend, served at `/`
- `artifacts/api-server` — Express API server, served at `/api`

## Key Features

1. **Dashboard** — Real-time fleet overview, cash flow charts, top ATMs, alert summary
2. **ATM Fleet** — Manage all 80-100 ATMs with status, balance, and sync data
3. **Portal Sync** — Login and pull data from Columbus Data, Switch Commerce, ATM Transact
4. **Cash Planning** — Calculate fill amounts based on avg daily dispensed × days
5. **Route Planning** — Optimized multi-stop routes using nearest-neighbor algorithm
6. **Alerts** — Configurable alert rules, severity levels, resolution tracking
7. **Bookkeeping** — Financial accounts, income/expense transactions, P&L summary
8. **Mileage Log** — Fill trip tracking with IRS deduction estimate
9. **Payroll** — Employee management and payroll records

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)

## Database Schema

Tables: `atms`, `portals`, `portal_sync_history`, `fill_orders`, `routes`, `route_stops`, `alerts`, `alert_rules`, `accounts`, `book_transactions`, `mileage_logs`, `employees`, `payroll_records`, `atm_transactions`

## Portal Integration

The three portals (Columbus Data, Switch Commerce, ATM Transact) use a simulated sync that updates ATM balances and creates alerts. Real scraping with Puppeteer can be added by replacing `performPortalSync()` in `artifacts/api-server/src/routes/portals.ts`.

## Route Planning

Uses a nearest-neighbor TSP heuristic with haversine distance for multi-stop route optimization. ATMs without coordinates are appended at the end.

## Seeded Data

- 20 ATMs across Ohio and Indiana
- 30 days of transaction history
- Portal credentials (Columbus Data, Switch Commerce, ATM Transact)
- Sample alerts, fill orders, accounts, employees, payroll, mileage logs

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
