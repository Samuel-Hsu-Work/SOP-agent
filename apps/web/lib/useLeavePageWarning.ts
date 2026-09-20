"use client";

import { useEffect } from "react";

/**
 * Asks the browser to confirm before the tab is closed or reloaded, only while `shouldWarn` is
 * true. Browsers show their own generic wording and ignore custom text, so the explanation lives
 * on the page. New chat happens inside the page and never triggers this: it stays one click.
 */
export function useLeavePageWarning(shouldWarn: boolean): void {
  useEffect(() => {
    if (!shouldWarn) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Some browsers still need a value here to show the prompt.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [shouldWarn]);
}
