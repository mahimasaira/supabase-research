<script setup>
import { onMounted, ref } from 'vue'
import { avatarUrl, capabilities, getMyProfile, removeAvatar, updateMyProfile, uploadAvatar } from '@/services'
import { friendlyError } from '@/lib/errors'
import { AVATAR_MAX_BYTES, AVATAR_TYPES } from '@/lib/avatars'

const props = defineProps({ userId: { type: String, required: true } })

const profile = ref(null)
const displayName = ref('')
const busy = ref(false)
const error = ref('')
const info = ref('')

onMounted(async () => {
  try {
    profile.value = await getMyProfile(props.userId)
    displayName.value = profile.value.display_name
  } catch (err) {
    error.value = friendlyError(err)
  }
})

// Throws if the profile wasn't changed (the services layer checks that).
async function updateProfile(fields) {
  profile.value = await updateMyProfile(props.userId, fields)
}

async function saveName() {
  error.value = ''
  info.value = ''
  try {
    await updateProfile({ display_name: displayName.value.trim() })
    info.value = 'Saved.'
  } catch (e) {
    error.value = friendlyError(e)
  }
}

// Each upload gets a new random file name instead of overwriting one fixed path.
// A fixed path would keep the same public URL, and browsers/CDN would keep showing
// the old cached picture. The previous file is deleted afterwards.
async function upload(event) {
  const file = event.target.files[0]
  event.target.value = ''
  if (!file) return
  error.value = ''
  info.value = ''
  const ext = AVATAR_TYPES[file.type]
  if (!ext) return (error.value = 'Please choose a PNG, JPEG or WebP image.')
  if (file.size > AVATAR_MAX_BYTES) return (error.value = 'Image must be 2 MB or smaller.')

  busy.value = true
  const oldPath = profile.value.avatar_path
  const newPath = `${props.userId}/${crypto.randomUUID()}.${ext}`
  try {
    await uploadAvatar(newPath, file)
    try {
      await updateProfile({ avatar_path: newPath })
    } catch (e) {
      // Don't leave an orphaned file if the profile didn't accept the new path.
      await removeAvatar(newPath)
      throw e
    }
    // Best effort: if this fails, the old file is orphaned in storage but nothing breaks.
    if (oldPath) await removeAvatar(oldPath)
    info.value = 'Picture updated.'
  } catch (e) {
    error.value = friendlyError(e)
  } finally {
    busy.value = false
  }
}

async function removePicture() {
  const oldPath = profile.value.avatar_path
  busy.value = true
  error.value = ''
  info.value = ''
  try {
    await updateProfile({ avatar_path: null })
    await removeAvatar(oldPath)
  } catch (e) {
    error.value = friendlyError(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section v-if="profile" class="space-y-3">
    <h2 class="text-lg font-semibold">Profile</h2>
    <div class="flex items-center gap-4">
      <img v-if="profile.avatar_path" :src="avatarUrl(profile.avatar_path)" alt="Profile picture" class="h-20 w-20 rounded-full object-cover" />
      <div v-else class="flex h-20 w-20 items-center justify-center rounded-full bg-gray-200 text-2xl text-gray-500">
        {{ (profile.display_name || '?')[0].toUpperCase() }}
      </div>
      <p v-if="!capabilities.avatars" class="text-sm text-gray-500">Profile pictures aren't available on this backend yet.</p>
      <div v-else class="space-y-1 text-sm">
        <label class="btn inline-block cursor-pointer" :class="{ 'opacity-50': busy }">
          {{ busy ? 'Uploading…' : 'Upload picture' }}
          <input type="file" accept="image/png,image/jpeg,image/webp" class="hidden" :disabled="busy" @change="upload" />
        </label>
        <button v-if="profile.avatar_path" class="ml-3 underline" :disabled="busy" @click="removePicture">Remove</button>
        <p class="text-gray-500">PNG, JPEG or WebP, max 2 MB.</p>
      </div>
    </div>
    <form class="flex items-end gap-3" @submit.prevent="saveName">
      <label class="flex-1 text-sm">
        Display name
        <input v-model="displayName" class="input" maxlength="80" />
      </label>
      <button class="btn">Save</button>
    </form>
    <p v-if="error" class="text-red-700">{{ error }}</p>
    <p v-if="info" class="text-green-700">{{ info }}</p>
  </section>
</template>
