import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

// One Prisma client for the whole app. Prisma 7 talks to Postgres through a driver adapter
// (node-postgres here); DATABASE_URL comes from backend/.env.
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const url = process.env.DATABASE_URL;
    // Without this check a missing URL silently falls back to a database named after the OS user.
    if (!url) throw new Error('DATABASE_URL is not set (backend/.env, see backend/.env.example)');
    super({ adapter: new PrismaPg({ connectionString: url }) });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
