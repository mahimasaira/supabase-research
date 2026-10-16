import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { AvatarsModule } from './avatars/avatars';
import { BookingsModule } from './bookings/bookings';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { ProfilesModule } from './profiles/profiles';
import { RealtimeModule } from './realtime/slot-events';
import { SlotsModule } from './slots/slots';

@Module({
  // backend/.env, wherever the API is started from (dist/ or src/ → one level up).
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: join(__dirname, '..', '.env') }),
    PrismaModule,
    RealtimeModule,
    AuthModule,
    ProfilesModule,
    SlotsModule,
    BookingsModule,
    AvatarsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
