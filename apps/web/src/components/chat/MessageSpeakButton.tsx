import { memo, useEffect, useRef } from "react";
import { Square, Volume2 } from "lucide";

import { Spinner } from "../ui/spinner";
import type { EnvironmentId } from "@t3tools/contracts";

import { useSpokenMessage } from "~/hooks/useSpokenMessage";
import { cn } from "~/lib/utils";
import { MorphIcon } from "~/components/MorphIcon";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Read-aloud control for one agent message, Gemini-style: tap to hear the
 * message, tap again to stop. While playing, the icon swaps to a stop square
 * with a hairline progress underline; leaving the row stops playback.
 */
export const MessageSpeakButton = memo(function MessageSpeakButton({
  messageKey,
  environmentId,
  text,
  className,
}: {
  readonly messageKey: string;
  readonly environmentId: EnvironmentId;
  readonly text: string;
  readonly className?: string;
}) {
  const { speech, speak, stop } = useSpokenMessage(environmentId);
  const isSpeakingThis = speech.key === messageKey;
  const isLoadingThis = isSpeakingThis && speech.phase === "loading";
  const speechRef = useRef(speech);
  // Latest-ref pattern: the unmount cleanup below must see the newest state,
  // but reading it during render would tear the subscription.
  useEffect(() => {
    speechRef.current = speech;
  }, [speech]);

  useEffect(() => {
    // Virtualized rows unmount when scrolled away. A manual read dies with its
    // row ("no orphaned playback"); an auto-read keeps playing radio-style.
    return () => {
      if (speechRef.current.key === messageKey && speechRef.current.source === "manual") stop();
    };
  }, [messageKey, stop]);

  return (
    <span className="relative inline-flex">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label={isSpeakingThis ? "Stop reading aloud" : "Read aloud"}
              onClick={() => (isSpeakingThis ? stop() : speak({ key: messageKey, text }))}
              type="button"
              size="xs"
              variant="ghost-muted"
              className={className}
            />
          }
        >
          {isLoadingThis ? (
            <Spinner className="size-3" />
          ) : (
            <MorphIcon
              className={cn("size-3", isSpeakingThis && "text-primary")}
              icon={isSpeakingThis ? Square : Volume2}
            />
          )}
        </TooltipTrigger>
        <TooltipPopup>
          <p>
            {isLoadingThis
              ? "Synthesizing read aloud"
              : isSpeakingThis
                ? "Stop reading aloud"
                : "Read aloud"}
          </p>
        </TooltipPopup>
      </Tooltip>
      {isSpeakingThis && speech.progress !== null ? (
        <span
          aria-hidden
          className="absolute inset-x-1 -bottom-px h-px overflow-hidden rounded-full bg-primary/20"
        >
          <span
            className="block h-full rounded-full bg-primary transition-[width] duration-200"
            style={{ width: `${Math.round(speech.progress * 100)}%` }}
          />
        </span>
      ) : null}
    </span>
  );
});
