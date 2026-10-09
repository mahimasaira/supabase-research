// The guest's own bookings, remembered in this browser only.
// Guests can't read the bookings table (RLS), so the cancel token they generated
// at booking time is the only thing that lets them cancel later.
const KEY = 'guest-bookings'

export function loadGuestBookings() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) ?? []
  } catch {
    return []
  }
}

function save(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    // Storage unavailable (private mode etc.): the cancel link shown after booking still works.
  }
}

export function rememberGuestBooking(booking) {
  save([...loadGuestBookings(), booking])
}

export function forgetGuestBooking(cancelToken) {
  save(loadGuestBookings().filter((b) => b.cancelToken !== cancelToken))
}
