import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// GET /health: is the API up, and can it reach its database?
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check() {
    const [row] = await this.prisma.$queryRaw<{ version: string }[]>`select current_setting('server_version') as version`;
    return { status: 'ok', database: 'ok', postgres: row.version };
  }
}
