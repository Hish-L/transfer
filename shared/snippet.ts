// A text snippet rides the same optical container a file does — it is just
// UTF-8 bytes with a media type the receiver recognises. Nothing is stored on
// either device, and nothing is encrypted: whatever is on the screen is
// readable by any camera pointed at it. The only property here is that no
// network sits between the two devices.

import { packFile, type OpticalFile, type PackedOpticalFile } from "./protocol";

export const SNIPPET_MEDIA_TYPE = "application/vnd.qrtransfer.snippet";
export const SNIPPET_FILE_NAME = "snippet.txt";
// Text uses the same container and fountain pipeline as a file, so the only
// hard ceiling is MAX_FILE_BYTES. This lower cap is a UX one: a <textarea>
// holding tens of megabytes bogs down on paste and re-render.
export const MAX_SNIPPET_BYTES = 4 * 1024 * 1024;
export const MAX_SNIPPET_LABEL = `${MAX_SNIPPET_BYTES / 1024 / 1024} MB`;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function isSnippet(file: OpticalFile): boolean {
  return file.type === SNIPPET_MEDIA_TYPE;
}

export async function packSnippet(text: string): Promise<PackedOpticalFile> {
  if (text.trim().length === 0) throw new Error("Paste or type some text before sending.");
  const bytes = encoder.encode(text);
  if (bytes.length > MAX_SNIPPET_BYTES) {
    throw new Error(`Text snippets are limited to ${MAX_SNIPPET_LABEL}.`);
  }
  return packFile(SNIPPET_FILE_NAME, SNIPPET_MEDIA_TYPE, bytes);
}

/** Decode an already-unpacked, already-verified snippet container. */
export function snippetText(file: OpticalFile): string {
  if (!isSnippet(file)) throw new Error("This stream is not a text snippet.");
  try {
    return decoder.decode(file.bytes);
  } catch {
    throw new Error("The recovered snippet is not valid UTF-8.");
  }
}
