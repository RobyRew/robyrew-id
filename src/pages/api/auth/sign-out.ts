import type { APIRoute } from 'astro'
import { getApp } from '../../../lib/app.ts'

// The package answers 405 to anything but a same-origin POST.
export const ALL: APIRoute = (ctx) => getApp().auth.signOut(ctx)
