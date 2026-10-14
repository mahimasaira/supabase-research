// The only module pages import data functions from.
// VITE_BACKEND picks the implementation: 'supabase' (default) or, later, 'nestjs'.
// Every backend must export the same function names.
import * as supabaseBackend from './supabase'

const backends = { supabase: supabaseBackend }
const name = import.meta.env.VITE_BACKEND || 'supabase'
const backend = backends[name]
if (!backend) throw new Error(`Unknown VITE_BACKEND "${name}". Expected one of: ${Object.keys(backends).join(', ')}`)

export const backendName = name
export const {
  getHostProfile, listFreeSlots, listHostSlots,
  recurringStrategies, bookRecurring,
  bookSlotLogged, cancelAsGuestLogged, cancelAsHostLogged, deleteSlotLogged, logAuditEventFromClient,
  listAuditHistory,
  getSignatureRequirement, setSignatureRequirement, checkSignatureStatus,
  getCaptchaRequirement, setCaptchaRequirement, bookSlot,
  unsubscribeReminders,
} = backend
