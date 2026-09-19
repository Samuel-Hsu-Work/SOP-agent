"use client";

import { useSopSession } from "../lib/useSopSession.ts";
import { ChatPanel } from "./ChatPanel.tsx";
import { ReadinessPanel } from "./ReadinessPanel.tsx";

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
  } = useSopSession();

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
          />
          <ReadinessPanel session={session} />
        </div>
      )}
    </div>
  );
}
