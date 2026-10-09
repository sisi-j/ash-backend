/**
 * Every answer is JSON. A failure carries a `kind`, a stable snake_case
 * name the launcher and client match on, as ash-core's own errors do, and a
 * `message` for a person reading a log. A caller never parses the message.
 */

export function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function failure(status: number, kind: string, message: string): Response {
  return json({ error: { kind, message } }, status);
}
