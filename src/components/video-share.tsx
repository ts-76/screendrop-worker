import { Tabs, useKumoToastManager } from "@cloudflare/kumo";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { DownloadSimpleIcon, ShareNetworkIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Upload } from "@/db/schema";
import type { Author } from "@/lib/uploads.server";
import type { Transcript } from "@/lib/transcript";
import type { Chapter } from "@/components/video-player";
import type { AuthState } from "@/lib/use-auth";
import { CommentsPanel } from "@/components/comments-panel";
import { LikeButton } from "@/components/like-button";
import { ShareHeader } from "@/components/share-header";
import { TranscriptPanel } from "@/components/transcript-panel";
import { VideoPlayer, getChapterAtTime } from "@/components/video-player";
import {
  formatBytes,
  formatDuration,
  formatTimeAgo,
  formatViews,
} from "@/lib/format";
import { parseStoryboardMeta } from "@/lib/storyboard";
import { useAuth } from "@/lib/use-auth";
import { recordShareView } from "@/lib/viewer-identity";

interface VideoShareProps {
  upload: Upload;
  author: Author;
  origin: string;
  transcript: Transcript | null;
  likeCount: number;
  auth: AuthState;
}

/** The share page, layout ported from Bloom: sticky header, video with
 *  sidebar (transcript/comments), and an info row below. */
export function VideoShare({
  upload,
  author,
  origin,
  transcript,
  likeCount,
  auth: initialAuth,
}: VideoShareProps) {
  const [currentTime, setCurrentTime] = useState(0);
  const [activeTab, setActiveTab] = useState(
    transcript ? "transcript" : "comments",
  );
  const [views, setViews] = useState(upload.views);
  const activeVideoRef = useRef<HTMLVideoElement | null>(null);
  const toastManager = useKumoToastManager();
  const { auth, signOut } = useAuth(initialAuth);

  const mediaSource = `${origin}/api/media/${upload.id}`;
  const posterSource = upload.posterKey
    ? `${origin}/api/poster/${upload.id}`
    : undefined;
  const subtitlesUrl = upload.transcriptKey
    ? `${origin}/api/captions/${upload.id}`
    : undefined;
  const thumbnailsUrl = upload.storyboardKey
    ? `${origin}/api/storyboard-vtt/${upload.id}`
    : undefined;
  const hasTranscript = transcript !== null;
  // Comments/likes need both the upload's own switch and a deployment
  // that actually has sign-in configured.
  const showComments = upload.socialEnabled && auth.authEnabled;
  const hasSidebar = hasTranscript || showComments;

  // Sprite sheet + grid for the transcript's hover frame previews.
  const storyboard = useMemo(() => {
    if (!upload.storyboardKey || !upload.storyboardMeta) return null;
    try {
      const meta = parseStoryboardMeta(JSON.parse(upload.storyboardMeta));
      return meta
        ? { url: `${origin}/api/storyboard/${upload.id}`, meta }
        : null;
    } catch {
      return null;
    }
  }, [upload.storyboardKey, upload.storyboardMeta, upload.id, origin]);

  const chapters = useMemo<Array<Chapter> | undefined>(() => {
    if (!upload.chapters) return undefined;
    try {
      const parsed: Array<{ title: string; start: number }> = JSON.parse(
        upload.chapters,
      );
      if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
      return parsed.map((chapter, index) => ({
        title: chapter.title,
        startTime: chapter.start,
        endTime:
          index < parsed.length - 1
            ? parsed[index + 1].start
            : (upload.duration ?? Number.MAX_SAFE_INTEGER),
      }));
    } catch {
      return undefined;
    }
  }, [upload.chapters, upload.duration]);

  const currentChapter = useMemo(() => {
    if (!chapters?.length) return null;
    return getChapterAtTime(chapters, currentTime);
  }, [chapters, currentTime]);

  const handlePlayerActivate = useCallback((element: HTMLVideoElement) => {
    activeVideoRef.current = element;
  }, []);

  const handlePlayerTimeUpdate = useCallback(
    (time: number, element: HTMLVideoElement) => {
      activeVideoRef.current = element;
      setCurrentTime(time);
    },
    [],
  );

  const handleSeek = useCallback((time: number) => {
    const el = activeVideoRef.current;

    if (el) {
      el.currentTime = time;
      void el.play().catch(() => {});
    }

    setCurrentTime(time);
  }, []);

  // Count each viewer once, client-guarded — good enough without auth.
  useEffect(() => {
    void recordShareView(upload.id).then(
      (counted) => counted && setViews((count) => count + 1),
    );
  }, [upload.id]);

  // Tabs only make sense once there's something to switch between.
  const showSidebarTabs = hasTranscript && showComments;
  const sidebarTabs = (
    <div className="shrink-0 px-2 pb-2">
      <Tabs
        tabs={[
          { value: "transcript", label: "Transcript" },
          { value: "comments", label: "Comments" },
        ]}
        value={activeTab}
        onValueChange={setActiveTab}
        className="max-w-max"
      />
    </div>
  );

  const sidebarContent =
    activeTab === "transcript" && hasTranscript ? (
      <TranscriptPanel
        transcript={transcript}
        currentTime={currentTime}
        onSeek={handleSeek}
        storyboard={storyboard}
        className="h-full"
      />
    ) : showComments ? (
      <CommentsPanel
        uploadId={upload.id}
        currentTime={currentTime}
        onSeek={handleSeek}
        auth={auth}
        className="h-full"
      />
    ) : null;

  const videoInfo = (
    <VideoInfo
      upload={upload}
      author={author}
      views={views}
      likeCount={likeCount}
      auth={auth}
      showLike={showComments}
      mediaSource={mediaSource}
      onNotify={(message, variant) =>
        toastManager.add({ title: message, variant })
      }
    />
  );

  return (
    <div className="flex min-h-screen flex-col bg-neutral-50">
      <ShareHeader user={auth.user} onSignOut={() => void signOut()} />

      {/* Content: YouTube-like layout. Without a sidebar, cap the width
          instead of letting the video stretch edge-to-edge. */}
      <div className="flex-1 overflow-auto px-0 py-0 lg:px-6 lg:py-6">
        <div
          className={`flex flex-col ${hasSidebar ? "" : "mx-auto w-full max-w-5xl"}`}
        >
          {/* Row 1: Video + Sidebar */}
          <div className="flex flex-col lg:flex-row lg:gap-6">
            {/* Video */}
            <div
              className="w-full overflow-hidden rounded-none bg-neutral-100 ring-1 ring-neutral-200 lg:flex-1 lg:rounded-2xl"
              style={{ maxHeight: "calc(100vh - 56px - 240px)" }}
            >
              <VideoPlayer
                src={mediaSource}
                poster={posterSource}
                initialTime={currentTime}
                subtitlesUrl={subtitlesUrl}
                thumbnailsUrl={thumbnailsUrl}
                onActivate={handlePlayerActivate}
                onTimeUpdate={handlePlayerTimeUpdate}
                className="block h-full w-full"
              />
            </div>

            {/* Sidebar */}
            {hasSidebar && (
              <div
                className="hidden shrink-0 flex-col lg:flex"
                style={{
                  width: "400px",
                  maxHeight: "calc(100vh - 56px - 240px)",
                }}
              >
                {showSidebarTabs && sidebarTabs}
                <div className="min-h-0 flex-1">{sidebarContent}</div>
              </div>
            )}
          </div>

          {/* Row 2: Video Info + Chapters (constrained to video width) */}
          <div
            className={`mt-3 w-full px-4 lg:px-0 ${hasSidebar ? "lg:max-w-[calc(100%-400px-1.5rem)]" : ""}`}
          >
            {videoInfo}

            {currentChapter && (
              <CurrentChapterIndicator chapter={currentChapter} />
            )}
          </div>

          {/* Mobile-only: Sidebar below content */}
          {hasSidebar && (
            <div className="mt-4 px-4 lg:hidden">
              {showSidebarTabs && sidebarTabs}
              <div className="flex flex-col" style={{ maxHeight: "400px" }}>
                {sidebarContent}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function VideoInfo({
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
  // One quiet metadata line under the author instead of a separate bar.
  const metadata = [
    formatTimeAgo(upload.createdAt),
    formatBytes(upload.size),
    upload.duration ? formatDuration(upload.duration) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const handleShare = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      onNotify("Link copied");
    } catch {
      onNotify("Failed to copy link", "error");
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
            icon={<ShareNetworkIcon weight="bold" />}
            onClick={() => void handleShare()}
          >
            Share
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

function CurrentChapterIndicator({ chapter }: { chapter: Chapter }) {
  return (
    <div className="mt-3 flex items-center gap-2">
      <span className="inline-flex items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-2.5 py-1 text-xs font-medium text-neutral-700">
        <span className="size-1.5 animate-pulse rounded-full bg-neutral-900" />
        {chapter.title}
      </span>
      <span className="font-mono text-xs text-neutral-400 tabular-nums">
        {formatDuration(chapter.startTime)}
      </span>
    </div>
  );
}
