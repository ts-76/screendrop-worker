import { env } from "cloudflare:workers"
import type { BudgetReservation } from "@/durable-objects/r2-budget"

export class R2BudgetExceededError extends Error {
  constructor(readonly retryAfter: number) {
    super("R2 read budget exhausted")
  }
}

export class R2BudgetUnavailableError extends Error {
  constructor() {
    super("R2 read budget unavailable")
  }
}

function configuredRetryAfter(): number | null {
  const retryAfter = Number(env.R2_BUDGET_RETRY_AFTER)
  return Number.isSafeInteger(retryAfter) && retryAfter > 0 ? retryAfter : null
}

async function reserve(): Promise<void> {
  let result: BudgetReservation
  try {
    // One stable name intentionally maps every request to the global budget.
    result = await env.R2_BUDGET.getByName("global").reserve(1)
  } catch {
    throw new R2BudgetUnavailableError()
  }

  if (result.allowed) return
  if (result.reason !== "budget_exhausted")
    throw new R2BudgetUnavailableError()

  const retryAfter = configuredRetryAfter()
  if (!retryAfter) throw new R2BudgetUnavailableError()
  throw new R2BudgetExceededError(retryAfter)
}

export async function guardedR2Get(
  key: string,
  options?: R2GetOptions,
): Promise<R2ObjectBody | null> {
  await reserve()
  return env.BUCKET.get(key, options)
}
