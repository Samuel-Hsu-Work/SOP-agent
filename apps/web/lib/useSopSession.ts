"use client";

import {
  type AdvisoryFieldName,
  addReferenceDocument,
  applyClaim,
  approveSession,
  type DocumentReferencesResponse,
  hasSopTarget,
  MAX_PASSAGES_PER_UPLOAD,
  MAX_SESSION_TRANSPORT_BYTES,
  markSopDownloaded,
  reopenSession,
  type SopSession,
  setAdvisoryAcknowledgement,
  sopPdfFileName,
  systemWriteContext,
} from "@sop-agent/sop-core";
import { useCallback, useEffect, useRef, useState } from "react";
import { runChatTurn } from "./chatTurn.ts";
import { requestSopPdf } from "./downloadSopPdf.ts";
import { checkFileBeforeUpload, requestDocumentReferences } from "./extractDocument.ts";
import { saveBlobAsFile } from "./saveBlobAsFile.ts";
import { loadSession, saveSession, startFreshSession } from "./sessionStore.ts";

// A trailing slash on the configured address would turn every request path into "//chat".
const API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000").replace(
  /\/+$/,
  "",
);

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

/** What became of an upload, in words for the person who made it. `info` is a result, `error` is a refusal. */
export interface UploadReport {
  kind: "info" | "error";
  message: string;
}

/** How many bytes a session weighs when it is sent, which is what the API's body limit counts. */
function transportSize(session: SopSession): number {
  return new TextEncoder().encode(JSON.stringify(session)).length;
}

function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}

const NO_TARGET_MESSAGE =
  "First tell the assistant which process this SOP covers, then upload the document.";

/**
 * Keeps the passages a document gave as reference material on a copy of the session, all or
 * nothing, and raises a conflict for any that disagrees with what the user said. Refused if the
 * result could no longer be sent to the API; the caller then keeps the session it had.
 */
function keepPassages(
  session: SopSession,
  response: DocumentReferencesResponse,
):
  | { ok: true; session: SopSession; added: number; alreadyThere: number; conflictsRaised: number }
  | { ok: false; message: string } {
  const result = addReferenceDocument(
    session,
    { document: response.document, passages: response.passages },
    systemWriteContext,
  );
  if (!result.ok) {
    return {
      ok: false,
      message:
        result.error.code === "no_target"
          ? NO_TARGET_MESSAGE
          : `${result.error.message} Nothing from this document was kept.`,
    };
  }
  if (transportSize(result.session) > MAX_SESSION_TRANSPORT_BYTES) {
    return {
      ok: false,
      message:
        "Keeping this document's passages would make the session too large to keep working on, so none were kept.",
    };
  }
  return result;
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
  const [isUploading, setIsUploading] = useState(false);
  const [uploadReport, setUploadReport] = useState<UploadReport | null>(null);
  const activeTurn = useRef<AbortController | null>(null);
  const activeDownload = useRef<AbortController | null>(null);
  const activeUpload = useRef<AbortController | null>(null);
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
      activeUpload.current?.abort();
    },
    [],
  );

  const sendMessage = useCallback(
    async (message: string): Promise<SendResult> => {
      const current = sessionRef.current;
      if (current === null || isSendingRef.current || activeUpload.current !== null) {
        return { outcome: "cancelled" };
      }

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
      if (current === null || isSendingRef.current || activeUpload.current !== null) return false;

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
   * Puts an approved SOP back to draft so it can be changed and approved again. Refused while a
   * PDF download is in flight: the file would still save under the old name harmlessly, but the
   * follow-up call that records the download would then run against a session already back to
   * draft and fail. A stale download error or upload report belongs to the discarded approval
   * cycle, so both are cleared on success.
   */
  const reopen = useCallback(() => {
    if (activeDownload.current !== null) return false;
    const changed = applyLocalChange((current) => {
      const result = reopenSession(current, systemWriteContext);
      return result.ok
        ? { ok: true, session: result.session }
        : { ok: false, message: result.error.message };
    });
    if (changed) {
      setDownloadError(null);
      setUploadReport(null);
    }
    return changed;
  }, [applyLocalChange]);

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

  /**
   * Reads a document for this SOP and keeps what it holds as reference material. The API reads the
   * file for the session's purpose and scope and proves each quote; the passages are kept here, and
   * nothing enters the SOP until the user answers the assistant about one. Refused before the user
   * has said what the SOP covers, while a turn or another upload is in flight, and after approval,
   * because the rest of the page builds on the session as it is now.
   */
  const uploadDocument = useCallback(
    async (file: File): Promise<void> => {
      const current = sessionRef.current;
      if (
        current === null ||
        current.status === "approved" ||
        isSendingRef.current ||
        activeUpload.current !== null
      ) {
        return;
      }
      if (!hasSopTarget(current)) {
        setUploadReport({ kind: "error", message: NO_TARGET_MESSAGE });
        return;
      }
      const refusal = checkFileBeforeUpload(file);
      if (refusal !== null) {
        setUploadReport({ kind: "error", message: refusal });
        return;
      }

      const controller = new AbortController();
      activeUpload.current = controller;
      setIsUploading(true);
      setUploadReport(null);

      const result = await requestDocumentReferences({
        apiBaseUrl: API_BASE_URL,
        file,
        session: current,
        signal: controller.signal,
      });

      // New chat cancelled this upload: leave the state alone.
      if (controller.signal.aborted) return;
      activeUpload.current = null;
      setIsUploading(false);

      if (result.kind === "failed") {
        setUploadReport({ kind: "error", message: result.message });
        return;
      }
      const { response } = result;
      const { fileName } = response.document;
      if (response.passages.length === 0) {
        const dropped = response.rejected.count;
        const known = response.alreadyKnownCount;
        setUploadReport({
          kind: "info",
          message:
            known > 0
              ? `${fileName} holds nothing this SOP does not already say.`
              : dropped === 0
                ? `Nothing in ${fileName} is needed for this SOP.`
                : `Nothing from ${fileName} could be used: ${dropped} ${plural(dropped, "passage", "passages")} could not be verified against the text.`,
        });
        return;
      }

      // Nothing else can have changed the session while the upload was running.
      const latest = sessionRef.current;
      if (latest === null) return;
      const kept = keepPassages(latest, response);
      if (!kept.ok) {
        setUploadReport({ kind: "error", message: kept.message });
        return;
      }
      replaceSession(kept.session);
      setError(saveSession(kept.session) ? null : STORAGE_FAILURE_MESSAGE);

      const parts = [
        `Read ${fileName} for this SOP: ${kept.added} ${plural(kept.added, "passage", "passages")} kept as reference. Nothing was added to the SOP; the assistant will ask you about ${plural(kept.added, "it", "them")}.`,
      ];
      if (kept.alreadyThere > 0) {
        parts.push(
          `${kept.alreadyThere} ${plural(kept.alreadyThere, "was", "were")} already kept from this file.`,
        );
      }
      if (response.alreadyKnownCount > 0) {
        parts.push(
          `${response.alreadyKnownCount} ${plural(response.alreadyKnownCount, "passage says", "passages say")} what the SOP already says.`,
        );
      }
      const repeated = response.rejected.reasons.duplicate ?? 0;
      const unverified = response.rejected.count - repeated;
      if (unverified > 0) {
        parts.push(
          `${unverified} ${plural(unverified, "passage was", "passages were")} dropped because ${plural(unverified, "it", "they")} could not be verified against the text.`,
        );
      }
      if (response.truncatedCount > 0) {
        parts.push(
          `${response.truncatedCount} more ${plural(response.truncatedCount, "was", "were")} left out because one document gives at most ${MAX_PASSAGES_PER_UPLOAD}.`,
        );
      }
      if (kept.conflictsRaised > 0) {
        parts.push(
          `${kept.conflictsRaised} ${plural(kept.conflictsRaised, "passage disagrees", "passages disagree")} with what you said: tell the assistant the final answer in chat.`,
        );
      }
      setUploadReport({ kind: "info", message: parts.join(" ") });
    },
    [replaceSession],
  );

  /** One click, no confirmation: cancel any turn in flight and start from an empty session. */
  const startNewChat = useCallback(() => {
    activeTurn.current?.abort();
    activeTurn.current = null;
    activeDownload.current?.abort();
    activeDownload.current = null;
    setIsDownloading(false);
    setDownloadError(null);
    activeUpload.current?.abort();
    activeUpload.current = null;
    setIsUploading(false);
    setUploadReport(null);
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
    reopen,
    downloadPdf,
    isDownloading,
    downloadError,
    uploadDocument,
    isUploading,
    uploadReport,
  };
}
