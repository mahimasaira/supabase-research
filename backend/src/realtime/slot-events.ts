import { Global, Module } from '@nestjs/common';
import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { Slot } from '../generated/prisma/client';

const origins = () => (process.env.CORS_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173').split(',').map((o) => o.trim());
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Live slot updates over Socket.IO (Supabase: Realtime broadcast on "slots:<hostId>").
// A client may only SUBSCRIBE to a host's room. There is no handler that relays client
// messages, so nobody can send fake "slot taken" events to other viewers (Supabase: no INSERT
// policy on realtime.messages). Events carry no guest data, only what the booking page shows.
@WebSocketGateway({ namespace: '/slots', cors: { origin: origins() } })
export class SlotEvents {
  @WebSocketServer() private server!: Server;

  @SubscribeMessage('subscribe')
  subscribe(@ConnectedSocket() socket: Socket, @MessageBody() body: { hostId?: string }) {
    if (!body?.hostId || !UUID.test(body.hostId)) return { ok: false };
    void socket.join(`slots:${body.hostId}`);
    return { ok: true };
  }

  // Called by the services AFTER their transaction committed.
  slotChanged(slot: Slot, { deleted = false } = {}) {
    this.server.to(`slots:${slot.hostId}`).emit('slot_changed', {
      id: slot.id,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      available: !deleted && !slot.isBooked && slot.startsAt > new Date(),
    });
  }
}

@Global()
@Module({ providers: [SlotEvents], exports: [SlotEvents] })
export class RealtimeModule {}
