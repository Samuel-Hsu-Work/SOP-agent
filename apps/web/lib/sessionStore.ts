import {
  createEmptySession,
  type SopSession,
  sopSessionSchema,
  systemWriteContext,
  type WriteContext,
} from "@sop-agent/sop-core";

export const SESSION_STORAGE_KEY = "sop-agent.session";

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type LoadedSession =
  | { status: "loaded"; session: SopSession }
  | { status: "empty" }
  /** Something was stored but is not a valid session, for example from an older version. */
  | { status: "invalid" };

/** Browsers can refuse access to storage (private windows, blocked site data), so this can be null. */
function getBrowserStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function loadSession(storage: StorageLike | null = getBrowserStorage()): LoadedSession {
  if (storage === null) return { status: "empty" };
  try {
    const raw = storage.getItem(SESSION_STORAGE_KEY);
    if (raw === null) return { status: "empty" };
    const parsed = sopSessionSchema.safeParse(JSON.parse(raw));
    return parsed.success ? { status: "loaded", session: parsed.data } : { status: "invalid" };
  } catch {
    return { status: "invalid" };
  }
}

/** Returns false if the session could not be stored, for example when the storage quota is full. */
export function saveSession(
  session: SopSession,
  storage: StorageLike | null = getBrowserStorage(),
): boolean {
  if (storage === null) return false;
  try {
    storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    return true;
  } catch {
    return false;
  }
}

export function clearSession(storage: StorageLike | null = getBrowserStorage()): void {
  try {
    storage?.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}

/**
 * Starts from an empty session. The old stored one is removed first, so if the new one cannot be
 * saved (storage blocked or full) a refresh does not bring the previous chat back.
 */
export function startFreshSession(
  storage: StorageLike | null = getBrowserStorage(),
  context: WriteContext = systemWriteContext,
): { session: SopSession; stored: boolean } {
  clearSession(storage);
  const session = createEmptySession(context);
  return { session, stored: saveSession(session, storage) };
}
