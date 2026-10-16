// The only module pages import data functions from.
// VITE_BACKEND picks the implementation: 'supabase' (default) or 'nestjs'.
// Every backend must export the same function names (checked below).
import * as supabaseBackend from './supabase'

const NAMES = [
  // core app (N3)
  'capabilities', 'auth', 'getPublicProfile', 'getMyProfile', 'updateMyProfile', 'uploadAvatar', 'removeAvatar', 'avatarUrl',
  'listDashboardSlots', 'createSlot', 'deleteSlot', 'cancelBookingAsHost', 'cancelBookingByToken', 'getBookingStatuses',
  'subscribeSlots', 'bookSlot', 'listFreeSlots',
  // advanced features
  'getHostProfile', 'listHostSlots', 'recurringStrategies', 'bookRecurring',
  'bookSlotLogged', 'cancelAsGuestLogged', 'cancelAsHostLogged', 'deleteSlotLogged', 'logAuditEventFromClient',
  'listAuditHistory', 'getSignatureRequirement', 'setSignatureRequirement', 'checkSignatureStatus',
  'getCaptchaRequirement', 'setCaptchaRequirement', 'unsubscribeReminders',
]

// nestjs: added once src/services/nestjs/ exists (N3, in progress).
const backends = { supabase: supabaseBackend }
const name = import.meta.env.VITE_BACKEND || 'supabase'
const backend = backends[name]
if (!backend) throw new Error(`Unknown VITE_BACKEND "${name}". Expected one of: ${Object.keys(backends).join(', ')}`)
const missing = NAMES.filter((n) => !(n in backend))
if (missing.length) throw new Error(`Backend "${name}" is missing: ${missing.join(', ')}`)

export const backendName = name
export const {
  capabilities, auth, getPublicProfile, getMyProfile, updateMyProfile, uploadAvatar, removeAvatar, avatarUrl,
  listDashboardSlots, createSlot, deleteSlot, cancelBookingAsHost, cancelBookingByToken, getBookingStatuses,
  subscribeSlots, bookSlot, listFreeSlots,
  getHostProfile, listHostSlots, recurringStrategies, bookRecurring,
  bookSlotLogged, cancelAsGuestLogged, cancelAsHostLogged, deleteSlotLogged, logAuditEventFromClient,
  listAuditHistory, getSignatureRequirement, setSignatureRequirement, checkSignatureStatus,
  getCaptchaRequirement, setCaptchaRequirement, unsubscribeReminders,
} = backend
