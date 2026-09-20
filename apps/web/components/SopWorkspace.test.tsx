// @vitest-environment happy-dom
import {
  type AdvisoryFieldName,
  applyClaim,
  approveSession,
  type ClaimWriteCommand,
  createEmptySession,
  SOP_FIELD_NAMES,
  type SopFieldName,
  type SopSession,
  setAdvisoryAcknowledgement,
  systemWriteContext,
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

/** An SOP that went through the real approval, so the download button appears as it would for a user. */
function approvedSession(): SopSession {
  const { context, blockingDone, record, acknowledge } = sessionBuilder();
  const ready = acknowledge(
    record(blockingDone(), "controls"),
    ADVISORY.filter((field) => field !== "controls"),
  );
  const approved = approveSession(ready, context);
  if (!approved.ok) throw new Error("setup failed");
  return approved.session;
}

const downloadButton = () => screen.getByRole("button", { name: /Download PDF|Preparing PDF/ });

function pdfResponse(): Response {
  return new Response(new Blob(["%PDF-1.4 test"], { type: "application/pdf" }), {
    status: 200,
    headers: { "content-type": "application/pdf" },
  });
}

/** Stands in for the parts of the browser that start a download, and records what they were given. */
function stubBrowserDownload(options: { clickThrows?: boolean } = {}) {
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
function leavePageWouldBePrevented(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("downloading the approved SOP", () => {
  it("offers no download on a draft", async () => {
    const { empty } = sessionBuilder();
    storeSession(empty);
    render(<SopWorkspace />);
    await waitFor(() => expect(approveButton()).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Download PDF/ })).toBeNull();
  });

  it("fetches the PDF, starts the download under the fixed file name, and only then records it", async () => {
    const approved = approvedSession();
    storeSession(approved);
    const fetchMock = vi.fn(async () => pdfResponse());
    vi.stubGlobal("fetch", fetchMock);
    const browser = stubBrowserDownload();
    render(<SopWorkspace />);
    await waitFor(() => expect(downloadButton()).toBeTruthy());
    expect(screen.getByText(/Not downloaded yet/)).toBeTruthy();
    expect(storedSession().downloadedAt).toBeNull();

    fireEvent.click(downloadButton());

    await waitFor(() => expect(storedSession().downloadedAt).not.toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/sops\/pdf$/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body)).session.status).toBe("approved");
    expect(browser.started).toEqual([
      { fileName: "standard-operating-procedure-2026-01-01-0000.pdf", href: "blob:sop-test" },
    ]);
    await waitFor(() => expect(browser.revoked).toEqual(["blob:sop-test"]));
    expect(storedSession().claims).toEqual(approved.claims);
    expect(await screen.findByText(/PDF downloaded on/)).toBeTruthy();
    expect(screen.queryByText(/Not downloaded yet/)).toBeNull();
  });

  it("shows Preparing while the request is open, and lets the person download again afterwards", async () => {
    storeSession(approvedSession());
    let finishRequest: (response: Response) => void = () => {};
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finishRequest = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    stubBrowserDownload();
    render(<SopWorkspace />);
    await waitFor(() => expect(downloadButton()).toBeTruthy());

    fireEvent.click(downloadButton());
    await waitFor(() => expect(downloadButton().textContent).toBe("Preparing PDF…"));
    expect((downloadButton() as HTMLButtonElement).disabled).toBe(true);

    await act(async () => finishRequest(pdfResponse()));
    await waitFor(() => expect(downloadButton().textContent).toBe("Download PDF"));
    expect((downloadButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps the first download time when the SOP is downloaded again", async () => {
    storeSession(approvedSession());
    const fetchMock = vi.fn(async () => pdfResponse());
    vi.stubGlobal("fetch", fetchMock);
    stubBrowserDownload();
    render(<SopWorkspace />);
    await waitFor(() => expect(downloadButton()).toBeTruthy());

    fireEvent.click(downloadButton());
    await waitFor(() => expect(storedSession().downloadedAt).not.toBeNull());
    const firstTime = storedSession().downloadedAt;

    fireEvent.click(downloadButton());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect((downloadButton() as HTMLButtonElement).disabled).toBe(false));
    expect(storedSession().downloadedAt).toBe(firstTime);
  });

  it("shows the server's refusal and does not record a download", async () => {
    storeSession(approvedSession());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { code: "sop_not_approved", message: "This SOP cannot be exported." } },
          { status: 409 },
        ),
      ),
    );
    const browser = stubBrowserDownload();
    render(<SopWorkspace />);
    await waitFor(() => expect(downloadButton()).toBeTruthy());

    fireEvent.click(downloadButton());

    expect((await screen.findByRole("alert")).textContent).toBe("This SOP cannot be exported.");
    expect(storedSession().downloadedAt).toBeNull();
    expect(browser.started).toEqual([]);
    expect(screen.getByText(/Not downloaded yet/)).toBeTruthy();
  });

  it("does not record a download the browser refused to start", async () => {
    storeSession(approvedSession());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => pdfResponse()),
    );
    stubBrowserDownload({ clickThrows: true });
    render(<SopWorkspace />);
    await waitFor(() => expect(downloadButton()).toBeTruthy());

    fireEvent.click(downloadButton());

    expect((await screen.findByRole("alert")).textContent).toContain(
      "could not start the download",
    );
    expect(storedSession().downloadedAt).toBeNull();
  });

  it("keeps the recorded download on screen when the session cannot be saved, and warns", async () => {
    const storage = installCountingStorage();
    storeSession(approvedSession());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => pdfResponse()),
    );
    stubBrowserDownload();
    render(<SopWorkspace />);
    await waitFor(() => expect(downloadButton()).toBeTruthy());

    storage.failOnWrite = true;
    fireEvent.click(downloadButton());

    expect(await screen.findByText(/PDF downloaded on/)).toBeTruthy();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "could not store this session",
    );
  });

  it("cancels a download in progress when New chat starts, and records nothing on the new chat", async () => {
    storeSession(approvedSession());
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
    const browser = stubBrowserDownload();
    render(<SopWorkspace />);
    await waitFor(() => expect(downloadButton()).toBeTruthy());
    fireEvent.click(downloadButton());
    await waitFor(() => expect(downloadButton().textContent).toBe("Preparing PDF…"));

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));

    await waitFor(() => expect(storedSession().status).toBe("draft"));
    expect(storedSession().downloadedAt).toBeNull();
    expect(browser.started).toEqual([]);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("leaving the page", () => {
  it("asks the browser to confirm only while work would be lost", async () => {
    storeSession(createEmptySession(systemWriteContext));
    const { unmount } = render(<SopWorkspace />);
    await waitFor(() => expect(approveButton()).toBeTruthy());
    expect(leavePageWouldBePrevented()).toBe(false);
    unmount();
    cleanup();

    storeSession(approvedSession());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => pdfResponse()),
    );
    stubBrowserDownload();
    render(<SopWorkspace />);
    await waitFor(() => expect(downloadButton()).toBeTruthy());
    expect(leavePageWouldBePrevented()).toBe(true);

    fireEvent.click(downloadButton());
    await waitFor(() => expect(storedSession().downloadedAt).not.toBeNull());
    await waitFor(() => expect(leavePageWouldBePrevented()).toBe(false));
  });

  it("asks while a draft holds something, and stops asking once the listener's owner unmounts", async () => {
    const { record, empty } = sessionBuilder();
    storeSession(record(empty, "purpose"));
    const { unmount } = render(<SopWorkspace />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm" })).toBeTruthy());
    expect(leavePageWouldBePrevented()).toBe(true);

    unmount();
    expect(leavePageWouldBePrevented()).toBe(false);
  });

  it("does not put a confirmation in front of New chat, even for an SOP that was never downloaded", async () => {
    const confirmSpy = vi.fn(() => false);
    vi.stubGlobal("confirm", confirmSpy);
    storeSession(approvedSession());
    render(<SopWorkspace />);
    await waitFor(() => expect(downloadButton()).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));

    await waitFor(() => expect(storedSession().status).toBe("draft"));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(storedSession().downloadedAt).toBeNull();
  });
});

describe("acknowledged advisory gaps", () => {
  it("changes the chip to Acknowledged and splits the header count when a gap is ticked", async () => {
    const { blockingDone } = sessionBuilder();
    storeSession(blockingDone());
    render(<SopWorkspace />);
    await waitFor(() => expect(approveButton()).toBeTruthy());

    const summary = () => document.querySelector("#readiness-heading + .summary")?.textContent;
    const exceptionsRow = () => {
      const row = screen.getByText("Exceptions", { selector: ".field-label" }).closest("li");
      if (row === null) throw new Error("no Exceptions field");
      return row;
    };
    expect(summary()).toBe("0 blocking · 5 advisory");
    expect(within(exceptionsRow()).getByText("Advisory")).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: "Exceptions" }));

    await waitFor(() => expect(within(exceptionsRow()).getByText("Acknowledged")).toBeTruthy());
    expect(summary()).toBe("0 blocking · 4 advisory · 1 acknowledged");
  });
});

describe("the SOP preview's source line", () => {
  it("shows a suggestion's own note once, not after the generic label", async () => {
    const { blockingDone } = sessionBuilder();
    const stated = blockingDone();
    const result = applyClaim(
      stated,
      {
        kind: "record",
        createdByType: "agent",
        field: "controls",
        status: "proposed",
        statement: "Audit the refunds monthly.",
        note: "Suggested by the interviewer at the user's request.",
        effectiveDate: null,
        sourceMessageId: stated.messages[0]?.id ?? "",
        insertBeforeClaimId: null,
      },
      createDeterministicContext(),
    );
    if (!result.ok) throw new Error("setup failed");
    storeSession(result.session);
    render(<SopWorkspace />);
    fireEvent.click(await screen.findByRole("tab", { name: "SOP preview" }));

    const line = await screen.findByText("Suggested by the interviewer at the user's request.");
    expect(line.textContent?.trim()).toBe("Suggested by the interviewer at the user's request.");
    expect(screen.queryByText(/suggested by the assistant, Suggested/)).toBeNull();
  });
});
