/** Builds a `multipart/form-data` body, so a test can send an upload through `app.inject`. */
export interface MultipartPart {
  name: string;
  /** Present for a file part. */
  fileName?: string;
  contentType?: string;
  data: Buffer | string;
}

export function buildMultipartBody(parts: MultipartPart[]): {
  payload: Buffer;
  contentType: string;
} {
  const boundary = "----sop-agent-test-boundary";
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition =
      part.fileName === undefined
        ? `form-data; name="${part.name}"`
        : `form-data; name="${part.name}"; filename="${part.fileName}"`;
    const fileHeader =
      part.fileName === undefined
        ? ""
        : `Content-Type: ${part.contentType ?? "application/octet-stream"}\r\n`;
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: ${disposition}\r\n${fileHeader}\r\n`),
      Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data),
      Buffer.from("\r\n"),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}
