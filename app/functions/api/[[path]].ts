interface Env {
  CORE: { fetch(request: Request): Promise<Response> }
}

// Pages Function: every /api/* request goes, unchanged, to the accrue-core worker
// over the service binding, so the app and its API share one origin.
export const onRequest = ({ request, env }: { request: Request; env: Env }): Promise<Response> => env.CORE.fetch(request)
