// Audit log, stage 4: the host's history (table audit_log, written by the stage 2 triggers).
// RLS already limits a host to entries about them; the host_id filter just makes it explicit.

// Which tables belong to each filter on the history page.
const KINDS = {
  bookings: ['bookings', 'booking_series'],
  slots: ['slots'],
  profile: ['profiles'],
}

// Newest first, `limit` entries per page. Entries written by one transaction share the same
// created_at (Postgres' now() is the transaction start), so the cursor is (created_at, id):
// a time-only cursor could skip the rest of a recurring booking at a page boundary.
export async function listAuditHistory(db, { hostId, kind = 'all', limit = 50, cursor = null } = {}) {
  let query = db
    .from('audit_log')
    .select('id, created_at, actor_id, actor_role, action, table_name, record_id, changes, context, tx_id')
    .eq('host_id', hostId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1) // one extra to know whether there's another page
  if (kind !== 'all') query = query.in('table_name', KINDS[kind])
  if (cursor) {
    query = query.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`)
  }
  const { data, error } = await query
  if (error) throw error
  const entries = data.slice(0, limit)
  const last = entries.at(-1)
  return { entries, nextCursor: data.length > limit ? { createdAt: last.created_at, id: last.id } : null }
}
