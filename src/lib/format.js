const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })

export const formatDate = (iso) => dateFmt.format(new Date(iso))
export const formatRange = (start, end) => `${timeFmt.format(new Date(start))}–${timeFmt.format(new Date(end))}`
export const formatSlot = (slot) => `${formatDate(slot.starts_at)}, ${formatRange(slot.starts_at, slot.ends_at)}`
