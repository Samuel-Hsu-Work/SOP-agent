"use client";

import type { SopSession } from "@sop-agent/sop-core";
import {
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import type { SendResult } from "../lib/useSopSession.ts";

export interface ChatPanelProps {
  session: SopSession;
  pendingMessage: string | null;
  streamingReply: string;
  isSending: boolean;
  error: string | null;
  notice: string | null;
  onSend: (message: string) => Promise<SendResult>;
  /** Lets the page move the cursor here, for "Describe a change in chat". */
  composerRef?: RefObject<HTMLTextAreaElement | null>;
}

export function ChatPanel(props: ChatPanelProps) {
  const { session, pendingMessage, streamingReply, isSending, error, notice, onSend, composerRef } =
    props;
  const [draft, setDraft] = useState("");
  const endOfTranscript = useRef<HTMLDivElement | null>(null);
  const isReadOnly = session.status === "approved";

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll whenever the transcript grows
  useEffect(() => {
    endOfTranscript.current?.scrollIntoView({ block: "end" });
  }, [session.messages.length, pendingMessage, streamingReply]);

  async function submit() {
    const message = draft.trim();
    if (message.length === 0 || isSending || isReadOnly) return;
    setDraft("");
    const result = await onSend(message);
    // A failed turn changes nothing, so the user's words go back into the box. A cancelled one
    // (New chat) does not: the words belonged to a chat that is gone.
    if (result.outcome === "failed")
      setDraft((current) => (current.length === 0 ? message : current));
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void submit();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }

  const isEmpty = session.messages.length === 0 && pendingMessage === null;

  return (
    <section className="panel chat" aria-labelledby="chat-heading">
      <header className="panel-header">
        <h2 id="chat-heading">Interview</h2>
      </header>

      <div className="transcript" aria-live="polite" aria-busy={isSending}>
        {isEmpty ? (
          <p className="empty-state">
            Describe a process in your organization, for example how customer refunds are handled. I
            will ask questions and record what you tell me.
          </p>
        ) : null}
        {session.messages.map((message) => (
          <div key={message.id} className={`bubble bubble-${message.role}`}>
            {message.text}
          </div>
        ))}
        {pendingMessage !== null ? (
          <div className="bubble bubble-user">{pendingMessage}</div>
        ) : null}
        {isSending ? (
          <div className="bubble bubble-assistant">
            {streamingReply.length > 0 ? streamingReply : "Thinking…"}
          </div>
        ) : null}
        <div ref={endOfTranscript} />
      </div>

      {notice !== null ? <p className="banner banner-notice">{notice}</p> : null}
      {error !== null ? (
        <p className="banner banner-error" role="alert">
          {error}
        </p>
      ) : null}
      {isReadOnly ? (
        <p className="banner banner-notice">The SOP is approved, so the chat is read-only.</p>
      ) : null}

      <form className="composer" onSubmit={handleSubmit}>
        <label className="visually-hidden" htmlFor="message-box">
          Your message
        </label>
        <textarea
          ref={composerRef}
          id="message-box"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type your answer. Shift+Enter starts a new line."
          rows={3}
          disabled={isSending || isReadOnly}
        />
        <button type="submit" disabled={isSending || isReadOnly || draft.trim().length === 0}>
          {isSending ? "Sending…" : "Send"}
        </button>
      </form>
    </section>
  );
}
