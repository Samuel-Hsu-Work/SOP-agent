"use client";

import type { SopSession } from "@sop-agent/sop-core";
import { useCallback, useEffect, useRef, useState } from "react";
import { runChatTurn } from "./chatTurn.ts";
import { loadSession, saveSession, startFreshSession } from "./sessionStore.ts";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

const STORAGE_FAILURE_MESSAGE =
  "Your browser could not store this session. It will be lost if you refresh the page.";

/**
 * What became of a send. Only `failed` puts the user's words back in the box: a turn that was
 * cancelled (New chat, leaving the page) is not a failure, and its text must not reappear.
 */
export interface SendResult {
  outcome: "committed" | "failed" | "cancelled";
}

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
  const activeTurn = useRef<AbortController | null>(null);

  useEffect(() => {
    const loaded = loadSession();
    if (loaded.status === "loaded") {
      setSession(loaded.session);
      return;
    }
    const fresh = startFreshSession();
    setSession(fresh.session);
    if (!fresh.stored) setError(STORAGE_FAILURE_MESSAGE);
    if (loaded.status === "invalid") {
      setNotice("The previous session could not be restored, so a new chat was started.");
    }
  }, []);

  useEffect(() => () => activeTurn.current?.abort(), []);

  const sendMessage = useCallback(
    async (message: string): Promise<SendResult> => {
      if (session === null || isSending) return { outcome: "cancelled" };

      const controller = new AbortController();
      activeTurn.current = controller;
      setIsSending(true);
      setError(null);
      setNotice(null);
      setPendingMessage(message);
      setStreamingReply("");

      const result = await runChatTurn({
        apiBaseUrl: API_BASE_URL,
        session,
        message,
        signal: controller.signal,
        onTextDelta: (text) => setStreamingReply((current) => current + text),
        onReset: () => setStreamingReply(""),
      });

      // A new chat, or leaving the page, cancelled this turn: leave the state alone.
      if (controller.signal.aborted) return { outcome: "cancelled" };

      activeTurn.current = null;
      setIsSending(false);
      setPendingMessage(null);
      setStreamingReply("");

      if (result.kind === "failed") {
        setError(result.message);
        return { outcome: "failed" };
      }
      setSession(result.session);
      if (!saveSession(result.session)) setError(STORAGE_FAILURE_MESSAGE);
      return { outcome: "committed" };
    },
    [session, isSending],
  );

  /** One click, no confirmation: cancel any turn in flight and start from an empty session. */
  const startNewChat = useCallback(() => {
    activeTurn.current?.abort();
    activeTurn.current = null;
    setIsSending(false);
    setPendingMessage(null);
    setStreamingReply("");
    setNotice(null);
    const fresh = startFreshSession();
    setSession(fresh.session);
    setError(fresh.stored ? null : STORAGE_FAILURE_MESSAGE);
  }, []);

  return {
    session,
    notice,
    error,
    pendingMessage,
    streamingReply,
    isSending,
    sendMessage,
    startNewChat,
  };
}
