"use client";

import { hasSopTarget } from "@sop-agent/sop-core";
import { useEffect, useRef, useState } from "react";
import { buildReferenceView } from "../lib/referenceView.ts";
import { wouldLoseWork } from "../lib/unsavedWork.ts";
import { useLeavePageWarning } from "../lib/useLeavePageWarning.ts";
import { useSopSession } from "../lib/useSopSession.ts";
import { ApprovalPanel } from "./ApprovalPanel.tsx";
import { ChatPanel } from "./ChatPanel.tsx";
import { ReadinessPanel } from "./ReadinessPanel.tsx";
import { SopPreview } from "./SopPreview.tsx";
import { UploadPanel } from "./UploadPanel.tsx";

type SideView = "review" | "preview";

export function SopWorkspace() {
  const {
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
  } = useSopSession();
  useLeavePageWarning(session !== null && wouldLoseWork(session, isSending));
  const [sideView, setSideView] = useState<SideView>("review");
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const focusComposerOnUnlock = useRef(false);

  /** Moves the cursor to the chat, where the user gives the final answer to resolve a conflict. */
  function answerInChat() {
    composerRef.current?.focus();
    composerRef.current?.scrollIntoView({ block: "center" });
  }

  function reopenForEditing() {
    if (reopen()) focusComposerOnUnlock.current = true;
  }

  // The composer is disabled at the moment reopen() returns (React has not yet re-rendered it as
  // enabled), so focusing it there would be a no-op. This runs after the render that enables it.
  useEffect(() => {
    if (!focusComposerOnUnlock.current || session?.status !== "draft") return;
    focusComposerOnUnlock.current = false;
    composerRef.current?.focus();
    composerRef.current?.scrollIntoView({ block: "center" });
  }, [session]);

  return (
    <div className="workspace">
      <header className="topbar">
        <h1>SOP interview</h1>
        <button
          type="button"
          className="secondary"
          onClick={startNewChat}
          disabled={session === null}
        >
          New chat
        </button>
      </header>

      {session === null ? (
        <p className="loading">Loading…</p>
      ) : (
        <div className="columns">
          <ChatPanel
            session={session}
            pendingMessage={pendingMessage}
            streamingReply={streamingReply}
            isSending={isSending}
            isUploading={isUploading}
            error={error}
            notice={notice}
            onSend={sendMessage}
            composerRef={composerRef}
          />
          <div className="side">
            <div className="tabs" role="tablist" aria-label="Review or preview">
              <button
                type="button"
                role="tab"
                id="tab-review"
                aria-selected={sideView === "review"}
                aria-controls="side-panel"
                className={sideView === "review" ? "tab tab-active" : "tab"}
                onClick={() => setSideView("review")}
              >
                Review
              </button>
              <button
                type="button"
                role="tab"
                id="tab-preview"
                aria-selected={sideView === "preview"}
                aria-controls="side-panel"
                className={sideView === "preview" ? "tab tab-active" : "tab"}
                onClick={() => setSideView("preview")}
              >
                SOP preview
              </button>
            </div>
            <div
              id="side-panel"
              role="tabpanel"
              aria-labelledby={sideView === "review" ? "tab-review" : "tab-preview"}
              className="side-panel"
            >
              {sideView === "review" ? (
                <>
                  {session.status === "approved" ? null : (
                    <UploadPanel
                      isDisabled={isSending}
                      isUploading={isUploading}
                      hasTarget={hasSopTarget(session)}
                      report={uploadReport}
                      documents={buildReferenceView(session)}
                      onUpload={uploadDocument}
                    />
                  )}
                  <ReadinessPanel
                    session={session}
                    isBusy={isSending || isUploading}
                    onConfirm={confirmClaim}
                    onReject={rejectClaim}
                    onAnswerInChat={answerInChat}
                  />
                  <ApprovalPanel
                    session={session}
                    isBusy={isSending || isUploading}
                    onAcknowledge={setAcknowledged}
                    onApprove={approve}
                    isDownloading={isDownloading}
                    downloadError={downloadError}
                    onDownload={downloadPdf}
                    onReopen={reopenForEditing}
                  />
                </>
              ) : (
                <SopPreview session={session} />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
