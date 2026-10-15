import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';

function jwtSecret(): string {
  const secret = process.env.JWT_SECRET ?? '';
  if (secret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters (backend/.env, see backend/.env.example)');
  return secret;
}

@Module({
  // The guard runs for EVERY route (APP_GUARD): routes are closed unless marked @Public()/@OptionalAuth().
  imports: [JwtModule.registerAsync({ useFactory: () => ({ secret: jwtSecret() }) })],
  controllers: [AuthController],
  providers: [AuthService, { provide: APP_GUARD, useClass: AuthGuard }],
})
export class AuthModule {}
