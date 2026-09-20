interface BudgetRequest {
  units?: number;
}

interface BudgetState {
  day: string;
  month: string;
  dayUsed: number;
  monthUsed: number;
}

function limit(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function utcKeys(now = new Date()): { day: string; month: string } {
  const day = now.toISOString().slice(0, 10);
  return { day, month: day.slice(0, 7) };
}

export default class R2Budget implements DurableObject {
  private readonly state: DurableObjectState;
  private readonly env: {
    R2_DAILY_READ_LIMIT?: string;
    R2_MONTHLY_READ_LIMIT?: string;
    R2_BUDGET_RETRY_AFTER?: string;
  };

  constructor(
    state: DurableObjectState,
    env: {
      R2_DAILY_READ_LIMIT?: string;
      R2_MONTHLY_READ_LIMIT?: string;
      R2_BUDGET_RETRY_AFTER?: string;
    },
  ) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST")
      return new Response("Method Not Allowed", { status: 405 });

    const dailyLimit = limit(this.env.R2_DAILY_READ_LIMIT);
    const monthlyLimit = limit(this.env.R2_MONTHLY_READ_LIMIT);
    const retryAfter = limit(this.env.R2_BUDGET_RETRY_AFTER);
    if (!dailyLimit || !monthlyLimit || !retryAfter)
      return Response.json(
        { allowed: false, reason: "budget_unconfigured" },
        { status: 503 },
      );

    let body: BudgetRequest;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { allowed: false, reason: "invalid_request" },
        { status: 400 },
      );
    }
    const units = body.units ?? 1;
    if (!Number.isSafeInteger(units) || units < 1 || units > 100)
      return Response.json(
        { allowed: false, reason: "invalid_units" },
        { status: 400 },
      );

    try {
      const result = await this.state.storage.transaction(async (txn) => {
        const keys = utcKeys();
        const current = (await txn.get<BudgetState>("state")) ?? {
          ...keys,
          dayUsed: 0,
          monthUsed: 0,
        };
        const state: BudgetState =
          current.day === keys.day && current.month === keys.month
            ? current
            : {
                ...keys,
                dayUsed: current.day === keys.day ? current.dayUsed : 0,
                monthUsed: current.month === keys.month ? current.monthUsed : 0,
              };
        if (
          state.dayUsed + units > dailyLimit ||
          state.monthUsed + units > monthlyLimit
        ) {
          // Persist a period reset, if one occurred, while keeping the failed
          // reservation out of both counters.
          await txn.put("state", state);
          return {
            allowed: false as const,
            dayUsed: state.dayUsed,
            monthUsed: state.monthUsed,
          };
        }
        state.dayUsed += units;
        state.monthUsed += units;
        await txn.put("state", state);
        return {
          allowed: true as const,
          dayUsed: state.dayUsed,
          monthUsed: state.monthUsed,
        };
      });
      if (!result.allowed)
        return Response.json(
          {
            allowed: false,
            reason: "budget_exhausted",
            dayUsed: result.dayUsed,
            monthUsed: result.monthUsed,
          },
          {
            status: 429,
            headers: { "retry-after": String(retryAfter) },
          },
        );
      return Response.json(result);
    } catch {
      // Storage failures must not fall through to an unguarded R2 read.
      return Response.json(
        { allowed: false, reason: "budget_unavailable" },
        { status: 503 },
      );
    }
  }
}
