"use client";

import {
  type AdvisoryFieldName,
  applyClaim,
  approveSession,
  markSopDownloaded,
  type SopSession,
  setAdvisoryAcknowledgement,
  sopPdfFileName,
  systemWriteContext,
} from "@sop-agent/sop-core";
import { useCallback, useEffect, useRef, useState } from "react";
import { runChatTurn } from "./chatTurn.ts";
import { requestSopPdf } from "./downloadSopPdf.ts";
import { saveBlobAsFile } from "./saveBlobAsFile.ts";
import { loadSession, saveSession, startFreshSession } from "./sessionStore.ts";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

const DOWNLOAD_START_FAILURE_MESSAGE =
  "Your browser could not start the download. Try again, or check its download settings.";
const STORAGE_FAILURE_MESSAGE =
  "Your browser could not store this session. It will be lost if you refresh the page.";

/**
 * What became of a send. Only `failed` puts the user's words back in the box: a turn that was
 * cancelled (New chat, leaving the page) is not a failure, and its text must not reappear.
 */
export interface SendResult {
  outcome: "committed" | "failed" | "cancelled";
}

/** A local change to the session: the new session, or a sentence saying why it was refused. */
type LocalChange = { ok: true; session: SopSession } | { ok: false; message: string };

/**
 * Owns the session for the page. The session lives in the browser tab (sessionStorage) and is
 * replaced only when the API commits a turn, never by provisional text or a failed turn.
 */
export function useSopSession() {
  // Null until the browser has been asked for the stored session, so the server render and the
  // first client render agree. Reading storage during render would cause a hydration mismatch.
  const [session, setSession] = useState<SopSession | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const [streamingReply, setStreamingReply] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const activeTurn = useRef<AbortController | null>(null);
  const activeDownload = useRef<AbortController | null>(null);
  // The latest session and whether a turn is in flight, readable from any callback without waiting
  // for a render. A review click and a chat commit both build on the session as it is now, so
  // neither can overwrite the other with an older copy.
  const sessionRef = useRef<SopSession | null>(null);
  const isSendingRef = useRef(false);

  const replaceSession = useCallback((next: SopSession) => {
    sessionRef.current = next;
    setSession(next);
  }, []);
  const markSending = useCallback((value: boolean) => {
    isSendingRef.current = value;
    setIsSending(value);
  }, []);

  useEffect(() => {
    const loaded = loadSession();
    if (loaded.status === "loaded") {
      replaceSession(loaded.session);
      return;
    }
    const fresh = startFreshSession();
    replaceSession(fresh.session);
    if (!fresh.stored) setError(STORAGE_FAILURE_MESSAGE);
    if (loaded.status === "invalid") {
      setNotice("The previous session could not be restored, so a new chat was started.");
    }
  }, [replaceSession]);

  useEffect(
    () => () => {
      activeTurn.current?.abort();
      activeDownload.current?.abort();
    },
    [],
  );

  const sendMessage = useCallback(
    async (message: string): Promise<SendResult> => {
      const current = sessionRef.current;
      if (current === null || isSendingRef.current) return { outcome: "cancelled" };

      const controller = new AbortController();
      activeTurn.current = controller;
      markSending(true);
      setError(null);
      setNotice(null);
      setPendingMessage(message);
      setStreamingReply("");

      const result = await runChatTurn({
        apiBaseUrl: API_BASE_URL,
        session: current,
        message,
        signal: controller.signal,
        onTextDelta: (text) => setStreamingReply((current) => current + text),
        onReset: () => setStreamingReply(""),
      });

      // A new chat, or leaving the page, cancelled this turn: leave the state alone.
      if (controller.signal.aborted) return { outcome: "cancelled" };

      activeTurn.current = null;
      markSending(false);
      setPendingMessage(null);
      setStreamingReply("");

      if (result.kind === "failed") {
        setError(result.message);
        return { outcome: "failed" };
      }
      replaceSession(result.session);
      if (!saveSession(result.session)) setError(STORAGE_FAILURE_MESSAGE);
      return { outcome: "committed" };
    },
    [markSending, replaceSession],
  );

  /**
   * Applies a change that runs entirely in the browser: a review click, an acknowledgement, the
   * approval. Refused while a chat turn is in flight, because that turn is building on the current
   * session and its commit would overwrite the change. Returns whether the session changed.
   */
  const applyLocalChange = useCallback(
    (change: (current: SopSession) => LocalChange): boolean => {
      const current = sessionRef.current;
      if (current === null || isSendingRef.current) return false;

      const result = change(current);
      if (!result.ok) {
        setError(result.message);
        return false;
      }
      if (result.session === current) return false;

      setError(null);
      replaceSession(result.session);
      if (!saveSession(result.session)) setError(STORAGE_FAILURE_MESSAGE);
      return true;
    },
    [replaceSession],
  );

  const reviewClaim = useCallback(
    (claimId: string, action: "confirm" | "reject") =>
      applyLocalChange((current) => {
        const result = applyClaim(
          current,
          { kind: action, createdByType: "user", claimId },
          systemWriteContext,
        );
        return result.ok
          ? { ok: true, session: result.session }
          : { ok: false, message: result.error.message };
      }),
    [applyLocalChange],
  );
  const confirmClaim = useCallback(
    (claimId: string) => reviewClaim(claimId, "confirm"),
    [reviewClaim],
  );
  const rejectClaim = useCallback(
    (claimId: string) => reviewClaim(claimId, "reject"),
    [reviewClaim],
  );

  const setAcknowledged = useCallback(
    (field: AdvisoryFieldName, acknowledged: boolean) =>
      applyLocalChange((current) => {
        const result = setAdvisoryAcknowledgement(
          current,
          { field, acknowledged },
          systemWriteContext,
        );
        return result.ok
          ? { ok: true, session: result.session }
          : { ok: false, message: result.error.message };
      }),
    [applyLocalChange],
  );

  const approve = useCallback(
    () =>
      applyLocalChange((current) => {
        const result = approveSession(current, systemWriteContext);
        return result.ok
          ? { ok: true, session: result.session }
          : { ok: false, message: result.error.message };
      }),
    [applyLocalChange],
  );

  /**
   * Downloads the approved SOP as a PDF. The download is recorded on the session (once, keeping
   * the first time) only after the browser has started it, so a failed request or a blocked
   * download never marks the SOP as downloaded.
   */
  const downloadPdf = useCallback(async (): Promise<void> => {
    const current = sessionRef.current;
    if (current === null || current.status !== "approved" || activeDownload.current !== null) {
      return;
    }
    const controller = new AbortController();
    activeDownload.current = controller;
    setIsDownloading(true);
    setDownloadError(null);

    const result = await requestSopPdf({
      apiBaseUrl: API_BASE_URL,
      session: current,
      signal: controller.signal,
    });

    // New chat cancelled this download: leave the state alone.
    if (controller.signal.aborted) return;
    activeDownload.current = null;
    setIsDownloading(false);

    if (result.kind === "failed") {
      setDownloadError(result.message);
      return;
    }
    try {
      saveBlobAsFile(result.pdf, sopPdfFileName(current.approvedAt ?? ""));
    } catch {
      setDownloadError(DOWNLOAD_START_FAILURE_MESSAGE);
      return;
    }
    applyLocalChange((latest) => {
      const marked = markSopDownloaded(latest, systemWriteContext);
      return marked.ok
        ? { ok: true, session: marked.session }
        : { ok: false, message: marked.error.message };
    });
  }, [applyLocalChange]);

  /** One click, no confirmation: cancel any turn in flight and start from an empty session. */
  const startNewChat = useCallback(() => {
    activeTurn.current?.abort();
    activeTurn.current = null;
    activeDownload.current?.abort();
    activeDownload.current = null;
    setIsDownloading(false);
    setDownloadError(null);
    markSending(false);
    setPendingMessage(null);
    setStreamingReply("");
    setNotice(null);
    const fresh = startFreshSession();
    replaceSession(fresh.session);
    setError(fresh.stored ? null : STORAGE_FAILURE_MESSAGE);
  }, [markSending, replaceSession]);

  return {
    session,
    notice,
    error,
    pendingMessage,
    streamingReply,
    isSending,
    sendMessage,
    startNewChat,
    confirmClaim,
    rejectClaim,
    setAcknowledged,
    approve,
    downloadPdf,
    isDownloading,
    downloadError,
  };
}
