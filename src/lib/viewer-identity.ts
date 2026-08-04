/**
 * Client-side view-count deduplication: a localStorage flag per share id
 * so the same browser doesn't inflate the counter on repeat visits.
 */

export function hasViewedShare(shareId: string): boolean {
  if (typeof localStorage === "undefined") return true;
  return localStorage.getItem(`screendrop_viewed_${shareId}`) === "1";
}

export function markShareViewed(shareId: string) {
  localStorage.setItem(`screendrop_viewed_${shareId}`, "1");
}

/**
 * Count this viewer once per share (localStorage-guarded) and record the
 * analytics event server-side. Resolves true when a view was counted.
 */
export async function recordShareView(shareId: string): Promise<boolean> {
  if (hasViewedShare(shareId)) return false;
  markShareViewed(shareId);
  try {
    const response = await fetch(`/api/view/${shareId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ referrer: document.referrer || null }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
