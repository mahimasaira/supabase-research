-- Step 7: host profile pictures in Supabase Storage.
--
-- Storage keeps file metadata in the table storage.objects (one row per file),
-- and access is controlled with ordinary RLS policies on that table.
-- Buckets are rows in storage.buckets, so we can create one in a migration.

-- Public bucket = files can be downloaded by URL without any auth (the booking page
-- shows the host's picture to guests). "Public" only affects *reading*; uploads,
-- overwrites and deletes still go through the policies below.
-- The size and MIME limits are enforced by the Storage server on upload.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2 * 1024 * 1024, array['image/png', 'image/jpeg', 'image/webp']);

-- Path convention: avatars/<host_id>/<random>.<ext>
-- storage.foldername(name) splits the path into folders; [1] is the first one.
-- Every policy pins that first folder to the logged-in user's id, so a host can
-- only ever write inside their own folder.

-- Upload into own folder.
create policy "Hosts upload their own avatar"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- List/read own files through the API (needed for upsert and for removing the old
-- picture). Guests don't need this: public-bucket URLs skip RLS for downloads.
create policy "Hosts read their own avatar files"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- Overwrite own files (upsert), and can't move them into someone else's folder.
create policy "Hosts update their own avatar"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- Delete own files (removing the previous picture after uploading a new one).
create policy "Hosts delete their own avatar"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- profiles.avatar_path is writable by the host (step 4 grant). Without this, a host
-- could point their avatar_path at another host's file. Tighten the profile update
-- policy so the path must be inside the host's own folder (or empty).
drop policy "Hosts update their own profile" on public.profiles;

create policy "Hosts update their own profile"
  on public.profiles for update
  to authenticated
  using (id = (select auth.uid()))
  with check (
    id = (select auth.uid())
    and (avatar_path is null or avatar_path like (select auth.uid())::text || '/%')
  );
