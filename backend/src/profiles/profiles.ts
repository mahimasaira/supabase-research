import { Body, Controller, ForbiddenException, Get, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import { IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';
import { AuthUser, CurrentUser, Public } from '../auth/auth.guard';
import { PrismaService } from '../prisma/prisma.service';

// Only these fields can be changed; anything else in the body (id, …) is refused by the
// global ValidationPipe. Supabase: column grants.
class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  displayName?: string;

  // <ownId>/<file>, or null to remove the picture.
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(200)
  avatarPath?: string | null;
}

const view = (p: { id: string; displayName: string; avatarPath: string | null }) => ({ id: p.id, displayName: p.displayName, avatarPath: p.avatarPath });

@Injectable()
export class ProfilesService {
  constructor(private readonly prisma: PrismaService) {}

  async get(id: string) {
    const p = await this.prisma.profile.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('No such host');
    return view(p);
  }

  async update(user: AuthUser, id: string, dto: UpdateProfileDto) {
    if (id !== user.id) throw new ForbiddenException('You can only edit your own profile');
    // Supabase: the policy's "avatar_path like '<uid>/%'" check.
    if (dto.avatarPath && !dto.avatarPath.startsWith(`${user.id}/`)) throw new ForbiddenException('The picture must be in your own folder');
    return view(await this.prisma.profile.update({ where: { id }, data: dto }));
  }
}

@Controller('profiles')
export class ProfilesController {
  constructor(private readonly profiles: ProfilesService) {}

  // Host names are public (the booking page shows them).
  @Public()
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.profiles.get(id);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProfileDto) {
    return this.profiles.update(user, id, dto);
  }
}

@Module({ controllers: [ProfilesController], providers: [ProfilesService] })
export class ProfilesModule {}
