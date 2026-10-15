import { BadRequestException, ConflictException } from '@nestjs/common';

// Finds the Postgres error code (SQLSTATE, e.g. 23P01) inside a Prisma error. With Prisma 7's
// driver adapter it sits in meta.driverAdapterError.cause.originalCode. Prisma's own codes
// (P2002, P2039, …) are not SQLSTATEs, so they are not returned here.
export function pgCode(e: any): string | undefined {
  const cause = e?.meta?.driverAdapterError?.cause ?? e?.cause;
  const code = cause?.originalCode ?? cause?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) && !code.startsWith('P') ? code : undefined;
}

// Database rule violations → HTTP answers. Anything else is rethrown (500).
export function rethrowDbError(e: any, messages: { conflict?: string; invalid?: string } = {}): never {
  const code = pgCode(e);
  if (code === '23P01' || code === '23505' || e?.code === 'P2002') throw new ConflictException(messages.conflict ?? 'Conflicts with existing data');
  if (code === '23514') throw new BadRequestException(messages.invalid ?? 'Invalid data');
  throw e;
}
