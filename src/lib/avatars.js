import { supabase } from '@/lib/supabase'

export const AVATAR_BUCKET = 'avatars'
// Mirrors the bucket settings in the migration. The Storage server enforces these;
// checking here too just gives a faster, clearer message.
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024
export const AVATAR_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }

// Public bucket: a plain URL, no auth, no expiry. Built locally, no network request.
export function avatarUrl(path) {
  return path ? supabase.storage.from(AVATAR_BUCKET).getPublicUrl(path).data.publicUrl : null
}
