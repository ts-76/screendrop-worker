import { DurableObject } from "cloudflare:workers"

interface BudgetState {
  day: string
  month: string
  dayUsed: number
  monthUsed: number
}

export type BudgetReservation =
  | {
      allowed: true
      dayUsed: number
      monthUsed: number
    }
  | {
      allowed: false
      reason:
        | "budget_unconfigured"
        | "invalid_units"
        | "budget_exhausted"
        | "budget_unavailable"
      dayUsed?: number
      monthUsed?: number
    }

function limit(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function utcKeys(now = new Date()): { day: string; month: string } {
  const day = now.toISOString().slice(0, 10)
  return { day, month: day.slice(0, 7) }
}

/**
 * A single, named object intentionally owns the global monthly read budget.
 * Its public reserve method is invoked through Durable Object RPC so callers
 * cannot bypass the serialized storage transaction with a forged request.
 */
export class R2Budget extends DurableObject<Env> {
  async reserve(units = 1): Promise<BudgetReservation> {
    const dailyLimit = limit(this.env.R2_DAILY_READ_LIMIT)
    const monthlyLimit = limit(this.env.R2_MONTHLY_READ_LIMIT)
    if (!dailyLimit || !monthlyLimit)
      return { allowed: false, reason: "budget_unconfigured" }

    if (!Number.isSafeInteger(units) || units < 1 || units > 100)
      return { allowed: false, reason: "invalid_units" }

    try {
      return await this.ctx.storage.transaction(async (txn) => {
        const keys = utcKeys()
        const current = (await txn.get<BudgetState>("state")) ?? {
          ...keys,
          dayUsed: 0,
          monthUsed: 0,
        }
        const state: BudgetState =
          current.day === keys.day && current.month === keys.month
            ? current
            : {
                ...keys,
                dayUsed: current.day === keys.day ? current.dayUsed : 0,
                monthUsed: current.month === keys.month ? current.monthUsed : 0,
              }

        if (
          state.dayUsed + units > dailyLimit ||
          state.monthUsed + units > monthlyLimit
        ) {
          // Persist a period reset, if one occurred, while keeping the failed
          // reservation out of both counters.
          await txn.put("state", state)
          return {
            allowed: false as const,
            reason: "budget_exhausted" as const,
            dayUsed: state.dayUsed,
            monthUsed: state.monthUsed,
          }
        }

        state.dayUsed += units
        state.monthUsed += units
        await txn.put("state", state)
        return {
          allowed: true as const,
          dayUsed: state.dayUsed,
          monthUsed: state.monthUsed,
        }
      })
    } catch {
      // Storage failures must not fall through to an unguarded R2 read.
      return { allowed: false, reason: "budget_unavailable" }
    }
  }
}

export default R2Budget
