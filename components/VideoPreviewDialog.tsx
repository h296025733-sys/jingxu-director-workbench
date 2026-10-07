"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Video {
  id: string;
  name: string;
}

export default function VideoPreviewDialog({
  video,
  open,
  onClose,
}: {
  video: Video | null;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="truncate pr-8">
            {video?.name ?? "视频预览"}
          </DialogTitle>
        </DialogHeader>
        {video && (
          <video
            key={video.id}
            src={`/api/videos/${video.id}/file`}
            controls
            autoPlay
            playsInline
            preload="metadata"
            className="w-full rounded-lg bg-black"
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
