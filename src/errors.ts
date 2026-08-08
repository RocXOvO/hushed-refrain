export class RequestBudgetExhausted extends Error {
  constructor(public readonly budget: number) {
    super(`Request budget ${budget} exhausted`);
    this.name = "RequestBudgetExhausted";
  }
}

export class RequestExecutionError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RequestExecutionError";
  }
}

export class CooldownRequired extends Error {
  constructor(
    public readonly status: number,
    public readonly retryAfterMs: number,
  ) {
    super(`Remote status ${status}; cooldown required`);
    this.name = "CooldownRequired";
  }
}

export class CooldownActive extends Error {
  constructor(public readonly resumeAt: string) {
    super(`Cooldown active until ${resumeAt}`);
    this.name = "CooldownActive";
  }
}

export class ApiResponseError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiResponseError";
  }
}

export class AuthenticationRequired extends Error {
  readonly status = 301;

  constructor() {
    super("网易云登录已失效或当前数据源需要登录，请点击“二维码登录”重新登录。");
    this.name = "AuthenticationRequired";
  }
}

export class RunCancelled extends Error {
  constructor() {
    super("Run cancelled");
    this.name = "RunCancelled";
  }
}

export function errorStatus(error: unknown): number | undefined {
  return errorStatusFrom(error, new Set<object>());
}

function errorStatusFrom(error: unknown, visited: Set<object>): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  if (visited.has(error)) return undefined;
  visited.add(error);
  const candidate = error as Record<string, unknown>;
  const direct = numericStatus(candidate.status);
  if (direct !== undefined) return direct;
  const body = candidate.body;
  if (body && typeof body === "object") {
    const code = numericStatus((body as Record<string, unknown>).code);
    if (code !== undefined) return code;
  }
  return errorStatusFrom(candidate.cause, visited);
}

function numericStatus(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
