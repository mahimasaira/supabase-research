import { CanActivate, ExecutionContext, Injectable, SetMetadata, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

export type AuthUser = { id: string; email: string };

// Routes are protected unless marked: @Public() = anyone, @OptionalAuth() = anyone, but a token
// that IS sent must be valid (then the caller is known, e.g. a logged-in host booking a slot).
export const Public = () => SetMetadata('auth', 'public');
export const OptionalAuth = () => SetMetadata('auth', 'optional');

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser | undefined => ctx.switchToHttp().getRequest().user);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const mode = this.reflector.getAllAndOverride<string>('auth', [ctx.getHandler(), ctx.getClass()]) ?? 'required';
    if (mode === 'public') return true;
    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    if (!header) {
      if (mode === 'optional') return true;
      throw new UnauthorizedException('Log in first');
    }
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) throw new UnauthorizedException('Expected "Authorization: Bearer <token>"');
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; email: string; typ: string }>(token);
      if (payload.typ !== 'access') throw new Error('not an access token');
      req.user = { id: payload.sub, email: payload.email } satisfies AuthUser;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
