const SAFE_RETRY_DELAYS_MS = [300, 900] as const;
const CLIENT_RECOVERY_COOLDOWN_MS = 5 * 60 * 1_000;

export const QRNASTOL_CLIENT_RECOVERY_KEY = "qrnastol:client-recovery";

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type RecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function waitFor(milliseconds: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

export function isSafeReadMethod(method?: string) {
  const normalized = (method || "GET").trim().toUpperCase();
  return normalized === "GET" || normalized === "HEAD";
}

export function isTemporaryResponse(status: number) {
  return status === 408
    || status === 425
    || status === 429
    || (status >= 500 && status <= 599);
}

export async function fetchWithNetworkRecovery(
  input: RequestInfo | URL,
  init: RequestInit = {},
  dependencies: {
    fetcher?: FetchLike;
    wait?: (milliseconds: number) => Promise<void>;
    retryDelaysMs?: readonly number[];
  } = {},
) {
  const fetcher = dependencies.fetcher || fetch;
  const pause = dependencies.wait || waitFor;
  const retryDelaysMs = dependencies.retryDelaysMs || SAFE_RETRY_DELAYS_MS;
  const safeRead = isSafeReadMethod(init.method);

  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetcher(input, init);
      if (
        !safeRead
        || !isTemporaryResponse(response.status)
        || attempt >= retryDelaysMs.length
      ) {
        return response;
      }
    } catch (error) {
      if (!safeRead || isAbortError(error) || attempt >= retryDelaysMs.length) {
        throw error;
      }
    }

    await pause(retryDelaysMs[attempt]);
  }
}

export function claimClientRecovery(
  storage: RecoveryStorage,
  now = Date.now(),
  cooldownMs = CLIENT_RECOVERY_COOLDOWN_MS,
) {
  try {
    const previous = Number(storage.getItem(QRNASTOL_CLIENT_RECOVERY_KEY) || 0);
    if (Number.isFinite(previous) && previous > 0 && now - previous < cooldownMs) {
      return false;
    }
    storage.setItem(QRNASTOL_CLIENT_RECOVERY_KEY, String(now));
    return true;
  } catch {
    return false;
  }
}

export function resetClientRecovery(storage: RecoveryStorage) {
  try {
    storage.removeItem(QRNASTOL_CLIENT_RECOVERY_KEY);
  } catch {
    // Embedded and private browsers may deny storage access.
  }
}
