import { defineMiddleware } from 'astro:middleware'
import { getApp } from './lib/app.ts'

// /@<old handle> → 301 /@<current handle>. In middleware rather than in the page's
// frontmatter: Astro's checker skips a top-level `return` there.
export const onRequest = defineMiddleware((context, next) => {
  const match = /^\/@([^/]+)\/?$/.exec(context.url.pathname)
  if (match) {
    let raw = ''
    try {
      raw = decodeURIComponent(match[1]!)
    } catch {
      return next()
    }
    const entry = getApp().handles.lookup(raw)
    if (entry?.kind === 'moved') return context.redirect(`/@${entry.handle}`, 301)
    // A non-canonical spelling (/@Bob) goes to the canonical one.
    if (entry?.kind === 'profile' && entry.handle !== match[1]) return context.redirect(`/@${entry.handle}`, 301)
  }
  return next()
})
