import { createEmptySession, type SopSession } from "@sop-agent/sop-core";
import { createDeterministicContext } from "@sop-agent/sop-core/testing";
import { describe, expect, it } from "vitest";
import {
  clearSession,
  loadSession,
  SESSION_STORAGE_KEY,
  type StorageLike,
  saveSession,
  startFreshSession,
} from "./sessionStore.ts";

function createFakeStorage(options: { failOnWrite?: boolean } = {}): StorageLike & {
  contents: Map<string, string>;
  failOnWrite: boolean;
} {
  const contents = new Map<string, string>();
  const storage = {
    contents,
    failOnWrite: options.failOnWrite ?? false,
    getItem: (key: string) => contents.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (storage.failOnWrite) throw new DOMException("Quota exceeded", "QuotaExceededError");
      contents.set(key, value);
    },
    removeItem: (key: string) => {
      contents.delete(key);
    },
  };
  return storage;
}

const session: SopSession = createEmptySession(createDeterministicContext());

describe("session store", () => {
  it("reports an empty store", () => {
    expect(loadSession(createFakeStorage())).toEqual({ status: "empty" });
  });

  it("loads a session that was saved", () => {
    const storage = createFakeStorage();
    expect(saveSession(session, storage)).toBe(true);
    expect(loadSession(storage)).toEqual({ status: "loaded", session });
  });

  it("reports corrupt or outdated data instead of loading it", () => {
    const storage = createFakeStorage();
    storage.setItem(SESSION_STORAGE_KEY, "not json");
    expect(loadSession(storage)).toEqual({ status: "invalid" });
    storage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ ...session, schemaVersion: 99 }));
    expect(loadSession(storage)).toEqual({ status: "invalid" });
  });

  it("discards a session stored by version 1 of the app instead of migrating it", () => {
    const storage = createFakeStorage();
    const { procedureOrder: _procedureOrder, ...withoutProcedureOrder } = session;
    storage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ ...withoutProcedureOrder, schemaVersion: 1 }),
    );
    expect(loadSession(storage)).toEqual({ status: "invalid" });
  });

  it("returns false instead of throwing when the storage quota is full", () => {
    expect(saveSession(session, createFakeStorage({ failOnWrite: true }))).toBe(false);
  });

  it("copes with storage that is not available at all", () => {
    expect(loadSession(null)).toEqual({ status: "empty" });
    expect(saveSession(session, null)).toBe(false);
    expect(() => clearSession(null)).not.toThrow();
  });

  it("clears the stored session", () => {
    const storage = createFakeStorage();
    saveSession(session, storage);
    clearSession(storage);
    expect(loadSession(storage)).toEqual({ status: "empty" });
  });
});

describe("startFreshSession", () => {
  it("replaces the stored session with an empty one", () => {
    const storage = createFakeStorage();
    saveSession(session, storage);
    const fresh = startFreshSession(storage, createDeterministicContext());

    expect(fresh.stored).toBe(true);
    expect(fresh.session.claims).toEqual([]);
    expect(loadSession(storage)).toEqual({ status: "loaded", session: fresh.session });
  });

  it("does not let the previous chat come back when the new session cannot be saved", () => {
    const storage = createFakeStorage();
    saveSession(session, storage);
    storage.failOnWrite = true;

    const fresh = startFreshSession(storage, createDeterministicContext());

    expect(fresh.stored).toBe(false);
    expect(loadSession(storage)).toEqual({ status: "empty" });
  });
});
