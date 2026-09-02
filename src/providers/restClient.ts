import { Agent, fetch as undiciFetch, type RequestInit } from "undici";
import { AppError } from "../core/errors.js";

/** An error from a REST provider call, carrying the HTTP status and body snippet. */
export class RestError extends AppError {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: string
  ) {
    super(message);
  }
}

export interface RestClientOptions {
  baseUrl: string;
  /** Default headers applied to every request (e.g. auth, customer id). */
  defaultHeaders?: Record<string, string>;
  /** Allow self-signed TLS (lab use only — Horizon Connection Servers). */
  insecureTls?: boolean;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Query-string parameters (undefined values are skipped). */
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON request body. */
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * A small, dependency-light JSON REST client used by the Citrix and Horizon
 * providers (neither ships an official TypeScript SDK). It centralises base-URL
 * joining, query building, JSON encode/decode, timeouts, typed error mapping,
 * and optional self-signed-TLS support (opt-in, lab only).
 */
export class RestClient {
  private readonly agent?: Agent;

  constructor(private readonly options: RestClientOptions) {
    if (options.insecureTls) {
      this.agent = new Agent({ connect: { rejectUnauthorized: false } });
    }
  }

  private buildUrl(path: string, query?: RequestOptions["query"]): string {
    const base = this.options.baseUrl.replace(/\/+$/, "");
    const rel = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(base + rel);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  async request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    const url = this.buildUrl(path, opts.query);
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...this.options.defaultHeaders,
      ...opts.headers
    };
    const init: RequestInit = { method: opts.method ?? "GET", headers };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    if (this.agent) {
      (init as RequestInit & { dispatcher?: Agent }).dispatcher = this.agent;
    }

    const timeoutMs = opts.timeoutMs ?? this.options.timeoutMs ?? 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    init.signal = controller.signal;

    let res;
    try {
      res = await undiciFetch(url, init);
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        throw new RestError(`Request to ${path} timed out after ${timeoutMs}ms`, 0);
      }
      throw new RestError(`Request to ${path} failed: ${err instanceof Error ? err.message : String(err)}`, 0);
    }
    clearTimeout(timer);

    const text = await res.text();
    if (!res.ok) {
      throw new RestError(`HTTP ${res.status} from ${path}`, res.status, text.slice(0, 2000));
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new RestError(`Non-JSON response from ${path}`, res.status, text.slice(0, 2000));
    }
  }

  get<T = unknown>(path: string, query?: RequestOptions["query"]): Promise<T> {
    return this.request<T>(path, { method: "GET", query });
  }

  post<T = unknown>(path: string, body?: unknown, query?: RequestOptions["query"]): Promise<T> {
    return this.request<T>(path, { method: "POST", body, query });
  }

  /** Release the keep-alive agent, if any. */
  async close(): Promise<void> {
    await this.agent?.close();
  }
}
