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

// crypto.randomUUID is only exposed in secure contexts (HTTPS or localhost);
// the deployed console is served over plain HTTP at a LAN IP, where crypto
// exists but randomUUID is undefined. getRandomValues works everywhere.
function randomUUID(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  const method = (options.method || "GET").toUpperCase();
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (options.revision) headers.set("If-Match", `"${options.revision}"`);
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    headers.set("Idempotency-Key", options.idempotencyKey || randomUUID());
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
