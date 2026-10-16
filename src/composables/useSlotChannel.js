import { onMounted, onUnmounted } from 'vue'
import { subscribeSlots } from '@/services'

// Live updates for one host's slots, while the component is on screen.
// onChange(payload) gets { id, starts_at, ends_at, available } for every slot change.
// onSync() runs every time the subscription (re)connects: events sent while we were
// disconnected are NOT replayed, so the caller should refetch then.
export function useSlotChannel(hostId, { onChange, onSync }) {
  let stop

  onMounted(() => {
    stop = subscribeSlots(hostId, { onChange, onSync })
  })

  onUnmounted(() => {
    stop?.()
  })
}
