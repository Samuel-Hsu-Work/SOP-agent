"use client";

import { useRef, useState } from "react";
import { wouldLoseWork } from "../lib/unsavedWork.ts";
import { useLeavePageWarning } from "../lib/useLeavePageWarning.ts";
import { useSopSession } from "../lib/useSopSession.ts";
import { ApprovalPanel } from "./ApprovalPanel.tsx";
import { ChatPanel } from "./ChatPanel.tsx";
import { ReadinessPanel } from "./ReadinessPanel.tsx";
import { SopPreview } from "./SopPreview.tsx";

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
    downloadPdf,
    isDownloading,
    downloadError,
  } = useSopSession();
  useLeavePageWarning(session !== null && wouldLoseWork(session, isSending));
  const [sideView, setSideView] = useState<SideView>("review");
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  function describeChangeInChat() {
    composerRef.current?.focus();
    composerRef.current?.scrollIntoView({ block: "center" });
  }

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
                  <ReadinessPanel
                    session={session}
                    isBusy={isSending}
                    onConfirm={confirmClaim}
                    onReject={rejectClaim}
                    onDescribeChange={describeChangeInChat}
                  />
                  <ApprovalPanel
                    session={session}
                    isBusy={isSending}
                    onAcknowledge={setAcknowledged}
                    onApprove={approve}
                    isDownloading={isDownloading}
                    downloadError={downloadError}
                    onDownload={downloadPdf}
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
