import { randomUUID } from 'node:crypto';
import type { ImageContent } from '../shared/piTypes';
import type { VoiceAttachments } from '../shared/voiceViewProtocol';
import type { ProcessedFileAttachment } from './fileAttachments';

export interface PendingAttachment {
    id: string;
    displayName: string;
    isImage: boolean;
    previewDataUrl?: string;
    absolutePath?: string;
    textFragment: string;
    image?: ImageContent;
}

export interface PendingAttachmentPreview {
    id: string;
    displayName: string;
    isImage: boolean;
    previewDataUrl?: string;
    /** Local path for open-on-click in composer. */
    absolutePath?: string;
}

export function toPendingTextFileAttachment(name: string, text: string): PendingAttachment {
    const displayName = name.split(/[/\\]/).pop() || name;
    return {
        id: randomUUID(),
        displayName,
        isImage: false,
        absolutePath: name,
        textFragment: `<file name="${name}">\n${text}\n</file>\n`,
    };
}

export function toPendingAttachment(item: ProcessedFileAttachment): PendingAttachment {
    return {
        id: randomUUID(),
        displayName: item.displayName,
        isImage: item.isImage,
        previewDataUrl: item.previewDataUrl,
        absolutePath: item.absolutePath ?? absolutePathFromFragment(item.textFragment),
        textFragment: item.textFragment,
        image: item.image,
    };
}

export function absolutePathFromFragment(textFragment: string): string | undefined {
    const m = textFragment.match(/<file name="([^"]+)">/);
    const p = m?.[1]?.trim();
    return p && p.length > 0 ? p : undefined;
}

export function toPreviewList(items: PendingAttachment[]): PendingAttachmentPreview[] {
    return items.map((a) => ({
        id: a.id,
        displayName: a.displayName,
        isImage: a.isImage,
        absolutePath: a.absolutePath ?? absolutePathFromFragment(a.textFragment),
        previewDataUrl: a.isImage ? a.previewDataUrl : undefined,
    }));
}

/** The attachments going with a message to the voice agent; undefined without any. */
export function toVoiceAttachments(items: PendingAttachment[]): VoiceAttachments | undefined {
    if (items.length === 0) {
        return undefined;
    }
    return {
        names: items.map((a) => a.displayName),
        images: items.flatMap((a) => (a.image ? [a.image] : [])),
        files: items.map((a) => a.textFragment).join(''),
    };
}

/** Queued user message with file/image snapshot taken at queue time. */
export interface QueuedPrompt {
    text: string;
    attachments: PendingAttachment[];
    /** Sent by the voice agent: its user message gets the "From voice" tag once it runs. */
    fromVoice?: boolean;
}
