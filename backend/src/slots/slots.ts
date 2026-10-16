import {
  BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, Injectable, Module, NotFoundException, Param,
  ParseUUIDPipe, Patch, Post,
} from '@nestjs/common';
import { IsISO8601, IsOptional, IsUUID } from 'class-validator';
import { AuthUser, CurrentUser, OptionalAuth } from '../auth/auth.guard';
import { rethrowDbError } from '../common/db-errors';
import { Slot } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SlotEvents } from '../realtime/slot-events';

// Allowed fields only: isBooked is set by the booking code, never by clients (Supabase: column grants).
class CreateSlotDto {
  @IsOptional()
  @IsUUID()
  hostId?: string;

  @IsISO8601()
  startsAt!: string;

  @IsISO8601()
  endsAt!: string;
}

class UpdateSlotDto {
  @IsOptional()
  @IsISO8601()
  startsAt?: string;

  @IsOptional()
  @IsISO8601()
  endsAt?: string;
}

const view = (s: Slot) => ({ id: s.id, hostId: s.hostId, startsAt: s.startsAt, endsAt: s.endsAt, isBooked: s.isBooked });

// Who may see a slot (Supabase: the two SELECT policies): everyone sees free future slots,
// a host also sees all of their own.
const visible = (s: Slot, user?: AuthUser) => s.hostId === user?.id || (!s.isBooked && s.startsAt > new Date());

@Injectable()
export class SlotsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: SlotEvents,
  ) {}

  async listForHost(hostId: string, user?: AuthUser) {
    const slots = await this.prisma.slot.findMany({
      where: user?.id === hostId ? { hostId } : { hostId, isBooked: false, startsAt: { gt: new Date() } },
      orderBy: { startsAt: 'asc' },
    });
    return slots.map(view);
  }

  async get(id: string, user?: AuthUser) {
    const s = await this.prisma.slot.findUnique({ where: { id } });
    if (!s || !visible(s, user)) throw new NotFoundException('No such slot');
    return view(s);
  }

  async create(user: AuthUser, dto: CreateSlotDto) {
    if (dto.hostId && dto.hostId !== user.id) throw new ForbiddenException('You can only create your own slots');
    const startsAt = new Date(dto.startsAt);
    if (startsAt <= new Date()) throw new BadRequestException('Slots must start in the future');
    try {
      const slot = await this.prisma.slot.create({ data: { hostId: user.id, startsAt, endsAt: new Date(dto.endsAt) } });
      this.events.slotChanged(slot);
      return view(slot);
    } catch (e) {
      rethrowDbError(e, { conflict: 'Overlaps another of your slots', invalid: 'A slot must end after it starts' });
    }
  }

  async update(user: AuthUser, id: string, dto: UpdateSlotDto) {
    if (dto.startsAt && new Date(dto.startsAt) <= new Date()) throw new BadRequestException('Slots must start in the future');
    try {
      const slot: Slot = await this.prisma.$transaction(async (tx) => {
        const s = await this.lockOwn(tx, user, id);
        if (s.isBooked) throw new ConflictException('A booked slot cannot be moved');
        const data = { ...(dto.startsAt && { startsAt: new Date(dto.startsAt) }), ...(dto.endsAt && { endsAt: new Date(dto.endsAt) }) };
        return tx.slot.update({ where: { id }, data });
      });
      this.events.slotChanged(slot); // after commit
      return view(slot);
    } catch (e) {
      rethrowDbError(e, { conflict: 'Overlaps another of your slots', invalid: 'A slot must end after it starts' });
    }
  }

  async remove(user: AuthUser, id: string) {
    const slot: Slot = await this.prisma.$transaction(async (tx) => {
      const s = await this.lockOwn(tx, user, id);
      if (s.isBooked) throw new ConflictException('A booked slot cannot be deleted');
      await tx.slot.delete({ where: { id } });
      return s;
    });
    this.events.slotChanged(slot, { deleted: true });
    return { id };
  }

  // Locks the slot row until the transaction ends, so a booking can't slip in between the
  // "is it free?" check and the change. Someone else's slot looks the same as a missing one.
  private async lockOwn(tx: any, user: AuthUser, id: string): Promise<Slot> {
    await tx.$queryRaw`select 1 from slots where id = ${id}::uuid for update`;
    const s = await tx.slot.findUnique({ where: { id } });
    if (!s || s.hostId !== user.id) throw new NotFoundException('No such slot');
    return s;
  }
}

@Controller()
export class SlotsController {
  constructor(private readonly slots: SlotsService) {}

  @OptionalAuth()
  @Get('hosts/:hostId/slots')
  list(@Param('hostId', ParseUUIDPipe) hostId: string, @CurrentUser() user?: AuthUser) {
    return this.slots.listForHost(hostId, user);
  }

  @OptionalAuth()
  @Get('slots/:id')
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user?: AuthUser) {
    return this.slots.get(id, user);
  }

  @Post('slots')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateSlotDto) {
    return this.slots.create(user, dto);
  }

  @Patch('slots/:id')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSlotDto) {
    return this.slots.update(user, id, dto);
  }

  @Delete('slots/:id')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.slots.remove(user, id);
  }
}

@Module({ controllers: [SlotsController], providers: [SlotsService] })
export class SlotsModule {}
