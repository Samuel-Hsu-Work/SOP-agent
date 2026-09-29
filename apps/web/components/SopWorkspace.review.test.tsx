// @vitest-environment happy-dom
import { applyClaim, approveSession } from "@sop-agent/sop-core";
import { createDeterministicContext } from "@sop-agent/sop-core/testing";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SESSION_STORAGE_KEY } from "../lib/sessionStore.ts";
import { useSopSession } from "../lib/useSopSession.ts";
import { SopWorkspace } from "./SopWorkspace.tsx";
import {
  ADVISORY,
  approveButton,
  approvedSession,
  downloadButton,
  installCountingStorage,
  pdfResponse,
  registerWorkspaceTestHooks,
  reopenButton,
  sessionBuilder,
  storedSession,
  storeSession,
  stubBrowserDownload,
} from "./sopWorkspaceTestSupport.ts";

/* Review, acknowledgement, approval and reopening, as a person does them in the workspace. */

registerWorkspaceTestHooks();

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
    // The preview no longer prints who confirmed what, only the finished content.
    fireEvent.click(await screen.findByRole("tab", { name: "SOP preview" }));
    expect(screen.queryByText(/Approved by the person interviewed/)).toBeNull();
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
    expect(screen.getByText(/The SOP is approved, so the chat is read-only\./)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("read-only while approved");
    expect(screen.getByRole("button", { name: "Reopen for editing" })).toBeTruthy();

    const reviewButtons = screen
      .getAllByRole("button")
      .filter((button) =>
        /^(Confirm|Reject|Withdraw confirmation)$/.test(button.textContent ?? ""),
      );
    expect(reviewButtons.length).toBeGreaterThan(0);
    for (const button of reviewButtons) expect((button as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(storedSession().status).toBe("draft"));
  });
});

describe("reopening an approved SOP", () => {
  it("returns the same session to draft, unlocking the composer, review and upload again", async () => {
    const storage = installCountingStorage();
    storeSession(approvedSession());
    render(<SopWorkspace />);
    await waitFor(() => expect(reopenButton()).toBeTruthy());
    const before = storedSession();

    storage.writes.length = 0;
    fireEvent.click(reopenButton());

    await waitFor(() => expect(storedSession().status).toBe("draft"));
    expect(storage.writes).toEqual([SESSION_STORAGE_KEY]);
    expect(storedSession()).toMatchObject({ approvedAt: null, downloadedAt: null });
    expect(storedSession().claims).toEqual(before.claims);
    expect(storedSession().messages).toEqual(before.messages);

    expect((screen.getByLabelText("Your message") as HTMLTextAreaElement).disabled).toBe(false);
    expect(screen.queryByText(/The SOP is approved, so the chat is read-only\./)).toBeNull();
    expect(screen.getAllByRole("button", { name: "Confirm" }).length).toBeGreaterThan(0);
    expect(approveButton()).toBeTruthy();
  });

  it("moves focus to the composer after reopening", async () => {
    storeSession(approvedSession());
    render(<SopWorkspace />);
    await waitFor(() => expect(reopenButton()).toBeTruthy());

    fireEvent.click(reopenButton());

    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Your message")));
  });

  it("re-approves with a fresh approval time, and downloads under a new file name", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-01T09:00:00.000Z"));
    storeSession(approvedSession());
    const fetchMock = vi.fn(async () => pdfResponse());
    vi.stubGlobal("fetch", fetchMock);
    const browser = stubBrowserDownload();
    render(<SopWorkspace />);
    await waitFor(() => expect(reopenButton()).toBeTruthy());
    const firstApprovedAt = storedSession().approvedAt;

    fireEvent.click(reopenButton());
    await waitFor(() => expect(storedSession().status).toBe("draft"));

    vi.setSystemTime(new Date("2026-03-01T09:05:00.000Z"));
    fireEvent.click(approveButton());
    await waitFor(() => expect(storedSession().status).toBe("approved"));
    expect(storedSession().approvedAt).not.toBe(firstApprovedAt);

    await waitFor(() => expect(downloadButton()).toBeTruthy());
    fireEvent.click(downloadButton());
    await waitFor(() => expect(storedSession().downloadedAt).not.toBeNull());
    expect(browser.started).toEqual([
      { fileName: "standard-operating-procedure-2026-03-01-0905.pdf", href: "blob:sop-test" },
    ]);
    vi.useRealTimers();
  });

  it("is disabled while a download is in flight, so it cannot race markSopDownloaded", async () => {
    storeSession(approvedSession());
    let finishRequest: (response: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finishRequest = resolve;
          }),
      ),
    );
    stubBrowserDownload();
    render(<SopWorkspace />);
    await waitFor(() => expect(downloadButton()).toBeTruthy());

    fireEvent.click(downloadButton());
    await waitFor(() => expect(reopenButton().disabled).toBe(true));

    fireEvent.click(reopenButton());
    expect(storedSession().status).toBe("approved");

    await act(async () => finishRequest(pdfResponse()));
    await waitFor(() => expect(reopenButton().disabled).toBe(false));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the not-downloaded hint before a download, and clears it after one", async () => {
    storeSession(approvedSession());
    const fetchMock = vi.fn(async () => pdfResponse());
    vi.stubGlobal("fetch", fetchMock);
    stubBrowserDownload();
    render(<SopWorkspace />);
    await waitFor(() => expect(reopenButton()).toBeTruthy());
    expect(screen.getByText(/Not downloaded yet/)).toBeTruthy();

    fireEvent.click(downloadButton());
    await waitFor(() => expect(screen.queryByText(/Not downloaded yet/)).toBeNull());
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
