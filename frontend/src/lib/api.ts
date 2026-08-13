const API_ROOT = "/api/v1";

export class APIError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

interface RequestOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
  revision?: number;
  idempotencyKey?: string;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  const method = (options.method || "GET").toUpperCase();
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (options.revision) headers.set("If-Match", `"${options.revision}"`);
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    headers.set("Idempotency-Key", options.idempotencyKey || crypto.randomUUID());
  }
  const response = await fetch(`${API_ROOT}${path}`, {
    ...options,
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  if (!response.ok) {
    let code = "request_failed";
    let message = `${response.status} ${response.statusText}`;
    try {
      const payload = await response.json();
      const error = payload?.error;
      if (typeof error === "string") message = error;
      else if (error) {
        code = error.code || code;
        message = error.message || message;
      }
    } catch { /* response was not JSON */ }
    throw new APIError(response.status, code, message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const keys = {
  tasks: ["tasks"] as const,
  task: (id: number) => ["tasks", id] as const,
  projects: ["projects"] as const,
  roles: ["roles"] as const,
  runtimes: ["runtimes"] as const,
  provisioning: ["runtimes", "provisioning"] as const,
  skills: ["skills"] as const,
  stats: ["stats"] as const,
  sessions: ["sessions"] as const,
  workflows: ["workflows"] as const
};
