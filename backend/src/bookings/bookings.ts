import {
  Body, ConflictException, Controller, Get, HttpCode, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post,
} from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsEmail, IsIn, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { AuthUser, CurrentUser, OptionalAuth, Public } from '../auth/auth.guard';
import { rethrowDbError } from '../common/db-errors';
import { Booking, Slot } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SlotEvents } from '../realtime/slot-events';

// What a guest may send. status, cancelledAt, … are refused (Supabase: column grants).
class CreateBookingDto {
  @IsUUID()
  slotId!: string;

  @IsString()
  @Length(1, 100)
  guestName!: string;

  @IsEmail()
  guestEmail!: string;

  // The browser generates the cancel token (same as the Supabase version); optional here.
  @IsOptional()
  @IsUUID()
  cancelToken?: string;
}

// A host may only cancel. Any other field (guestEmail, …) or status is refused.
class UpdateBookingDto {
  @IsIn(['cancelled'])
  status!: 'cancelled';
}

class CancelDto {
  @IsUUID()
  cancelToken!: string;
}

class StatusesDto {
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  cancelTokens!: string[];
}

const view = (b: Booking) => ({ id: b.id, slotId: b.slotId, guestName: b.guestName, guestEmail: b.guestEmail, status: b.status, createdAt: b.createdAt, cancelledAt: b.cancelledAt });

@Injectable()
export class BookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: SlotEvents,
  ) {}

  // One transaction: lock the slot, check it's free and in the future, insert the booking,
  // mark the slot booked. (Supabase: RLS insert policy + a trigger that sets is_booked.)
  // The partial unique index is the last line of defence if two requests still collide.
  async book(dto: CreateBookingDto) {
    try {
      const { cancelToken, slot } = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`select 1 from slots where id = ${dto.slotId}::uuid for update`;
        const slot = await tx.slot.findUnique({ where: { id: dto.slotId } });
        if (!slot || slot.isBooked || slot.startsAt <= new Date()) throw new ConflictException('This slot is not available');
        const b = await tx.booking.create({
          data: { slotId: slot.id, guestName: dto.guestName, guestEmail: dto.guestEmail, ...(dto.cancelToken && { cancelToken: dto.cancelToken }) },
        });
        const updated = await tx.slot.update({ where: { id: slot.id }, data: { isBooked: true } });
        return { cancelToken: b.cancelToken, slot: updated };
      });
      this.events.slotChanged(slot); // after commit
      return { cancelToken }; // nothing else goes back to the guest
    } catch (e) {
      rethrowDbError(e, { conflict: 'This slot is not available', invalid: 'Invalid guest name or email' });
    }
  }

  // Bookings on the caller's own slots (Supabase: "Hosts read bookings on their slots").
  async listForHost(user: AuthUser) {
    const rows = await this.prisma.booking.findMany({ where: { slot: { hostId: user.id } }, orderBy: { createdAt: 'asc' } });
    return rows.map(view);
  }

  // A host cancels the confirmed booking on one of their slots.
  async cancelAsHost(user: AuthUser, slotId: string) {
    const { booking, slot } = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`select 1 from slots where id = ${slotId}::uuid for update`;
      const b = await tx.booking.findFirst({ where: { slotId, status: 'confirmed', slot: { hostId: user.id } } });
      if (!b) throw new NotFoundException('No confirmed booking on a slot of yours');
      return this.cancel(tx, b);
    });
    this.events.slotChanged(slot);
    return view(booking);
  }

  // A guest cancels with their secret token. true = cancelled now, false = unknown or already cancelled.
  async cancelByToken(token: string) {
    const slot = await this.prisma.$transaction(async (tx) => {
      const found = await tx.booking.findUnique({ where: { cancelToken: token } });
      if (!found) return null;
      await tx.$queryRaw`select 1 from slots where id = ${found.slotId}::uuid for update`;
      const b = await tx.booking.findUnique({ where: { cancelToken: token } });
      if (!b || b.status !== 'confirmed') return null;
      return (await this.cancel(tx, b)).slot;
    });
    if (slot) this.events.slotChanged(slot);
    return { cancelled: !!slot };
  }

  // Status by token, for the guest's "your bookings" list: no guest data in the answer.
  async statuses(tokens: string[]) {
    const rows = await this.prisma.booking.findMany({ where: { cancelToken: { in: tokens } }, select: { cancelToken: true, status: true } });
    return rows;
  }

  private async cancel(tx: any, b: Booking): Promise<{ booking: Booking; slot: Slot }> {
    const booking = await tx.booking.update({ where: { id: b.id }, data: { status: 'cancelled', cancelledAt: new Date() } });
    const slot = await tx.slot.update({ where: { id: b.slotId }, data: { isBooked: false } });
    return { booking, slot };
  }
}

@Controller()
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  // Guests (no login) and logged-in users may book.
  @OptionalAuth()
  @Post('bookings')
  book(@Body() dto: CreateBookingDto) {
    return this.bookings.book(dto);
  }

  @Get('bookings')
  list(@CurrentUser() user: AuthUser) {
    return this.bookings.listForHost(user);
  }

  @Patch('slots/:slotId/booking')
  update(@CurrentUser() user: AuthUser, @Param('slotId', ParseUUIDPipe) slotId: string, @Body() _dto: UpdateBookingDto) {
    return this.bookings.cancelAsHost(user, slotId);
  }

  @Public()
  @HttpCode(200)
  @Post('bookings/cancel')
  cancel(@Body() dto: CancelDto) {
    return this.bookings.cancelByToken(dto.cancelToken);
  }

  @Public()
  @HttpCode(200)
  @Post('bookings/statuses')
  statuses(@Body() dto: StatusesDto) {
    return this.bookings.statuses(dto.cancelTokens);
  }
}

@Module({ controllers: [BookingsController], providers: [BookingsService] })
export class BookingsModule {}
