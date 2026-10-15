import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { hashPassword, verifyPassword } from './password';

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_DAYS = 30;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// The NestJS version's own login: what Supabase Auth did for the Supabase version.
// Access token: a short-lived JWT. Refresh token: a random string, stored only as a hash,
// replaced on every use (a reused, already-replaced token logs the user out everywhere).
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async signup(email: string, password: string, displayName = '') {
    const passwordHash = await hashPassword(password);
    try {
      // User and profile in one transaction (Supabase: a trigger on auth.users creates the profile).
      const user = await this.prisma.user.create({
        data: { email: email.toLowerCase(), passwordHash, profile: { create: { displayName } } },
      });
      return this.issueTokens(user.id, user.email);
    } catch (e: any) {
      if (e?.code === 'P2002') throw new ConflictException('This email is already registered');
      throw e;
    }
  }

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    // Same answer for "no such user" and "wrong password", so emails can't be probed.
    if (!user || !(await verifyPassword(password, user.passwordHash))) throw new UnauthorizedException('Invalid email or password');
    return this.issueTokens(user.id, user.email);
  }

  async refresh(refreshToken: string) {
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(refreshToken) }, include: { user: true } });
    if (!row || row.expiresAt < new Date()) throw new UnauthorizedException('Invalid refresh token');
    if (row.revokedAt) {
      // Someone used a token that was already replaced: possibly stolen. End every session.
      await this.prisma.refreshToken.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      throw new UnauthorizedException('Invalid refresh token');
    }
    await this.prisma.refreshToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
    return this.issueTokens(row.user.id, row.user.email);
  }

  async logout(refreshToken: string) {
    await this.prisma.refreshToken.updateMany({ where: { tokenHash: sha256(refreshToken), revokedAt: null }, data: { revokedAt: new Date() } });
  }

  private async issueTokens(userId: string, email: string) {
    const accessToken = await this.jwt.signAsync({ sub: userId, email, typ: 'access' }, { expiresIn: ACCESS_TTL_SECONDS });
    const refreshToken = randomBytes(32).toString('base64url');
    await this.prisma.refreshToken.create({
      data: { userId, tokenHash: sha256(refreshToken), expiresAt: new Date(Date.now() + REFRESH_TTL_DAYS * 86_400_000) },
    });
    return { user: { id: userId, email }, accessToken, refreshToken, expiresIn: ACCESS_TTL_SECONDS };
  }
}
