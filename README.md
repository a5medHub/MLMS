# Mini Library Management System (MLMS)

Full-stack implementation of **Version 1: Mini Library Management System Challenge**.

## Features

- Google SSO authentication (backend ID token verification)
- Role-based access (`ADMIN`, `MEMBER`)
- Public catalog browsing, auth-required borrowing
- Book CRUD + import + metadata enrichment
- Loan lifecycle: checkout, checkin, due-date override
- Due-soon and overdue visibility (admin sees member due alerts)
- Member contact profile (contact email + phone required, personal ID optional)
- Unique `personalId` enforcement at DB level
- AI recommendations + due-date estimate endpoint
- Fallback book data + caching + race-safe checkout
- PWA-ready client with mobile/tablet install prompt
- Mobile-first, accessible UI
- Lazy-loaded recommendations + code-split frontend bundles

## Tech Stack

- Frontend: React + Vite + TypeScript
- Backend: Express + TypeScript + Zod
- Database: PostgreSQL (Neon recommended)
- ORM: Prisma
- Auth: Google OAuth (SSO)
- Hosting: Render (single web service) + Neon

## Repository Structure

```text
apps/
  server/  Express API + Prisma schema
  client/  React app
.github/workflows/ci.yml
render.yaml
```

## Local Setup

### 1) Install dependencies

```bash
npm install
```

### 2) Configure env files

```bash
cp apps/server/.env.example apps/server/.env
cp apps/client/.env.example apps/client/.env
```

Required minimum:

- `apps/server/.env`
  - `DATABASE_URL`
  - `GOOGLE_CLIENT_ID`
  - `JWT_ACCESS_SECRET`
  - `JWT_REFRESH_SECRET`
  - `CORS_ORIGIN=http://localhost:5173`
  - `APP_URL=http://localhost:5173`
- `apps/client/.env`
  - `VITE_API_BASE_URL=http://localhost:4000/api/v1`
  - `VITE_GOOGLE_CLIENT_ID=<same Google client id>`

### 3) Push schema

```bash
npm run db:push -w apps/server
```

### 4) Start dev

```bash
npm run dev
```

- API: `http://localhost:4000`
- Client: `http://localhost:5173`

## PWA Install (Mobile/Tablet)

The client is configured as a Progressive Web App:

- `apps/client/public/manifest.webmanifest`
- `apps/client/public/sw.js`
- app icons in `apps/client/public/icons/`

Behavior:

- On mobile/tablet, users see an install popup (`Install app`).
- Android/Chromium: uses native install prompt when available.
- iOS Safari: shows manual hint (`Share` -> `Add to Home Screen`).
- Prompt is dismissed per device using local storage.

## API Quick Map

- `GET /health` - health check
- `GET /api` - redirects to `/api/v1`
- `GET /api/v1` - friendly API root summary

Base API path: `/api/v1`

### Auth

- `POST /auth/google`
- `POST /auth/refresh`
- `POST /auth/logout`
- `GET /auth/me`

### Books

- `GET /books`
- `GET /books/stats`
- `GET /books/:bookId`
- `POST /books` (`ADMIN`)
- `PATCH /books/:bookId` (`ADMIN`)
- `DELETE /books/:bookId` (`ADMIN`)
- `POST /books/import/external` (`ADMIN`)
- `POST /books/enrich-metadata` (`ADMIN`)

### Loans

- `GET /loans`
- `GET /loans/due-soon`
- `GET /loans/admin/overview` (`ADMIN`)
- `POST /loans/checkout`
- `POST /loans/checkin`
- `PATCH /loans/:loanId/due-date` (`ADMIN`)

### Users

- `GET /users` (`ADMIN`)
- `PATCH /users/:userId/role` (`ADMIN`)
- `PATCH /users/me/contact` (self-service profile update)

### Search + AI

- `GET /search/books`
- `POST /ai/due-date-estimate`
- `POST /ai/recommendations`

## Behavior Notes

- Unknown API routes return `404` JSON:
  - `{"error":{"message":"Route not found"}}`
- Non-API routes are served by the built React app (`client/dist`) in production.
- Recommendation data is lazy-fetched when the recommendations section is reached or clicked.

## AI Workload Profile

AI is used in multiple paths, so it can create meaningful backend load depending on usage:

- `POST /api/v1/ai/recommendations`
  - Personalized recommendations from user history, ratings, and favorites.
  - Triggered when recommendations are requested/visible (lazy-loaded on client).
- `POST /api/v1/ai/due-date-estimate`
  - Estimates due dates from reading-time signals and metadata.
- Metadata enrichment flows
  - Admin import/enrichment can call external book sources and AI-based fill logic for missing fields (genre, rating, cover, author fallback flags).

Operational impact:

- Low load in normal member browsing.
- Medium/high load during admin bulk import + metadata enrichment.
- Recommendation calls are bounded by client lazy loading and API limits.
- Caching/fallback behavior reduces repeated misses and external round trips.

## Security Baseline

- Google SSO verification on backend
- Access + refresh JWT split with rotation
- HttpOnly refresh cookie
- RBAC middleware (`ADMIN`/`MEMBER`)
- Zod validation for request payloads
- Helmet, CORS, JSON payload limits
- Audit logs for privileged changes

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`) runs:

1. `npm ci`
2. `npm run typecheck`
3. `npm run lint`
4. `npm run test`
5. `npm run build`

Render blueprint (`render.yaml`) provisions one Node web service:

- build: `npm ci --include=dev && npm run build:render`
- start: `npm run start:render`
- health: `/health`

The server serves both API and built client assets.

## Common Windows Note

If Prisma fails with `EPERM ... query_engine-windows.dll.node`, stop running Node dev processes, then retry:

```bash
npm run prisma:generate -w apps/server
npm run db:push -w apps/server
```

