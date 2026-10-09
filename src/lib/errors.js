// Turn Postgres / PostgREST error codes into messages a person can act on.
// The database is the source of truth for these rules; the UI just explains them.
export function friendlyError(error, overrides = {}) {
  if (!error) return ''
  if (overrides[error.code]) return overrides[error.code]
  switch (error.code) {
    case '23P01': return 'This overlaps one of your existing slots.'
    case '23505': return 'That already exists (duplicate).'
    case '23514': return 'Some of the values are invalid.'
    case '42501': return 'Not allowed.'
    default: return error.message
  }
}
