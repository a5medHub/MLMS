# Mini Library Management System (MLMS)

Full-stack implementation of **Version 1: Mini Library Management System Challenge** with:

- Book CRUD (title, author, metadata)
- Check-out / check-in workflows
- Search and filtering
- Google SSO authentication
- Role-based access control (`ADMIN`, `MEMBER`)
- AI-powered recommendations (history-weighted affinity model)
- Mobile-first, accessible React UI

## Tech Stack

- Frontend: React + Vite + TypeScript
- Backend: Express + TypeScript + Zod
- Database: PostgreSQL (Neon recommended)
- ORM: Prisma
- Auth: Google SSO (ID token verification on backend)
- Deployment target: Render (static frontend + web service API) + Neon

## Monorepo Structure

```text
apps/
  api/    Express API + Prisma schema
  web/    React application
.github/
  workflows/ci.yml
render.yaml
```

## Local Setup

### 1) Install dependencies

```bash
npm install
```

### 2) Configure environment files

```bash
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
```

Fill at minimum:

- `apps/api/.env`
  - `DATABASE_URL` (Neon connection string with `sslmode=require`)
  - `GOOGLE_CLIENT_ID`
  - `JWT_ACCESS_SECRET`
  - `JWT_REFRESH_SECRET`
  - `CORS_ORIGIN=http://localhost:5173`
- `apps/web/.env`
  - `VITE_API_BASE_URL=http://localhost:4000/api/v1`
  - `VITE_GOOGLE_CLIENT_ID` (same Google client id)

### 3) Create database schema

```bash
npm run db:push -w apps/api
```

### 4) Start development servers

```bash
npm run dev
```

- API: `http://localhost:4000`
- Web: `http://localhost:5173`

## API Overview

Base path: `/api/v1`

- `POST /auth/google` - sign in with Google credential token
- `POST /auth/refresh` - rotate refresh token and get new access token
- `POST /auth/logout` - revoke refresh token
- `GET /auth/me` - current authenticated user
- `GET /books` - search/list books (cursor pagination)
- `POST /books` - create book (`ADMIN`)
- `POST /books/import/external` - import books from Open Library with Google fallback (`ADMIN`)
- `PATCH /books/:bookId` - update book (`ADMIN`)
- `DELETE /books/:bookId` - delete book (`ADMIN`)
- `POST /loans/checkout` - borrow a book
- `POST /loans/checkin` - return a book
- `GET /loans` - list loans (members see own loans; admins can view all)
- `GET /users` - list users (`ADMIN`)
- `PATCH /users/:userId/role` - update role (`ADMIN`)
- `GET /search/books` - search with optional fallback import (`withFallback=true`)
- `POST /ai/recommendations` - personalized recommendations

## Accessibility and UX Notes

- Mobile-first layout and responsive grid behavior
- Semantic regions (`header`, `main`, `section`, table captions)
- Skip link for keyboard users
- Focus-visible styles with high contrast
- Form labels for all fields
- Status updates announced via `aria-live`

## Security Baseline

- Google SSO with server-side token verification
- Access/refresh JWT split with refresh rotation
- HttpOnly refresh cookie
- RBAC middleware on protected endpoints
- Zod request validation
- Helmet + CORS + JSON payload limits
- Audit logs for privileged state changes

## CI/CD

GitHub Actions pipeline (`.github/workflows/ci.yml`) runs:

1. `npm ci`
2. typecheck
3. lint
4. test
5. build

Render deploy blueprint (`render.yaml`) provisions:

1. `mlms-api` (Node web service)
2. `mlms-web` (static site)

Set production env vars in Render dashboard and point `DATABASE_URL` to Neon.
