export class RequestBudgetExhausted extends Error {
  constructor(public readonly budget: number) {
    super(`Request budget ${budget} exhausted`);
    this.name = "RequestBudgetExhausted";
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
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as Record<string, unknown>;
  const direct = Number(candidate.status);
  if (Number.isFinite(direct)) return direct;
  const body = candidate.body;
  if (body && typeof body === "object") {
    const code = Number((body as Record<string, unknown>).code);
    if (Number.isFinite(code)) return code;
  }
  return undefined;
}
