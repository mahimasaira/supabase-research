// Avatar rules shown to the user. The backend enforces them (Supabase: the bucket settings in
// the migration); checking here too just gives a faster, clearer message.
// The URL of a stored picture comes from the services layer (avatarUrl in '@/services').
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024
export const AVATAR_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }
