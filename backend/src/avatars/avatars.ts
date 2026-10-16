import {
  BadRequestException, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, Module, NotFoundException, Param,
  ParseUUIDPipe, Post, Query, Res, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { AuthUser, CurrentUser, Public } from '../auth/auth.guard';

// Profile pictures on the server's disk (Supabase: the public "avatars" Storage bucket).
// Path <hostId>/<file>: a host may only write and delete in their own folder; anyone may read.
const MAX_BYTES = 2 * 1024 * 1024;
const DIR = resolve(process.env.AVATAR_DIR ?? join(__dirname, '..', '..', 'uploads', 'avatars'));
const FILE_NAME = /^[A-Za-z0-9_-]{1,64}\.(png|jpg|jpeg|webp)$/;

// The declared type must be an allowed image AND the bytes must really be one (Supabase Storage
// only checks the declared Content-Type).
const TYPES: Record<string, (b: Buffer) => boolean> = {
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};

function fileOf(hostId: string, name: string) {
  if (!FILE_NAME.test(name)) throw new BadRequestException('File name must be <name>.png, .jpg or .webp');
  const path = resolve(DIR, hostId, name);
  if (!path.startsWith(DIR + sep)) throw new BadRequestException('Invalid path'); // belt and braces against ../
  return path;
}

@Controller('avatars')
export class AvatarsController {
  @Post(':hostId/:name')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BYTES } })) // larger → 413
  async upload(
    @CurrentUser() user: AuthUser,
    @Param('hostId', ParseUUIDPipe) hostId: string,
    @Param('name') name: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Query('upsert') upsert?: string,
  ) {
    if (hostId !== user.id) throw new ForbiddenException('You can only upload into your own folder');
    const path = fileOf(hostId, name);
    if (!file) throw new BadRequestException('Send the picture as multipart field "file"');
    const looksRight = TYPES[file.mimetype];
    if (!looksRight || !looksRight(file.buffer)) throw new BadRequestException('Only PNG, JPEG or WebP images');
    await mkdir(join(DIR, hostId), { recursive: true });
    try {
      // "wx" = fail if the file exists (no silent overwrite unless upsert=true).
      await writeFile(path, file.buffer, { flag: upsert === 'true' ? 'w' : 'wx' });
    } catch (e: any) {
      if (e.code === 'EEXIST') throw new ConflictException('A file with this name already exists');
      throw e;
    }
    return { path: `${hostId}/${name}` };
  }

  @Delete(':hostId/:name')
  async remove(@CurrentUser() user: AuthUser, @Param('hostId', ParseUUIDPipe) hostId: string, @Param('name') name: string) {
    if (hostId !== user.id) throw new ForbiddenException('You can only delete your own files');
    try {
      await unlink(fileOf(hostId, name));
    } catch (e: any) {
      if (e.code === 'ENOENT') throw new NotFoundException('No such file');
      throw e;
    }
    return { path: `${hostId}/${name}` };
  }

  // Public, like the Supabase bucket: a plain URL, no login.
  @Public()
  @Get(':hostId/:name')
  @HttpCode(200)
  download(@Param('hostId', ParseUUIDPipe) hostId: string, @Param('name') name: string, @Res() res: Response) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(fileOf(hostId, name), (err) => {
      if (err && !res.headersSent) res.status(404).json({ statusCode: 404, message: 'No such file' });
    });
  }
}

@Module({ controllers: [AvatarsController] })
export class AvatarsModule {}
