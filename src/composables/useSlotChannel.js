import { onMounted, onUnmounted } from 'vue'
import { supabase } from '@/lib/supabase'

// Listen to the "slots:<hostId>" broadcast topic (sent by the slots_broadcast trigger).
// onChange(payload) gets { id, starts_at, ends_at, available } for every slot change.
// onSync() runs every time the subscription (re)connects: events sent while we were
// disconnected are NOT replayed, so the caller should refetch then.
export function useSlotChannel(hostId, { onChange, onSync }) {
  let channel

  onMounted(() => {
    // private: true = Realtime checks the RLS policy on realtime.messages before letting us join.
    channel = supabase
      .channel(`slots:${hostId}`, { config: { private: true } })
      .on('broadcast', { event: 'slot_changed' }, ({ payload }) => onChange(payload))
      .subscribe((status, err) => {
        if (status === 'SUBSCRIBED') onSync?.()
        if (err) console.warn('Realtime:', status, err)
      })
  })

  onUnmounted(() => {
    if (channel) supabase.removeChannel(channel)
  })
}
