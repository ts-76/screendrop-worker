import { useCallback, useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  ArrowSquareOut,
  FolderSimple,
  Images,
  UploadSimple,
  X,
} from "@phosphor-icons/react";
import {
  LIBRARY_IMAGE_TYPES,
  MAX_LIBRARY_UPLOAD_BYTES,
} from "@/lib/library-upload-config";

type NamedItem = { id: string; name: string; count: number };
type AssignedItem = Pick<NamedItem, "id" | "name">;
type Capture = {
  id: string;
  filename: string;
  title: string | null;
  contentType: string;
  mediaType: string;
  size: number;
  createdAt: string;
  posterKey: string | null;
  tags: Array<AssignedItem>;
  collections: Array<AssignedItem>;
};
type Metadata = { tags: Array<NamedItem>; collections: Array<NamedItem> };
type CapturePage = { captures: Array<Capture>; nextCursor: string | null };
type Kind = "tags" | "collections";
type MobilePanel = "browse" | "details" | null;
const IMAGE_TYPES = new Set<string>(LIBRARY_IMAGE_TYPES);

export const Route = createFileRoute("/library")({
  head: () => ({
    meta: [
      { title: "Library — Screendrop" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: LibraryPage,
});

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "string"
        ? body.error
        : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return body as T;
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function displayDate(value: string): string {
  const date = new Date(
    value.endsWith("Z") || value.includes("+")
      ? value
      : `${value.replace(" ", "T")}Z`,
  );
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}

function LibraryPage() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [token, setToken] = useState("");
  const [metadata, setMetadata] = useState<Metadata>({
    tags: [],
    collections: [],
  });
  const [captures, setCaptures] = useState<Array<Capture>>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [mediaType, setMediaType] = useState("all");
  const [tagId, setTagId] = useState("");
  const [collectionId, setCollectionId] = useState("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uploadStatus, setUploadStatus] = useState("");
  const [uploadNotice, setUploadNotice] = useState("");
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>(null);
  const [mobileKind, setMobileKind] = useState<Kind>("collections");
  const [assignmentKind, setAssignmentKind] = useState<Kind>("collections");
  const [compactLayout, setCompactLayout] = useState(false);
  const captureRequest = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const browseDialog = useRef<HTMLDialogElement>(null);
  const detailsDialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1279px)");
    const update = () => setCompactLayout(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const dialogs = [
      {
        element: browseDialog.current,
        open: compactLayout && mobilePanel === "browse",
      },
      {
        element: detailsDialog.current,
        open: compactLayout && mobilePanel === "details" && selectedId !== null,
      },
    ];
    for (const { element, open } of dialogs) {
      if (!element) continue;
      if (open && !element.open) element.showModal();
      if (!open && element.open) element.close();
    }
  }, [compactLayout, mobilePanel, selectedId]);

  useEffect(() => {
    let mounted = true;
    api<{ authenticated: boolean }>("/api/library/session")
      .then((result) => {
        if (mounted) setAuthenticated(result.authenticated);
      })
      .catch(() => {
        if (mounted) {
          setAuthenticated(false);
          setError("Could not check your session.");
        }
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(query), 250);
    return () => window.clearTimeout(timeout);
  }, [query]);

  const refreshMetadata = useCallback(async () => {
    setMetadata(await api<Metadata>("/api/library/metadata"));
  }, []);

  const loadCaptures = useCallback(
    async (cursor?: string) => {
      const requestId = ++captureRequest.current;
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (debouncedQuery) params.set("q", debouncedQuery);
        if (mediaType !== "all") params.set("type", mediaType);
        if (tagId) params.set("tag", tagId);
        if (collectionId) params.set("collection", collectionId);
        if (cursor) params.set("cursor", cursor);
        const result = await api<CapturePage>(
          `/api/library/captures?${params}`,
        );
        if (requestId !== captureRequest.current) return;
        setCaptures((old) =>
          cursor ? [...old, ...result.captures] : result.captures,
        );
        setNextCursor(result.nextCursor);
      } catch (cause) {
        if (requestId === captureRequest.current) {
          setError(
            cause instanceof Error ? cause.message : "Could not load captures.",
          );
        }
      } finally {
        if (requestId === captureRequest.current) setLoading(false);
      }
    },
    [debouncedQuery, mediaType, tagId, collectionId],
  );

  useEffect(() => {
    if (!authenticated) return;
    void refreshMetadata().catch(() =>
      setError("Could not load tags and collections."),
    );
  }, [authenticated, refreshMetadata]);

  useEffect(() => {
    if (!authenticated) return;
    setCaptures([]);
    setSelectedId(null);
    void loadCaptures();
  }, [authenticated, loadCaptures, refreshRevision]);

  async function login(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/library/session", jsonRequest("POST", { token }));
      setToken("");
      setAuthenticated(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign in failed.");
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    setBusy(true);
    try {
      await api("/api/library/session", { method: "DELETE" });
      setAuthenticated(false);
      setCaptures([]);
      setMetadata({ tags: [], collections: [] });
      setSelectedId(null);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign out failed.");
    } finally {
      setBusy(false);
    }
  }

  async function createItem(kind: Kind, name: string) {
    setBusy(true);
    setError("");
    try {
      await api(`/api/library/${kind}`, jsonRequest("POST", { name }));
      await refreshMetadata();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not create item.",
      );
      throw cause;
    } finally {
      setBusy(false);
    }
  }

  async function editItem(kind: Kind, item: NamedItem) {
    const name = window.prompt(
      `Rename ${kind === "tags" ? "tag" : "collection"}`,
      item.name,
    );
    if (name === null || name.trim() === item.name) return;
    setBusy(true);
    setError("");
    try {
      await api(
        `/api/library/${kind}/${item.id}`,
        jsonRequest("PATCH", { name }),
      );
      setCaptures((old) =>
        old.map((capture) => ({
          ...capture,
          [kind]: capture[kind].map((assigned) =>
            assigned.id === item.id
              ? { ...assigned, name: name.trim() }
              : assigned,
          ),
        })),
      );
      await refreshMetadata();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not rename item.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function deleteItem(kind: Kind, item: NamedItem) {
    if (
      !window.confirm(`Delete “${item.name}”? Captures will remain available.`)
    )
      return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/library/${kind}/${item.id}`, { method: "DELETE" });
      setCaptures((old) =>
        old.map((capture) => ({
          ...capture,
          [kind]: capture[kind].filter((assigned) => assigned.id !== item.id),
        })),
      );
      if (kind === "tags" && tagId === item.id) setTagId("");
      if (kind === "collections" && collectionId === item.id)
        setCollectionId("");
      await refreshMetadata();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not delete item.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function toggleAssignment(
    capture: Capture,
    kind: Kind,
    item: NamedItem,
  ) {
    const current = capture[kind];
    const nextIds = current.some((assigned) => assigned.id === item.id)
      ? current
          .filter((assigned) => assigned.id !== item.id)
          .map((assigned) => assigned.id)
      : [...current.map((assigned) => assigned.id), item.id];
    setBusy(true);
    setError("");
    try {
      await api(
        `/api/library/captures/${capture.id}/${kind}`,
        jsonRequest("PUT", { ids: nextIds }),
      );
      const next = nextIds.map((id) => {
        const assigned = metadata[kind].find(
          (candidate) => candidate.id === id,
        );
        return {
          id,
          name:
            assigned?.name ??
            current.find((candidate) => candidate.id === id)?.name ??
            "",
        };
      });
      const removesActiveFilter =
        (kind === "tags" && tagId && !nextIds.includes(tagId)) ||
        (kind === "collections" &&
          collectionId &&
          !nextIds.includes(collectionId));
      setCaptures((old) =>
        old
          .filter(
            (itemInList) =>
              itemInList.id !== capture.id || !removesActiveFilter,
          )
          .map((itemInList) =>
            itemInList.id === capture.id
              ? { ...itemInList, [kind]: next }
              : itemInList,
          ),
      );
      if (removesActiveFilter) setSelectedId(null);
      await refreshMetadata();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not update capture.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function uploadImages(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) return;
    setError("");
    setUploadNotice("");
    if (files.length > 10) {
      setError("Choose at most 10 images at a time.");
      return;
    }
    const invalid = files.find(
      (file) =>
        !IMAGE_TYPES.has(file.type) ||
        file.size === 0 ||
        file.size > MAX_LIBRARY_UPLOAD_BYTES,
    );
    if (invalid) {
      setError(
        `“${invalid.name}” must be a PNG, JPEG, WebP, GIF, or AVIF image no larger than 90 MB.`,
      );
      return;
    }

    setBusy(true);
    let uploaded = 0;
    try {
      for (const [index, file] of files.entries()) {
        setUploadStatus(
          `Uploading ${index + 1} of ${files.length}: ${file.name}`,
        );
        const headers: Record<string, string> = {
          "content-type": file.type,
          "x-filename": encodeURIComponent(file.name),
          "x-upload-size": String(file.size),
        };
        if (tagId) headers["x-tag-id"] = tagId;
        if (collectionId) headers["x-collection-id"] = collectionId;
        await api("/api/library/upload", {
          method: "PUT",
          headers,
          body: file,
        });
        uploaded += 1;
      }
      setUploadNotice(
        `${uploaded} ${uploaded === 1 ? "image" : "images"} uploaded. Anyone with a share link can view them.`,
      );
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : "Upload failed.";
      setError(
        uploaded
          ? `${uploaded} image(s) uploaded before the next upload failed: ${reason}`
          : reason,
      );
    } finally {
      setUploadStatus("");
      if (uploaded > 0) {
        await refreshMetadata().catch(() =>
          setError(
            "Images uploaded, but the tags and collections could not be refreshed.",
          ),
        );
        setQuery("");
        setMediaType("all");
        setRefreshRevision((value) => value + 1);
      }
      setBusy(false);
    }
  }

  const selected =
    captures.find((capture) => capture.id === selectedId) ?? null;

  if (authenticated === null) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-neutral-50 text-neutral-600">
        Loading library…
      </main>
    );
  }

  if (!authenticated) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-neutral-50 px-5 text-neutral-900">
        <div className="w-full max-w-sm rounded-3xl border border-neutral-200 bg-white p-8 shadow-sm">
          <a
            href="/"
            className="text-sm font-medium text-neutral-500 hover:text-neutral-900"
          >
            Screendrop Cloud
          </a>
          <h1 className="mt-8 text-3xl font-semibold tracking-tight">
            Your cloud library
          </h1>
          <p className="mt-2 text-sm leading-6 text-neutral-600">
            Enter the upload token from Screendrop Settings → Cloud to organize
            your captures.
          </p>
          <form onSubmit={login} className="mt-7 space-y-4">
            <label
              className="block text-sm font-medium"
              htmlFor="library-token"
            >
              Upload token
            </label>
            <input
              id="library-token"
              type="password"
              autoComplete="off"
              required
              value={token}
              onChange={(event) => setToken(event.target.value)}
              className="w-full rounded-xl border border-neutral-300 bg-white px-4 py-3 outline-none focus:border-neutral-900"
            />
            <button
              disabled={busy}
              className="w-full rounded-xl bg-neutral-900 px-4 py-3 font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
            >
              {busy ? "Signing in…" : "Open library"}
            </button>
          </form>
          {error && (
            <p role="alert" className="mt-4 text-sm text-red-700">
              {error}
            </p>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-[#f8f8f6] text-neutral-900">
      <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-3 sm:px-5 md:px-8 md:py-4">
        <div>
          <a
            href="/"
            className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500"
          >
            Screendrop Cloud
          </a>
          <h1 className="mt-0.5 text-xl font-semibold tracking-tight md:mt-1 md:text-2xl">
            Library
          </h1>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void logout()}
          className="min-h-11 rounded-lg border border-neutral-300 px-3 text-sm hover:bg-neutral-100 disabled:opacity-50 md:px-4"
        >
          Sign out
        </button>
      </header>

      <div className="mx-auto grid max-w-[1600px] gap-6 px-3 pb-28 pt-3 sm:px-5 lg:grid-cols-[220px_minmax(0,1fr)] lg:p-8">
        <aside className="hidden space-y-7 lg:block">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">
              Browse
            </p>
            <button
              type="button"
              onClick={() => {
                setCollectionId("");
                setTagId("");
              }}
              className={`w-full rounded-lg px-3 py-2 text-left text-sm ${!collectionId && !tagId ? "bg-neutral-900 text-white" : "hover:bg-white"}`}
            >
              All captures
            </button>
          </div>
          <ClassificationSection
            title="Collections"
            kind="collections"
            items={metadata.collections}
            activeId={collectionId}
            disabled={busy}
            onSelect={(id) => {
              setCollectionId(id);
              setTagId("");
            }}
            onCreate={createItem}
            onEdit={editItem}
            onDelete={deleteItem}
          />
          <ClassificationSection
            title="Tags"
            kind="tags"
            items={metadata.tags}
            activeId={tagId}
            disabled={busy}
            onSelect={(id) => {
              setTagId(id);
              setCollectionId("");
            }}
            onCreate={createItem}
            onEdit={editItem}
            onDelete={deleteItem}
          />
        </aside>

        <section className="min-w-0">
          <div className="flex items-center gap-2 rounded-2xl border border-neutral-200 bg-white p-2 sm:gap-3 sm:p-4">
            <label className="min-w-0 flex-1">
              <span className="sr-only">Search captures</span>
              <input
                type="search"
                placeholder="Search captures…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="min-h-11 w-full rounded-lg border border-neutral-300 px-3 text-sm outline-none focus:border-neutral-900"
              />
            </label>
            <label className="shrink-0">
              <span className="sr-only">Media type</span>
              <select
                value={mediaType}
                onChange={(event) => setMediaType(event.target.value)}
                className="min-h-11 max-w-28 rounded-lg border border-neutral-300 bg-white px-2 text-sm sm:max-w-none sm:px-3"
              >
                <option value="all">All media</option>
                <option value="image">Images</option>
                <option value="video">Recordings</option>
              </select>
            </label>
            <input
              ref={fileInput}
              type="file"
              accept={LIBRARY_IMAGE_TYPES.join(",")}
              multiple
              disabled={busy}
              onChange={(event) => void uploadImages(event)}
              className="sr-only"
              aria-label="Choose images to upload"
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
              className="hidden min-h-11 rounded-lg bg-neutral-900 px-4 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50 lg:block"
            >
              Upload images
            </button>
          </div>
          <p className="mt-2 hidden text-xs text-neutral-500 sm:block">
            PNG, JPEG, WebP, GIF, or AVIF · up to 90 MB each.{" "}
            {tagId || collectionId
              ? "New uploads are shareable by link and added to the selected tag or collection."
              : "New uploads are shareable by link."}
          </p>
          {uploadStatus && (
            <p
              role="status"
              className="mt-3 hidden text-sm text-neutral-600 lg:block"
            >
              {uploadStatus}
            </p>
          )}
          {uploadNotice && (
            <p
              role="status"
              className="mt-3 hidden rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 lg:block"
            >
              {uploadNotice}
            </p>
          )}
          {error && (
            <div
              role="alert"
              className="mt-4 hidden rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 lg:block"
            >
              {error}
              <button
                type="button"
                onClick={() => setError("")}
                className="ml-3 underline"
              >
                Dismiss
              </button>
            </div>
          )}

          <div
            className={`mt-5 grid gap-6 ${selected ? "xl:grid-cols-[minmax(0,1fr)_300px]" : ""}`}
          >
            <div>
              {captures.length === 0 && !loading ? (
                <div className="rounded-2xl border border-dashed border-neutral-300 bg-white px-6 py-20 text-center">
                  <p className="text-lg font-medium">No captures found</p>
                  <p className="mt-2 text-sm text-neutral-500">
                    Upload images here or from Screendrop, or adjust your
                    filters.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2 sm:gap-4 xl:grid-cols-3 2xl:grid-cols-4">
                  {captures.map((capture) => (
                    <article
                      key={capture.id}
                      className={`min-w-0 overflow-hidden rounded-2xl border bg-white shadow-sm ${selectedId === capture.id ? "border-neutral-900 ring-1 ring-neutral-900" : "border-neutral-200"}`}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedId(capture.id);
                          if (compactLayout) setMobilePanel("details");
                        }}
                        aria-label={`Organize ${capture.title || capture.filename}`}
                        aria-pressed={selectedId === capture.id}
                        className="block w-full text-left outline-offset-[-3px] transition hover:opacity-90 focus-visible:outline-2 focus-visible:outline-neutral-900"
                      >
                        <div className="flex aspect-[4/3] items-center justify-center overflow-hidden bg-neutral-100">
                          {capture.mediaType === "image" ? (
                            <img
                              src={`/api/image/${capture.id}`}
                              alt=""
                              loading="lazy"
                              className="h-full w-full object-cover"
                            />
                          ) : capture.posterKey ? (
                            <img
                              src={`/api/poster/${capture.id}`}
                              alt=""
                              loading="lazy"
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <span className="text-sm text-neutral-400">
                              Recording
                            </span>
                          )}
                        </div>
                        <div className="px-3 pb-2 pt-3 sm:p-4">
                          <p className="truncate text-sm font-semibold">
                            {capture.title || capture.filename}
                          </p>
                          <p className="mt-1 text-xs text-neutral-500">
                            {displayDate(capture.createdAt)} ·{" "}
                            {capture.mediaType === "video"
                              ? "Recording"
                              : "Image"}
                          </p>
                          {(capture.tags.length > 0 ||
                            capture.collections.length > 0) && (
                            <p className="mt-3 truncate text-xs text-neutral-600">
                              {[...capture.collections, ...capture.tags]
                                .map((item) => item.name)
                                .join(" · ")}
                            </p>
                          )}
                        </div>
                      </button>
                      <a
                        href={`/${capture.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Open share page for ${capture.title || capture.filename}`}
                        className="flex min-h-11 items-center justify-between border-t border-neutral-100 px-3 text-xs font-medium text-neutral-700 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-neutral-900 xl:hidden"
                      >
                        Share page{" "}
                        <ArrowSquareOut size={16} aria-hidden="true" />
                      </a>
                    </article>
                  ))}
                </div>
              )}
              {loading && (
                <p className="py-8 text-center text-sm text-neutral-500">
                  Loading captures…
                </p>
              )}
              {nextCursor && !loading && (
                <div className="py-8 text-center">
                  <button
                    type="button"
                    onClick={() => void loadCaptures(nextCursor)}
                    className="rounded-lg border border-neutral-300 bg-white px-5 py-2 text-sm hover:bg-neutral-100"
                  >
                    Load more
                  </button>
                </div>
              )}
            </div>

            {selected && (
              <aside className="hidden self-start rounded-2xl border border-neutral-200 bg-white p-5 xl:sticky xl:top-5 xl:block">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
                      Selected capture
                    </p>
                    <h2 className="mt-2 break-words font-semibold">
                      {selected.title || selected.filename}
                    </h2>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedId(null)}
                    aria-label="Close details"
                    className="text-xl text-neutral-500 hover:text-neutral-900"
                  >
                    ×
                  </button>
                </div>
                <a
                  href={`/${selected.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-3 inline-block text-sm font-medium underline underline-offset-4"
                >
                  Open share page ↗
                </a>
                <AssignmentSection
                  title="Collections"
                  kind="collections"
                  items={metadata.collections}
                  assigned={selected.collections}
                  disabled={busy}
                  onToggle={(item) =>
                    void toggleAssignment(selected, "collections", item)
                  }
                />
                <AssignmentSection
                  title="Tags"
                  kind="tags"
                  items={metadata.tags}
                  assigned={selected.tags}
                  disabled={busy}
                  onToggle={(item) =>
                    void toggleAssignment(selected, "tags", item)
                  }
                />
              </aside>
            )}
          </div>
        </section>
      </div>

      <nav
        aria-label="Library actions"
        className="fixed inset-x-0 bottom-0 z-20 border-t border-neutral-200 bg-white px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2 shadow-[0_-8px_24px_-16px_rgba(0,0,0,0.25)] lg:hidden"
      >
        {(uploadStatus || uploadNotice || error) && (
          <div
            className={`mx-auto mb-2 flex max-w-lg items-start gap-3 rounded-xl px-3 py-2 text-sm ${error ? "bg-red-50 text-red-800" : uploadNotice ? "bg-green-50 text-green-800" : "bg-neutral-100 text-neutral-700"}`}
            role={error ? "alert" : "status"}
          >
            <p className="min-w-0 flex-1 break-words">
              {error || uploadStatus || uploadNotice}
            </p>
            {(error || uploadNotice) && (
              <button
                type="button"
                aria-label="Dismiss message"
                onClick={() => {
                  setError("");
                  setUploadNotice("");
                }}
                className="flex size-8 shrink-0 items-center justify-center rounded-lg"
              >
                <X size={16} aria-hidden="true" />
              </button>
            )}
          </div>
        )}
        <div className="mx-auto flex max-w-lg gap-2">
          <button
            type="button"
            onClick={() => setMobilePanel("browse")}
            className="flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl border border-neutral-300 text-sm font-medium hover:bg-neutral-50"
          >
            <FolderSimple size={20} aria-hidden="true" className="shrink-0" />
            <span className="min-w-0 truncate">
              {collectionId
                ? (metadata.collections.find((item) => item.id === collectionId)
                    ?.name ?? "Organize")
                : tagId
                  ? (metadata.tags.find((item) => item.id === tagId)?.name ??
                    "Organize")
                  : "Organize"}
            </span>
          </button>
          {selected && (
            <button
              type="button"
              onClick={() => setMobilePanel("details")}
              className="flex min-h-12 items-center justify-center gap-2 rounded-xl border border-neutral-300 px-3 text-sm font-medium hover:bg-neutral-50"
            >
              <Images size={20} aria-hidden="true" />
              Details
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
            className="flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-neutral-900 px-3 text-sm font-medium text-white disabled:opacity-50"
          >
            <UploadSimple size={20} aria-hidden="true" />
            {uploadStatus ? "Uploading…" : "Upload"}
          </button>
        </div>
      </nav>

      <dialog
        ref={browseDialog}
        onClose={() =>
          setMobilePanel((current) => (current === "browse" ? null : current))
        }
        className="m-0 h-dvh max-h-none w-screen max-w-none bg-white p-0 text-neutral-900 backdrop:bg-neutral-950/45 xl:hidden"
        aria-labelledby="browse-panel-title"
      >
        <div className="flex h-full flex-col">
          <div className="flex shrink-0 items-center justify-between border-b border-neutral-200 px-5 py-4">
            <h2 id="browse-panel-title" className="text-lg font-semibold">
              Organize library
            </h2>
            <button
              type="button"
              onClick={() => setMobilePanel(null)}
              aria-label="Close organize panel"
              className="flex size-11 items-center justify-center rounded-lg hover:bg-neutral-100"
            >
              <X size={20} aria-hidden="true" />
            </button>
          </div>
          <div className="shrink-0 px-5 pt-4">
            <button
              type="button"
              onClick={() => {
                setCollectionId("");
                setTagId("");
                setMobilePanel(null);
              }}
              className={`min-h-11 w-full rounded-lg px-3 text-left text-sm ${!collectionId && !tagId ? "bg-neutral-900 text-white" : "bg-neutral-100 hover:bg-neutral-200"}`}
            >
              All captures
            </button>
            <div
              className="mt-4 flex gap-2 border-b border-neutral-200"
              aria-label="Classification type"
            >
              {(["collections", "tags"] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={mobileKind === kind}
                  onClick={() => setMobileKind(kind)}
                  className={`min-h-11 flex-1 border-b-2 text-sm font-medium ${mobileKind === kind ? "border-neutral-900 text-neutral-900" : "border-transparent text-neutral-600"}`}
                >
                  {kind === "collections" ? "Collections" : "Tags"}
                </button>
              ))}
            </div>
          </div>
          {error && (
            <p
              role="alert"
              className="mx-5 mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800"
            >
              {error}
            </p>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-5">
            <ClassificationSection
              title={mobileKind === "collections" ? "Collections" : "Tags"}
              kind={mobileKind}
              items={metadata[mobileKind]}
              activeId={mobileKind === "collections" ? collectionId : tagId}
              disabled={busy}
              mobile
              onSelect={(id) => {
                setCollectionId(mobileKind === "collections" ? id : "");
                setTagId(mobileKind === "tags" ? id : "");
                setMobilePanel(null);
              }}
              onCreate={createItem}
              onEdit={editItem}
              onDelete={deleteItem}
            />
          </div>
        </div>
      </dialog>

      <dialog
        ref={detailsDialog}
        onClose={() =>
          setMobilePanel((current) => (current === "details" ? null : current))
        }
        className="m-0 h-dvh max-h-none w-screen max-w-none bg-white p-0 text-neutral-900 backdrop:bg-neutral-950/45 xl:hidden"
        aria-labelledby="capture-panel-title"
      >
        {selected && (
          <div className="flex h-full flex-col">
            <div className="shrink-0 border-b border-neutral-200 px-5 pb-4 pt-3">
              <div className="flex items-center justify-between gap-3">
                <h2
                  id="capture-panel-title"
                  className="min-w-0 truncate text-lg font-semibold"
                >
                  {selected.title || selected.filename}
                </h2>
                <button
                  type="button"
                  onClick={() => setMobilePanel(null)}
                  aria-label="Close capture details"
                  className="flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-neutral-100"
                >
                  <X size={20} aria-hidden="true" />
                </button>
              </div>
              <a
                href={`/${selected.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-neutral-900 px-4 text-sm font-medium text-white"
              >
                Open share page <ArrowSquareOut size={18} aria-hidden="true" />
              </a>
            </div>
            <div className="shrink-0 border-b border-neutral-200 px-5 pt-2">
              <div className="flex gap-2" aria-label="Capture organization">
                {(["collections", "tags"] as const).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    aria-pressed={assignmentKind === kind}
                    onClick={() => setAssignmentKind(kind)}
                    className={`min-h-11 flex-1 border-b-2 text-sm font-medium ${assignmentKind === kind ? "border-neutral-900" : "border-transparent text-neutral-600"}`}
                  >
                    {kind === "collections" ? "Collections" : "Tags"}
                    {selected[kind].length > 0
                      ? ` (${selected[kind].length})`
                      : ""}
                  </button>
                ))}
              </div>
            </div>
            {error && (
              <p
                role="alert"
                className="mx-5 mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800"
              >
                {error}
              </p>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
              <AssignmentSection
                title={
                  assignmentKind === "collections" ? "Collections" : "Tags"
                }
                kind={assignmentKind}
                items={metadata[assignmentKind]}
                assigned={selected[assignmentKind]}
                disabled={busy}
                mobile
                onToggle={(item) =>
                  void toggleAssignment(selected, assignmentKind, item)
                }
              />
            </div>
            <div className="shrink-0 border-t border-neutral-200 px-5 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2">
              <button
                type="button"
                onClick={() => {
                  setMobileKind(assignmentKind);
                  setMobilePanel("browse");
                }}
                className="min-h-11 w-full rounded-lg text-sm font-medium text-neutral-700 underline underline-offset-4"
              >
                Manage {assignmentKind}
              </button>
            </div>
          </div>
        )}
      </dialog>
    </main>
  );
}

function ClassificationSection({
  title,
  kind,
  items,
  activeId,
  disabled,
  onSelect,
  onCreate,
  onEdit,
  onDelete,
  mobile = false,
}: {
  title: string;
  kind: Kind;
  items: Array<NamedItem>;
  activeId: string;
  disabled: boolean;
  onSelect: (id: string) => void;
  onCreate: (kind: Kind, name: string) => Promise<void>;
  onEdit: (kind: Kind, item: NamedItem) => Promise<void>;
  onDelete: (kind: Kind, item: NamedItem) => Promise<void>;
  mobile?: boolean;
}) {
  const [name, setName] = useState("");
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) return;
    try {
      await onCreate(kind, name);
      setName("");
    } catch {
      /* Parent displays the error. */
    }
  }
  return (
    <section className={mobile ? "flex flex-col" : undefined}>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">
        {title}
      </h2>
      <div className={`space-y-1 ${mobile ? "order-2 mt-5" : ""}`}>
        {items.map((item) => (
          <div
            key={item.id}
            className={`group flex items-center rounded-lg ${activeId === item.id ? "bg-neutral-900 text-white" : "hover:bg-white"}`}
          >
            <button
              type="button"
              onClick={() => onSelect(activeId === item.id ? "" : item.id)}
              className={`min-w-0 flex-1 truncate px-3 text-left text-sm ${mobile ? "min-h-12" : "py-2"}`}
            >
              {item.name}{" "}
              <span
                className={
                  activeId === item.id ? "text-neutral-300" : "text-neutral-400"
                }
              >
                {item.count}
              </span>
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => void onEdit(kind, item)}
              aria-label={`Rename ${item.name}`}
              className={`text-xs opacity-70 hover:opacity-100 ${mobile ? "flex size-11 items-center justify-center" : "px-1"}`}
            >
              ✎
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => void onDelete(kind, item)}
              aria-label={`Delete ${item.name}`}
              className={`text-sm opacity-70 hover:opacity-100 ${mobile ? "flex size-11 items-center justify-center" : "px-2"}`}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <form
        onSubmit={(event) => void submit(event)}
        className={`mt-2 flex gap-2 ${mobile ? "order-1" : ""}`}
      >
        <input
          aria-label={`New ${kind === "tags" ? "tag" : "collection"} name`}
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={kind === "tags" ? 40 : 80}
          placeholder={`New ${kind === "tags" ? "tag" : "collection"}`}
          className={`min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-3 outline-none focus:border-neutral-900 ${mobile ? "min-h-12 text-sm" : "py-2 text-xs"}`}
        />
        <button
          type="submit"
          disabled={disabled || !name.trim()}
          aria-label={`Create ${kind === "tags" ? "tag" : "collection"}`}
          className={`rounded-lg border border-neutral-300 bg-white text-sm hover:bg-neutral-100 disabled:opacity-40 ${mobile ? "size-12" : "px-3"}`}
        >
          +
        </button>
      </form>
    </section>
  );
}

function AssignmentSection({
  title,
  items,
  assigned,
  disabled,
  onToggle,
  mobile = false,
}: {
  title: string;
  kind: Kind;
  items: Array<NamedItem>;
  assigned: Array<AssignedItem>;
  disabled: boolean;
  onToggle: (item: NamedItem) => void;
  mobile?: boolean;
}) {
  return (
    <section
      className={mobile ? "pt-5" : "mt-6 border-t border-neutral-200 pt-5"}
    >
      <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
        {title}
      </h3>
      {items.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-500">
          {mobile
            ? "Create one with Manage below to get started."
            : "Create one in the sidebar to get started."}
        </p>
      ) : (
        <div
          className={`mt-3 space-y-1 ${mobile ? "" : "max-h-48 overflow-y-auto"}`}
        >
          {items.map((item) => (
            <label
              key={item.id}
              className={`flex cursor-pointer items-center gap-3 rounded-lg px-2 text-sm hover:bg-neutral-50 ${mobile ? "min-h-12" : "py-1.5"}`}
            >
              <input
                type="checkbox"
                checked={assigned.some((value) => value.id === item.id)}
                disabled={disabled}
                onChange={() => onToggle(item)}
                className="accent-neutral-900"
              />
              <span className="truncate">{item.name}</span>
            </label>
          ))}
        </div>
      )}
    </section>
  );
}
