// Stage 3: recurring booking via the Edge Function book-recurring
// (supabase/functions/book-recurring/index.ts). The function opens a direct Postgres
// connection and runs BEGIN … COMMIT / ROLLBACK itself, as the caller's role (RLS applies).
// supabase-js sends the publishable key or the logged-in user's JWT automatically.

export async function bookRecurringEdge(db, { hostId, firstSlot, weeks, guestName, guestEmail }) {
  const { data, error } = await db.functions.invoke('book-recurring', {
    body: { hostId, firstStartsAt: firstSlot.starts_at, weeks, guestName, guestEmail },
  })
  // A rejected booking was rolled back; nothing is left (check.sql in Studio is the proof).
  const saved = { seriesId: null, weeks: [] }

  if (error) {
    // Non-2xx: supabase-js only says "Edge Function returned a non-2xx status code";
    // the JSON body (clash, notEnoughWeeks, …) has to be read from the raw Response.
    const body = await error.context?.json?.().catch(() => null)
    if (body?.clash) return { ok: false, clash: body.clash, ranAs: body.ranAs, saved }
    if (body?.notEnoughWeeks) return { ok: false, clash: null, notEnoughWeeks: body.notEnoughWeeks, ranAs: body.ranAs, saved }
    const status = error.context?.status
    return {
      ok: false,
      clash: null,
      error: body?.error?.code ? body.error : { code: status ? `HTTP ${status}` : 'network', message: body?.error?.message ?? body?.error ?? error.message },
      saved,
    }
  }

  return { ok: true, seriesId: data.seriesId, weeks: data.weeks, ranAs: data.ranAs, saved: data }
}
