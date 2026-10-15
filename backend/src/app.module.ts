import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  // backend/.env, wherever the API is started from (dist/ or src/ → one level up).
  imports: [ConfigModule.forRoot({ isGlobal: true, envFilePath: join(__dirname, '..', '.env') }), PrismaModule],
  controllers: [HealthController],
})
export class AppModule {}
