import { SkeletonLine, useKumoToastManager } from "@cloudflare/kumo";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { CopyIcon, DownloadSimpleIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { Upload } from "@/db/schema";
import type { Author } from "@/lib/uploads.server";
import type { AuthState } from "@/lib/use-auth";
import { CommentsPanel } from "@/components/comments-panel";
import { LikeButton } from "@/components/like-button";
import { ShareHeader } from "@/components/share-header";
import { formatBytes, formatTimeAgo, formatViews } from "@/lib/format";
import { useAuth } from "@/lib/use-auth";
import { recordShareView } from "@/lib/viewer-identity";

interface ShareViewerProps {
  upload: Upload;
  author: Author;
  origin: string;
  likeCount: number;
  auth: AuthState;
}

/** The screenshot share page, laid out like the video share page: sticky
 *  header, media with a comments sidebar, and an info row below. */
export function ShareViewer({
  upload,
  author,
  origin,
  likeCount,
  auth: initialAuth,
}: ShareViewerProps) {
  const mediaSource = `${origin}/api/image/${upload.id}`;
  const [loadedImageSource, setLoadedImageSource] = useState<string | null>(
    null,
  );
  const [views, setViews] = useState(upload.views);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const toastManager = useKumoToastManager();
  const { auth, signOut } = useAuth(initialAuth);
  const imageLoaded = loadedImageSource === mediaSource;
  // Comments/likes need both the upload's own switch and a deployment
  // that actually has sign-in configured.
  const showComments = upload.socialEnabled && auth.authEnabled;

  // Count each viewer once, client-guarded — good enough without auth.
  useEffect(() => {
    void recordShareView(upload.id).then(
      (counted) => counted && setViews((count) => count + 1),
    );
  }, [upload.id]);

  useEffect(() => {
    const image = imageRef.current;
    if (image?.complete) {
      setLoadedImageSource(mediaSource);
    }
  }, [mediaSource]);

  function showNotice(message: string, variant?: "error") {
    toastManager.add({ title: message, variant });
  }

  const imageInfo = (
    <ImageInfo
      upload={upload}
      author={author}
      views={views}
      likeCount={likeCount}
      auth={auth}
      showLike={showComments}
      mediaSource={mediaSource}
      onNotify={showNotice}
    />
  );

  return (
    <div className="flex min-h-screen flex-col bg-neutral-50">
      <ShareHeader user={auth.user} onSignOut={() => void signOut()} />

      {/* Content: same YouTube-like layout as the video share page.
          Without a sidebar, cap the width instead of letting the image
          stretch edge-to-edge. */}
      <div className="flex-1 overflow-auto px-0 py-0 lg:px-6 lg:py-6">
        <div
          className={`flex flex-col ${showComments ? "" : "mx-auto w-full max-w-5xl"}`}
        >
          {/* Row 1: Image + Sidebar */}
          <div className="flex flex-col lg:flex-row lg:gap-6">
            {/* Image */}
            <div
              className="w-full overflow-hidden rounded-none bg-neutral-100 ring-1 ring-neutral-200 lg:flex-1 lg:rounded-2xl"
              style={{
                aspectRatio:
                  upload.width && upload.height
                    ? `${upload.width} / ${upload.height}`
                    : "16 / 9",
                maxHeight: "calc(100vh - 56px - 240px)",
              }}
            >
              {!imageLoaded && (
                <SkeletonLine
                  minWidth={100}
                  maxWidth={100}
                  minDuration={1.5}
                  maxDuration={1.5}
                  minDelay={0}
                  maxDelay={0}
                  className="h-full w-full"
                />
              )}
              <img
                ref={imageRef}
                src={mediaSource}
                alt={upload.filename}
                className={`h-full w-full object-contain ${imageLoaded ? "block" : "hidden"}`}
                onLoad={() => setLoadedImageSource(mediaSource)}
                onError={() => setLoadedImageSource(mediaSource)}
              />
            </div>

            {/* Sidebar */}
            {showComments && (
              <div
                className="hidden shrink-0 flex-col lg:flex"
                style={{
                  width: "400px",
                  maxHeight: "calc(100vh - 56px - 240px)",
                }}
              >
                <CommentsPanel
                  uploadId={upload.id}
                  auth={auth}
                  className="h-full"
                />
              </div>
            )}
          </div>

          {/* Row 2: Image Info (constrained to image width) */}
          <div
            className={`mt-3 w-full px-4 lg:px-0 ${showComments ? "lg:max-w-[calc(100%-400px-1.5rem)]" : ""}`}
          >
            {imageInfo}
          </div>

          {/* Mobile-only: Sidebar below content */}
          {showComments && (
            <div className="mt-4 px-4 lg:hidden">
              <div className="flex flex-col" style={{ maxHeight: "400px" }}>
                <CommentsPanel uploadId={upload.id} auth={auth} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ImageInfo({
  upload,
  author,
  views,
  likeCount,
  auth,
  showLike,
  mediaSource,
  onNotify,
}: {
  upload: Upload;
  author: Author;
  views: number;
  likeCount: number;
  auth: AuthState;
  showLike: boolean;
  mediaSource: string;
  onNotify: (message: string, variant?: "error") => void;
}) {
  const title = upload.title?.trim() || upload.filename;
  const dimensions =
    upload.width && upload.height ? `${upload.width} × ${upload.height}` : null;
  const metadata = [dimensions, formatBytes(upload.size), formatTimeAgo(upload.createdAt)]
    .filter(Boolean)
    .join(" · ");

  const handleCopyImage = async () => {
    try {
      const response = await fetch(mediaSource);
      const blob = await response.blob();
      await navigator.clipboard.write([
        new ClipboardItem({ [blob.type]: blob }),
      ]);
      onNotify("Image copied");
    } catch {
      onNotify("Failed to copy image", "error");
    }
  };

  return (
    <div className="flex flex-col">
      {/* Title */}
      <h1 className="text-lg font-semibold text-neutral-900 lg:text-xl">
        {title}
      </h1>

      {/* Author + Actions row */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        {/* Author */}
        <div className="flex min-w-0 items-center gap-3">
          <img
            src={author.avatar}
            alt={author.name}
            className="size-10 shrink-0 rounded-full"
          />
          <div className="min-w-0">
            <p className="font-medium text-neutral-900">{author.name}</p>
            <p className="text-xs text-neutral-500">{metadata}</p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 flex items-center gap-1.5 text-sm font-medium text-neutral-500">
            {formatViews(views)}
          </span>
          {showLike && (
            <LikeButton
              uploadId={upload.id}
              auth={auth}
              initialCount={likeCount}
            />
          )}
          <Button
            variant="secondary"
            icon={<CopyIcon weight="bold" />}
            onClick={() => void handleCopyImage()}
          >
            Copy Image
          </Button>
          <LinkButton
            href={mediaSource}
            download={upload.filename}
            variant="secondary"
            icon={<DownloadSimpleIcon weight="bold" />}
          >
            Download
          </LinkButton>
        </div>
      </div>
    </div>
  );
}
