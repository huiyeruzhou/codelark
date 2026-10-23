import type { OutboundAttachment, SendResult } from '../../domain/index.js';
import { parseOutboundArtifacts } from '../../channels/delivery/artifacts.js';
import {
  dedupeOutboundAttachments,
  outboundAttachmentKey,
} from './response-assembler.js';

export interface StreamingArtifactDeliveryController {
  observeAnswerText(answerText: string): void;
  close(): Promise<void>;
  withoutDelivered(attachments: OutboundAttachment[]): OutboundAttachment[];
}

export interface StreamingArtifactDeliveryControllerOptions {
  deliver(attachments: OutboundAttachment[]): Promise<SendResult>;
  onDeliveryError?(error: string, attachments: OutboundAttachment[]): void;
}

/**
 * Delivers complete clk-send blocks and local links to supported image files as soon as
 * they appear in answer text.
 *
 * Observations are synchronous and non-blocking. Delivery is serialized in the
 * background; close() is the terminal barrier used before final-response
 * delivery. Failed intermediate attempts remain eligible for one final retry.
 */
export function createStreamingArtifactDeliveryController(
  options: StreamingArtifactDeliveryControllerOptions,
): StreamingArtifactDeliveryController {
  const attemptedKeys = new Set<string>();
  const deliveredKeys = new Set<string>();
  let closed = false;
  let observedText = '';
  let deliveryChain: Promise<void> = Promise.resolve();

  const observeAnswerText = (answerText: string): void => {
    if (closed) return;
    if (answerText === observedText) return;
    observedText = answerText;
    // Parse the complete Markdown context; slicing a tag out of a code example
    // turns documentation into an executable upload instruction.
    const discovered = parseOutboundArtifacts(answerText).attachments;

    const pendingDelivery = dedupeOutboundAttachments(discovered)
      .filter((attachment) => !attemptedKeys.has(outboundAttachmentKey(attachment)));
    if (pendingDelivery.length === 0) return;
    for (const attachment of pendingDelivery) attemptedKeys.add(outboundAttachmentKey(attachment));

    for (const attachment of pendingDelivery) {
      deliveryChain = deliveryChain.then(async () => {
        try {
          const result = await options.deliver([attachment]);
          if (!result.ok) {
            options.onDeliveryError?.(result.error || 'streaming artifact delivery failed', [attachment]);
            return;
          }
          deliveredKeys.add(outboundAttachmentKey(attachment));
        } catch (error) {
          options.onDeliveryError?.(
            error instanceof Error ? error.message : String(error),
            [attachment],
          );
        }
      });
    }
  };

  return {
    observeAnswerText,
    async close() {
      closed = true;
      await deliveryChain;
    },
    withoutDelivered(attachments) {
      return dedupeOutboundAttachments(attachments)
        .filter((attachment) => !deliveredKeys.has(outboundAttachmentKey(attachment)));
    },
  };
}
