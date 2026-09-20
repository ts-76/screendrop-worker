import { env } from "cloudflare:workers";

export class R2BudgetExceededError extends Error {
  constructor(readonly retryAfter: number) {
    super("R2 read budget exhausted");
  }
}

export class R2BudgetUnavailableError extends Error {
  constructor() {
    super("R2 read budget unavailable");
  }
}

async function reserve(): Promise<void> {
  const namespace = Reflect.get(env, "R2_BUDGET") as
    DurableObjectNamespace | undefined;
  if (!namespace) throw new R2BudgetUnavailableError();
  const id = namespace.idFromName("global");
  const response = await namespace.get(id).fetch("https://r2-budget/reserve", {
    method: "POST",
    body: JSON.stringify({ units: 1 }),
    headers: { "content-type": "application/json" },
  });
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after"));
    if (!Number.isSafeInteger(retryAfter) || retryAfter <= 0)
      throw new R2BudgetUnavailableError();
    throw new R2BudgetExceededError(retryAfter);
  }
  if (!response.ok) throw new R2BudgetUnavailableError();
  const body: { allowed?: boolean } = await response.json();
  if (body.allowed !== true) throw new R2BudgetUnavailableError();
}

export async function guardedR2Get(
  key: string,
  options?: R2GetOptions,
): Promise<R2ObjectBody | null> {
  await reserve();
  return env.BUCKET.get(key, options);
}
