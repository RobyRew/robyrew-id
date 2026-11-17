// Small response helpers shared by the API routes.

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  })
}

/** True for a request whose body is JSON (fetch from the page); forms get redirects instead. */
export function isJson(request: Request): boolean {
  return (request.headers.get('content-type') ?? '').split(';')[0]!.trim() === 'application/json'
}

/** 303 back to a page, with a short status code in the query for the page to show. */
export function backTo(path: string, params: Record<string, string>): Response {
  const query = new URLSearchParams(params).toString()
  return new Response(null, { status: 303, headers: { location: query ? `${path}?${query}` : path, 'cache-control': 'no-store' } })
}

export const MESSAGES: Record<string, string> = {
  saved_handle: 'Your handle is saved. Apps pick it up on your next visit.',
  saved_avatar: 'Your picture is saved.',
  saved_avatar_removed: 'Your picture is removed.',
  signed_out: 'Sign in first.',
  taken: 'That handle belongs to someone else.',
  cooldown: 'You changed your handle recently; it can change again after the date shown.',
  suspended: 'This account is suspended.',
  unavailable: 'RobyRew ID could not reach the identity service. Try again in a minute.',
  rate_limited: 'Too many changes in a row. Try again in a few minutes.',
  not_found: 'Your account was not found.',
  empty: 'Choose a file first.',
  too_large: 'That file is too large (10 MB at most).',
  not_an_image: 'That file is not an image this service can read.',
  unsupported_format: 'Use a PNG, JPEG, WebP, AVIF or GIF picture.',
  too_small: 'Use a picture at least 64 × 64 pixels.',
}
