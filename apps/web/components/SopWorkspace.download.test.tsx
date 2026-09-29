// @vitest-environment happy-dom
import { createEmptySession, systemWriteContext } from "@sop-agent/sop-core";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SopWorkspace } from "./SopWorkspace.tsx";
import {
  approveButton,
  approvedSession,
  downloadButton,
  installCountingStorage,
  leavePageWouldBePrevented,
  pdfResponse,
  registerWorkspaceTestHooks,
  sessionBuilder,
  storedSession,
  storeSession,
  stubBrowserDownload,
} from "./sopWorkspaceTestSupport.ts";

/* Downloading the approved SOP, and the warning before leaving an undownloaded one. */

registerWorkspaceTestHooks();

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
