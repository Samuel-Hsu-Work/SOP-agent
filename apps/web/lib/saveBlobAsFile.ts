/**
 * Hands a file to the browser's download. The name comes from the caller because the API is on
 * another origin, so its `content-disposition` header is not readable here (and a blob URL ignores
 * it anyway). Throws if the browser could not start the download: the caller must not record a
 * download that never began.
 *
 * The browser cannot tell whether the person saved the file, only that the download started.
 */
export function saveBlobAsFile(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    try {
      anchor.click();
    } finally {
      anchor.remove();
    }
  } finally {
    // One task later, not at once: some browsers read the blob only after the click has returned,
    // and revoking the URL first would cancel the download.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
