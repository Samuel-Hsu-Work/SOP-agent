/*
 * What the SopWorkspace component tests share: sessions built through the real rules, storage that
 * can count or refuse writes, the browser pieces a download needs, and the hooks that reset a tab.
 * Test-only; nothing in the app imports it.
 */
import {
  type AdvisoryFieldName,
  applyClaim,
  approveSession,
  type ClaimWriteCommand,
  SOP_FIELD_NAMES,
  type SopFieldName,
  type SopSession,
  setAdvisoryAcknowledgement,
} from "@sop-agent/sop-core";
import {
  createDeterministicContext,
  createSessionWithUserMessage,
} from "@sop-agent/sop-core/testing";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { SESSION_STORAGE_KEY } from "../lib/sessionStore.ts";

let restoreStorage: () => void = () => {};

export const ADVISORY: AdvisoryFieldName[] = [
  "exceptions",
  "evidence",
  "controls",
  "decisionRules",
  "prerequisites",
];

/** Builds sessions through the real rules, so what the UI shows is what the product can produce. */
export function sessionBuilder() {
  const context = createDeterministicContext();
  const { session: empty, messageId } = createSessionWithUserMessage(context);
  const apply = (current: SopSession, command: ClaimWriteCommand) => {
    const result = applyClaim(current, command, context);
    if (!result.ok) throw new Error(`setup failed: ${result.error.code}`);
    return result.session;
  };
  const record = (
    current: SopSession,
    field: SopFieldName,
    status: "observed" | "proposed" = "observed",
    statement = `About ${field}.`,
  ) =>
    apply(current, {
      kind: "record",
      createdByType: "agent",
      field,
      status,
      statement,
      note: null,
      effectiveDate: null,
      sourceMessageId: messageId,
      insertBeforeClaimId: null,
    });
  const blockingDone = () => {
    let current = empty;
    for (const field of SOP_FIELD_NAMES.slice(0, 8)) current = record(current, field);
    return current;
  };
  const acknowledge = (current: SopSession, fields: AdvisoryFieldName[]) => {
    let next = current;
    for (const field of fields) {
      const result = setAdvisoryAcknowledgement(next, { field, acknowledged: true }, context);
      if (!result.ok) throw new Error("setup failed");
      next = result.session;
    }
    return next;
  };
  return { context, empty, record, blockingDone, acknowledge };
}

export function storeSession(session: SopSession) {
  window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
}

export function storedSession(): SopSession {
  return JSON.parse(window.sessionStorage.getItem(SESSION_STORAGE_KEY) ?? "null") as SopSession;
}

/**
 * Replaces the tab's storage with one that counts writes and can be told to fail. happy-dom's
 * Storage does not route through its prototype, so a spy on `Storage.prototype` sees nothing.
 */
export function installCountingStorage() {
  const original = Object.getOwnPropertyDescriptor(window, "sessionStorage");
  const contents = new Map<string, string>();
  const control = { failOnWrite: false, writes: [] as string[] };
  const fake: Storage = {
    get length() {
      return contents.size;
    },
    clear: () => contents.clear(),
    getItem: (key) => contents.get(key) ?? null,
    key: (index) => [...contents.keys()][index] ?? null,
    removeItem: (key) => {
      contents.delete(key);
    },
    setItem: (key, value) => {
      if (control.failOnWrite) throw new DOMException("Quota exceeded", "QuotaExceededError");
      control.writes.push(key);
      contents.set(key, value);
    },
  };
  Object.defineProperty(window, "sessionStorage", { value: fake, configurable: true });
  restoreStorage = () => {
    if (original !== undefined) Object.defineProperty(window, "sessionStorage", original);
  };
  return control;
}

export const approveButton = () =>
  screen.getByRole("button", { name: "Approve SOP" }) as HTMLButtonElement;

/** An SOP that went through the real approval, so the download button appears as it would for a user. */
export function approvedSession(): SopSession {
  const { context, blockingDone, record, acknowledge } = sessionBuilder();
  const ready = acknowledge(
    record(blockingDone(), "controls"),
    ADVISORY.filter((field) => field !== "controls"),
  );
  const approved = approveSession(ready, context);
  if (!approved.ok) throw new Error("setup failed");
  return approved.session;
}

export const downloadButton = () =>
  screen.getByRole("button", { name: /Download PDF|Preparing PDF/ });
export const reopenButton = () =>
  screen.getByRole("button", { name: "Reopen for editing" }) as HTMLButtonElement;

export function pdfResponse(): Response {
  return new Response(new Blob(["%PDF-1.4 test"], { type: "application/pdf" }), {
    status: 200,
    headers: { "content-type": "application/pdf" },
  });
}

/** Stands in for the parts of the browser that start a download, and records what they were given. */
export function stubBrowserDownload(options: { clickThrows?: boolean } = {}) {
  const started: { fileName: string; href: string }[] = [];
  const revoked: string[] = [];
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: () => "blob:sop-test",
    revokeObjectURL: (url: string) => revoked.push(url),
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    if (options.clickThrows) throw new Error("blocked");
    started.push({ fileName: this.download, href: this.href });
  });
  return { started, revoked };
}

/** A `beforeunload` event as the browser sends it, so the test sees whether the page asked to stay. */
export function leavePageWouldBePrevented(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

/**
 * The hooks every workspace test file registers: a clean tab before each test, and afterwards the
 * DOM, any replaced storage, and every mock and stubbed global put back.
 */
export function registerWorkspaceTestHooks() {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    restoreStorage();
    restoreStorage = () => {};
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
}
