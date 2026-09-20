import { and, eq, lt, or } from "drizzle-orm"
import type { SQL, SQLWrapper } from "drizzle-orm"

export type SearchCursor = {
  createdAt: string
  id: string
}

function validCursor(value: unknown): value is SearchCursor {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "createdAt") === "string" &&
    typeof Reflect.get(value, "id") === "string" &&
    Reflect.get(value, "createdAt").length > 0 &&
    Reflect.get(value, "createdAt").length <= 64 &&
    Reflect.get(value, "id").length > 0 &&
    Reflect.get(value, "id").length <= 128
  )
}

export function decodeSearchCursor(value: string | undefined): SearchCursor | null {
  if (!value) return null
  try {
    const decoded = JSON.parse(atob(value))
    return validCursor(decoded)
      ? { createdAt: decoded.createdAt, id: decoded.id }
      : null
  } catch {
    return null
  }
}

export function encodeSearchCursor(cursor: SearchCursor): string {
  return btoa(JSON.stringify(cursor))
}

export function isAfterSearchCursor(
  row: SearchCursor,
  cursor: SearchCursor,
): boolean {
  return (
    row.createdAt < cursor.createdAt ||
    (row.createdAt === cursor.createdAt && row.id < cursor.id)
  )
}

export function afterSearchCursor(
  cursor: SearchCursor,
  createdAt: SQLWrapper,
  id: SQLWrapper,
): SQL {
  return or(
    lt(createdAt, cursor.createdAt),
    and(eq(createdAt, cursor.createdAt), lt(id, cursor.id)),
  )!
}
