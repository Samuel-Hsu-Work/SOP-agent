// @vitest-environment happy-dom
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
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_STORAGE_KEY } from "../lib/sessionStore.ts";
import { useSopSession } from "../lib/useSopSession.ts";
import { SopWorkspace } from "./SopWorkspace.tsx";

const ADVISORY: AdvisoryFieldName[] = [
  "exceptions",
  "evidence",
  "controls",
  "decisionRules",
  "prerequisites",
];

/** Builds sessions through the real rules, so what the UI shows is what the product can produce. */
function sessionBuilder() {
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
  ) =>
    apply(current, {
      kind: "record",
      createdByType: "agent",
      field,
      status,
      statement: `About ${field}.`,
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

function storeSession(session: SopSession) {
  window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
}

function storedSession(): SopSession {
  return JSON.parse(window.sessionStorage.getItem(SESSION_STORAGE_KEY) ?? "null") as SopSession;
}

/**
 * Replaces the tab's storage with one that counts writes and can be told to fail. happy-dom's
 * Storage does not route through its prototype, so a spy on `Storage.prototype` sees nothing.
 */
function installCountingStorage() {
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

let restoreStorage: () => void = () => {};

const approveButton = () =>
  screen.getByRole("button", { name: "Approve SOP" }) as HTMLButtonElement;

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

describe("the approval step", () => {
  it("keeps Approve disabled while a blocking gap remains, and says why", async () => {
    const { empty } = sessionBuilder();
    storeSession(empty);
    render(<SopWorkspace />);

    await waitFor(() => expect(approveButton()).toBeTruthy());
    expect(approveButton().disabled).toBe(true);
    expect(screen.getByText(/8 blocking gaps remain: Purpose, Scope/)).toBeTruthy();
  });

  it("stays disabled until every advisory gap is ticked and every suggestion is reviewed, then approves and locks", async () => {
    const { blockingDone, record } = sessionBuilder();
    storeSession(record(blockingDone(), "controls", "proposed"));
    render(<SopWorkspace />);
    await waitFor(() => expect(approveButton()).toBeTruthy());

    expect(approveButton().disabled).toBe(true);
    expect(screen.getByText("1 suggestion needs to be confirmed or rejected.")).toBeTruthy();

    const tickAdvisoryGaps = () => {
      for (const label of ["Exceptions", "Evidence", "Decision rules", "Prerequisites"]) {
        fireEvent.click(screen.getByRole("checkbox", { name: label }));
      }
    };
    const checkboxes = () => screen.getAllByRole("checkbox") as HTMLInputElement[];

    // Ticking the four advisory gaps is not enough while the suggestion is unreviewed.
    tickAdvisoryGaps();
    expect(checkboxes().every((box) => box.checked)).toBe(true);
    expect(approveButton().disabled).toBe(true);

    // Reviewing a claim changes the SOP, which clears the ticks: they have to be given again.
    // Every stated claim also offers Confirm, so confirm the suggestion inside its own field.
    const controls = screen.getByText("Controls", { selector: ".field-label" }).closest("li");
    if (controls === null) throw new Error("no Controls field");
    fireEvent.click(within(controls).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(checkboxes().every((box) => !box.checked)).toBe(true));
    expect(approveButton().disabled).toBe(true);

    tickAdvisoryGaps();
    await waitFor(() => expect(approveButton().disabled).toBe(false));

    fireEvent.click(approveButton());
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Approved"));
    expect(storedSession().status).toBe("approved");
    expect((screen.getByLabelText("Your message") as HTMLTextAreaElement).disabled).toBe(true);
  });
});

describe("after approval", () => {
  it("locks the composer and every review control, shows the notices, and leaves New chat working", async () => {
    const { context, blockingDone, record, acknowledge } = sessionBuilder();
    const ready = acknowledge(
      record(blockingDone(), "controls"),
      ADVISORY.filter((f) => f !== "controls"),
    );
    const approved = approveSession(ready, context);
    if (!approved.ok) throw new Error("setup failed");
    storeSession(approved.session);
    render(<SopWorkspace />);

    await waitFor(() => expect(screen.getByLabelText("Your message")).toBeTruthy());
    expect((screen.getByLabelText("Your message") as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.getByText("The SOP is approved, so the chat is read-only.")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("can no longer be changed");

    const reviewButtons = screen
      .getAllByRole("button")
      .filter((button) =>
        /^(Confirm|Reject|Withdraw confirmation|Describe a change in chat)$/.test(
          button.textContent ?? "",
        ),
      );
    expect(reviewButtons.length).toBeGreaterThan(0);
    for (const button of reviewButtons) expect((button as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(storedSession().status).toBe("draft"));
  });
});

describe("review clicks", () => {
  it("writes the session exactly once for one confirm click, and marks the claim confirmed", async () => {
    const { record, empty } = sessionBuilder();
    const storage = installCountingStorage();
    storeSession(record(empty, "purpose"));
    render(<SopWorkspace />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm" })).toBeTruthy());

    storage.writes.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(storedSession().claims[0]?.status).toBe("confirmed"));
    expect(storage.writes).toEqual([SESSION_STORAGE_KEY]);
    expect(storedSession().claimHistory[0]).toMatchObject({
      changedBy: "user",
      reason: "confirmed",
    });
  });

  it("shows the storage warning when the session cannot be saved, and keeps the change on screen", async () => {
    const { record, empty } = sessionBuilder();
    const storage = installCountingStorage();
    storeSession(record(empty, "purpose"));
    render(<SopWorkspace />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm" })).toBeTruthy());

    storage.failOnWrite = true;
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("could not store this session");
    // The change is still on the page, even though it could not be saved.
    expect(within(document.body).getAllByText("Confirmed").length).toBeGreaterThan(0);
  });
});

describe("a review click during a chat turn", () => {
  it("is refused, so the turn's commit cannot overwrite it, and the buttons are disabled meanwhile", async () => {
    const { record, empty } = sessionBuilder();
    const stated = record(empty, "purpose");
    storeSession(stated);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      ),
    );

    const { result } = renderHook(() => useSopSession());
    await waitFor(() => expect(result.current.session).not.toBeNull());
    const claimId = stated.claims[0]?.claimId ?? "";

    let sending: Promise<unknown> = Promise.resolve();
    act(() => {
      sending = result.current.sendMessage("We handle refunds.");
    });
    await waitFor(() => expect(result.current.isSending).toBe(true));

    let changed = true;
    act(() => {
      changed = result.current.confirmClaim(claimId);
    });
    expect(changed).toBe(false);
    expect(result.current.session?.claims[0]?.status).toBe("observed");
    expect(storedSession().claims[0]?.status).toBe("observed");

    act(() => result.current.startNewChat());
    await act(async () => {
      await sending;
    });
  });

  it("disables the review buttons and Approve while the turn is in flight", async () => {
    const { record, empty } = sessionBuilder();
    storeSession(record(empty, "purpose"));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      ),
    );
    render(<SopWorkspace />);
    fireEvent.change(await screen.findByLabelText("Your message"), {
      target: { value: "We handle refunds." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByText("Sending…")).toBeTruthy());

    expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(approveButton().disabled).toBe(true);
    // The checkboxes are disabled through their fieldset, which the `disabled` property does not show.
    const boxes = screen.queryAllByRole("checkbox");
    expect(boxes.length).toBeGreaterThan(0);
    for (const box of boxes) expect(box.closest("fieldset")?.disabled).toBe(true);
  });
});

describe("a turn cancelled by New chat", () => {
  it("does not put the message back in the box", async () => {
    const { empty } = sessionBuilder();
    storeSession(empty);
    // A turn that never finishes, but ends when it is aborted, like a real fetch.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      ),
    );
    render(<SopWorkspace />);
    const box = (await screen.findByLabelText("Your message")) as HTMLTextAreaElement;

    fireEvent.change(box, { target: { value: "We handle refunds." } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByText("Sending…")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeTruthy());
    expect((screen.getByLabelText("Your message") as HTMLTextAreaElement).value).toBe("");
    expect(screen.queryByText("We handle refunds.")).toBeNull();
  });
});
