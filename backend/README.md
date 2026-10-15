# backend: the NestJS version

The same booking app as the Supabase version, with its own API, its own Postgres database and its own login. Built stage by stage on the `feature/msa-nestjs` branch; the plan is in [../NESTJS_COMPARISON_PLAN.md](../NESTJS_COMPARISON_PLAN.md).

Run from the repo root:

```bash
npm run backend:install     # once (also generates the Prisma client)
npm run backend:db:start    # Postgres 17 in Docker on 127.0.0.1:5433 (backend/docker-compose.yml)
npm run backend:migrate     # apply Prisma migrations (prisma/migrations)
npm run backend:dev         # API on http://127.0.0.1:3000, restarts on file changes
curl http://127.0.0.1:3000/health
```

## API (N2: the core)

| Route | Who | What |
|---|---|---|
| `POST /auth/signup`, `/auth/login`, `/auth/refresh`, `/auth/logout`, `GET /auth/me` | public / logged in | own login: access token (15 min) + rotating refresh token |
| `GET /profiles/:id` · `PATCH /profiles/:id` | public · owner | host name |
| `GET /hosts/:hostId/slots`, `GET /slots/:id` | public (owner sees more) | free future slots; a host also sees all own |
| `POST /slots`, `PATCH /slots/:id`, `DELETE /slots/:id` | host | own, future, not booked |
| `POST /bookings` | anyone | book a free future slot; returns only the cancel token |
| `GET /bookings` · `PATCH /slots/:slotId/booking` | host | bookings on own slots · cancel one (`{ "status": "cancelled" }`) |
| `POST /bookings/cancel`, `POST /bookings/statuses` | anyone with the token | guest cancels · status by token |

Every route needs a login unless marked `@Public()` / `@OptionalAuth()` (global `AuthGuard`); request bodies with unknown fields are refused (400).

- `prisma/schema.prisma`: the database schema; `prisma.config.ts`: where Prisma finds it and the database URL.
- `.env` (git-ignored, copy from `.env.example`): `DATABASE_URL`.
- `src/generated/prisma` is generated (git-ignored): `npx prisma generate` after schema changes.
