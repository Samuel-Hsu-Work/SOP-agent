"use client";

import {
  type AdvisoryFieldName,
  applyClaim,
  approveSession,
  type ClaimDraft,
  MAX_EXTRACTED_CLAIMS_PER_DOCUMENT,
  MAX_SESSION_TRANSPORT_BYTES,
  markSopDownloaded,
  type SopSession,
  setAdvisoryAcknowledgement,
  sopPdfFileName,
  systemWriteContext,
} from "@sop-agent/sop-core";
import { useCallback, useEffect, useRef, useState } from "react";
import { runChatTurn } from "./chatTurn.ts";
import { requestSopPdf } from "./downloadSopPdf.ts";
import { checkFileBeforeUpload, requestDocumentExtraction } from "./extractDocument.ts";
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

/**
 * Writes the drafts a document produced into a copy of the session, one at a time, through
 * `applyClaim`. All or nothing: if any draft is refused (the session is full) or the result could
 * no longer be sent to the API, the caller keeps the session it had.
 */
function writeDrafts(
  session: SopSession,
  drafts: readonly ClaimDraft[],
):
  | { ok: true; session: SopSession; added: number; alreadyThere: number }
  | { ok: false; message: string } {
  let working = session;
  let added = 0;
  let alreadyThere = 0;
  for (const [index, draft] of drafts.entries()) {
    const result = applyClaim(
      working,
      {
        kind: "ingestExtracted",
        createdByType: "extraction",
        field: draft.field,
        statement: draft.statement,
        citation: draft.citation,
        effectiveDate: draft.effectiveDate,
        note: null,
      },
      systemWriteContext,
    );
    if (!result.ok) {
      return {
        ok: false,
        message: `Only ${index} of ${drafts.length} rules fit in this SOP, so none were added. Remove something or start a new chat.`,
      };
    }
    working = result.session;
    if (result.change === "created") added += 1;
    else alreadyThere += 1;
  }
  if (transportSize(working) > MAX_SESSION_TRANSPORT_BYTES) {
    return {
      ok: false,
      message:
        "Adding these rules would make the SOP too large to keep working on, so none were added.",
    };
  }
  return { ok: true, session: working, added, alreadyThere };
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
   * Reads a document and adds the rules in it to the SOP as claims to review. The API only reads
   * the file and proves each quote; the claims are written here through `applyClaim`. Refused
   * while a turn or another upload is in flight and after approval, because the rest of the page
   * builds on the session as it is now.
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
      const refusal = checkFileBeforeUpload(file);
      if (refusal !== null) {
        setUploadReport({ kind: "error", message: refusal });
        return;
      }

      const controller = new AbortController();
      activeUpload.current = controller;
      setIsUploading(true);
      setUploadReport(null);

      const result = await requestDocumentExtraction({
        apiBaseUrl: API_BASE_URL,
        file,
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
      if (response.claims.length === 0) {
        const dropped = response.rejected.count;
        setUploadReport({
          kind: "info",
          message:
            dropped === 0
              ? `No SOP rules were found in ${fileName}.`
              : `No rules from ${fileName} could be used: ${dropped} could not be verified against the text.`,
        });
        return;
      }

      // Nothing else can have changed the session while the upload was running.
      const latest = sessionRef.current;
      if (latest === null) return;
      const written = writeDrafts(latest, response.claims);
      if (!written.ok) {
        setUploadReport({ kind: "error", message: written.message });
        return;
      }
      const conflictsBefore = latest.claims.filter((claim) => claim.status === "conflict").length;
      const conflictsAfter = written.session.claims.filter(
        (claim) => claim.status === "conflict",
      ).length;
      replaceSession(written.session);
      setError(saveSession(written.session) ? null : STORAGE_FAILURE_MESSAGE);

      const parts = [
        `Read ${fileName}: ${written.added} ${plural(written.added, "rule", "rules")} to review.`,
      ];
      if (written.alreadyThere > 0)
        parts.push(`${written.alreadyThere} already there or rejected earlier.`);
      const repeated = response.rejected.reasons.duplicate ?? 0;
      const unverified = response.rejected.count - repeated;
      if (unverified > 0) {
        parts.push(
          `${unverified} ${plural(unverified, "rule was", "rules were")} dropped because ${plural(unverified, "it", "they")} could not be verified against the text.`,
        );
      }
      if (repeated > 0) {
        parts.push(`${repeated} repeated ${plural(repeated, "rule was", "rules were")} dropped.`);
      }
      if (response.truncatedCount > 0) {
        parts.push(
          `${response.truncatedCount} more ${plural(response.truncatedCount, "rule was", "rules were")} left out because one document can add at most ${MAX_EXTRACTED_CLAIMS_PER_DOCUMENT}.`,
        );
      }
      const newConflicts = (conflictsAfter - conflictsBefore) / 2;
      if (newConflicts > 0) {
        parts.push(
          `${newConflicts} ${plural(newConflicts, "conflict", "conflicts")} found: tell the assistant the final answer in chat.`,
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
    downloadPdf,
    isDownloading,
    downloadError,
    uploadDocument,
    isUploading,
    uploadReport,
  };
}
