import { createRouter, createWebHistory } from 'vue-router'
import { useAuth } from '@/composables/useAuth'
import HomeView from '@/views/HomeView.vue'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', name: 'home', component: HomeView },
    { path: '/login', name: 'login', component: () => import('@/views/LoginView.vue'), meta: { guestOnly: true } },
    { path: '/signup', name: 'signup', component: () => import('@/views/SignupView.vue'), meta: { guestOnly: true } },
    { path: '/dashboard', name: 'dashboard', component: () => import('@/views/DashboardView.vue'), meta: { requiresAuth: true } },
    // Public pages: no auth needed, and logged-in hosts can open them too.
    { path: '/book/:hostId', name: 'book', component: () => import('@/views/BookView.vue') },
    { path: '/cancel/:token', name: 'cancel', component: () => import('@/views/CancelView.vue') },
  ],
})

// UX only: this decides which page to show. Data protection comes from RLS (step 4),
// because anyone can skip this guard and call the API directly.
router.beforeEach(async (to) => {
  const { user, ready } = useAuth()
  await ready
  if (to.meta.requiresAuth && !user.value) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }
  if (to.meta.guestOnly && user.value) {
    return { name: 'dashboard' }
  }
})

export default router
