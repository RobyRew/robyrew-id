import type { APIRoute } from 'astro'
import { getApp } from '../../../lib/app.ts'

// Logto → robyrew-id: User.Created, User.Data.Updated, User.Deleted and
// User.SuspensionStatus.Updated keep the mirror and the sessions current.
export const POST: APIRoute = ({ request }) => getApp().webhook(request)
