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

- `prisma/schema.prisma`: the database schema; `prisma.config.ts`: where Prisma finds it and the database URL.
- `.env` (git-ignored, copy from `.env.example`): `DATABASE_URL`.
- `src/generated/prisma` is generated (git-ignored): `npx prisma generate` after schema changes.
