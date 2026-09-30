import { loyaltyTermsSchema, type GuestLoyaltyTerms } from "../shared/loyalty-terms";

// Coalesce requests from guest phones. Never delay bootstrap / waiter calls for CRM.
// After a failed refresh, hide financial promises instead of serving stale terms.
export function createLoyaltyTermsLoader(fetchTerms: () => Promise<unknown>, now = Date.now) {
  let cached: GuestLoyaltyTerms | null = null;
  let refreshAt = 0;
  let pending: Promise<GuestLoyaltyTerms | null> | null = null;
  return async (): Promise<GuestLoyaltyTerms | null> => {
    if (now() < refreshAt) return cached;
    if (pending) return pending;
    pending = (async () => {
      try { cached = loyaltyTermsSchema.parse(await fetchTerms()); }
      catch { cached = null; }
      finally { refreshAt = now() + 30_000; pending = null; }
      return cached;
    })();
    return pending;
  };
}
