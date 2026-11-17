import type { APIRoute } from 'astro'
import { getApp } from '../../../lib/app.ts'

export const GET: APIRoute = (ctx) => getApp().auth.callback(ctx)
