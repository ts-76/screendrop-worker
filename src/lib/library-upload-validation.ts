import {
  LIBRARY_IMAGE_TYPES,
  MAX_LIBRARY_UPLOAD_BYTES,
} from "@/lib/library-upload-config";

type UploadMetadata = {
  filename: string;
  contentType: string;
  advertisedSize: number;
  tagId: string;
  collectionId: string;
};

type ValidationResult =
  | { ok: true; value: UploadMetadata }
  | { ok: false; error: string; status: number };

const IMAGE_TYPES = new Set<string>(LIBRARY_IMAGE_TYPES);
const ID_PATTERN = /^[a-z0-9-]{8,40}$/;

function rejected(error: string, status: number): ValidationResult {
  return { ok: false, error, status };
}

function decodedFilename(header: string | null): string | null {
  if (!header) return null;
  try {
    const name = decodeURIComponent(header).trim();
    if (
      !name ||
      name.length > 255 ||
      new TextEncoder().encode(name).byteLength > 255 ||
      /[\\/]/.test(name) ||
      [...name].some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      return null;
    return name;
  } catch {
    return null;
  }
}

export function validateLibraryUploadHeaders(
  headers: Headers,
): ValidationResult {
  const filename = decodedFilename(headers.get("x-filename"));
  const contentType = headers.get("content-type")?.toLowerCase() ?? "";
  const advertisedSize = Number(headers.get("x-upload-size"));
  const tagId = headers.get("x-tag-id") ?? "";
  const collectionId = headers.get("x-collection-id") ?? "";
  if (!filename) return rejected("Invalid filename", 400);
  if (!IMAGE_TYPES.has(contentType))
    return rejected("Unsupported image type", 415);
  if (!Number.isSafeInteger(advertisedSize) || advertisedSize <= 0) {
    return rejected("Invalid image size", 400);
  }
  if (advertisedSize > MAX_LIBRARY_UPLOAD_BYTES) {
    return rejected("Image exceeds the 90 MB upload limit", 413);
  }
  const contentLength = headers.get("content-length");
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength !== advertisedSize
    ) {
      return rejected("Image size did not match the request", 400);
    }
  }
  if (
    (tagId && !ID_PATTERN.test(tagId)) ||
    (collectionId && !ID_PATTERN.test(collectionId))
  ) {
    return rejected("Invalid tag or collection", 400);
  }
  return {
    ok: true,
    value: { filename, contentType, advertisedSize, tagId, collectionId },
  };
}
