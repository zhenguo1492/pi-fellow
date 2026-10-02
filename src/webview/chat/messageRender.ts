import {
    isImageFilePath,
    parseUserMessageForDisplay,
    type DisplayFileAttachment,
} from '../../shared/attachmentMessageDisplay';
import { stripPlanContentForChatDisplay } from '../../shared/planMessageFilter';
import { buildMessageAttachmentChips, cacheImagePreview, resolveImageOpenPath } from './attachments';
import { buildDiffCard, findFileChangeForToolResult } from './diffCard';
import { el, formatTimestamp } from './helpers';
import { renderMarkdown } from './markdown';
import { buildMessageActions } from './messageActions';
import { extractImages, extractText, extractThinking } from './messageContent';
import { pendingMessageRowHtml } from './pendingMessages';
import { state } from './state';
import { buildThinkingBlock } from './thinking';
import { buildToolResultCard } from './tools';

/** Marks a worker user message the voice agent dispatched (design §11.3); the host sets `_fromVoice`. */
const FROM_VOICE_TAG = '<span class="from-voice">🎙 From voice</span>';

export function renderMessage(
    msg: any,
    index: number,
    turnNumber?: number,
): HTMLElement {
    const role = msg.role ?? 'unknown';

    if (role === 'toolResult' || role === 'tool') {
        const toolName = msg.toolName ?? '';
        if (toolName === 'edit' || toolName === 'write') {
            const matchingChange = findFileChangeForToolResult(msg);
            if (matchingChange) {
                return buildDiffCard(matchingChange, msg);
            }
        }
        return buildToolResultCard(msg, state.messages, index);
    }

    if (role === 'user' && msg.steering === true) {
        const steeringEl = el('div', 'pending-messages pending-messages--steering committed-steering');
        const { displayText } = parseUserMessageForDisplay(extractText(msg));
        steeringEl.innerHTML = pendingMessageRowHtml(
            'steer',
            displayText || extractText(msg) || '(attachments)',
            msg._fromVoice ? FROM_VOICE_TAG : '',
        );
        return steeringEl;
    }
    if (role === 'user') {
        const group = el('div', 'message-group-user');
        if (turnNumber !== undefined) {
            // Absolute (1-based): queued steers find their prompt even when earlier turns are not rendered.
            group.dataset.turn = String(turnNumber);
        }
        const card = el('div', 'user-prompt-card');
        const actions = buildMessageActions('user', index, msg);
        if (turnNumber !== undefined && !state.isStreaming) {
            const checkpointBtn = el('button', 'checkpoint-btn msg-action msg-action--icon');
            checkpointBtn.type = 'button';
            checkpointBtn.title = 'Restore to this checkpoint';
            checkpointBtn.dataset.turn = String(turnNumber);
            checkpointBtn.innerHTML = '&#8634;';
            actions.prepend(checkpointBtn);
        }

        const wrapper = el('div', `message message-${role}`);
        if (msg._fromVoice) {
            wrapper.insertAdjacentHTML('beforeend', FROM_VOICE_TAG);
        }
        const rawText = extractText(msg);
        const { displayText, fileAttachments: parsedFiles } = parseUserMessageForDisplay(rawText);
        if (displayText) {
            const content = el('div', 'message-content');
            content.innerHTML = renderMarkdown(displayText);
            wrapper.appendChild(content);
        }
        const fileAttachments: Array<DisplayFileAttachment & { dataUrl?: string }> = [...parsedFiles];
        const imageFiles = fileAttachments.filter((f) => isImageFilePath(f.path));
        const extractedImgs = extractImages(msg);

        // When the content carries extracted image data, attach the base64 to the image
        // attachment it belongs to, so one image does not render as two chips.
        const unassignedExtracted: typeof extractedImgs = [];
        if (imageFiles.length === extractedImgs.length) {
            for (let i = 0; i < imageFiles.length; i++) {
                const img = extractedImgs[i];
                const dataUrl = `data:${img.mimeType};base64,${img.data}`;
                imageFiles[i].dataUrl = dataUrl;
                cacheImagePreview(imageFiles[i].path, dataUrl);
            }
        } else {
            const imagePathsByBase = new Map<string, string>();
            for (const f of imageFiles) {
                imagePathsByBase.set(f.displayName.toLowerCase(), f.path);
            }

            for (const img of extractedImgs) {
                const openPath = resolveImageOpenPath(img, imagePathsByBase);
                const matchedFile = openPath
                    ? imageFiles.find((f) => f.path.toLowerCase() === openPath.toLowerCase())
                    : undefined;

                const dataUrl = `data:${img.mimeType};base64,${img.data}`;
                if (matchedFile) {
                    matchedFile.dataUrl = dataUrl;
                    cacheImagePreview(matchedFile.path, dataUrl);
                } else if (imageFiles.length === 1 && extractedImgs.length === 1) {
                    imageFiles[0].dataUrl = dataUrl;
                    cacheImagePreview(imageFiles[0].path, dataUrl);
                } else {
                    unassignedExtracted.push(img);
                }
            }
        }

        // Only an image with no matching local file attachment is appended as its own inline image.
        for (const img of unassignedExtracted) {
            const dataUrl = `data:${img.mimeType};base64,${img.data}`;
            const pathKey = `inline-image-${Math.random().toString(36).slice(2, 8)}.png`;
            const displayName = img.name || 'image.png';
            fileAttachments.push({ displayName, path: pathKey, dataUrl });
        }

        if (fileAttachments.length > 0) {
            wrapper.appendChild(buildMessageAttachmentChips(fileAttachments));
        }
        card.appendChild(wrapper);
        // Below the text, so the hover actions never cover it; the clamp toggle joins it on the left.
        const bar = el('div', 'user-prompt-bar');
        bar.appendChild(actions);
        card.appendChild(bar);
        group.appendChild(card);

        const footer = buildMessageFooter(msg, index);
        if (footer) {
            group.appendChild(footer);
        }

        return group;
    }

    // Assistant messages: wrap in a styled container
    const group = el('div', 'message-group-assistant');
    const wrapper = el('div', `message message-${role}`);
    let hasThinking = false;
    let hasText = false;

    if (Array.isArray(msg.content)) {
        const thinkingMerged = extractThinking(msg).trim();
        if (thinkingMerged) {
            wrapper.appendChild(
                buildThinkingBlock(thinkingMerged, false, msg._thinkingDurationSec, `${index}:0`),
            );
            hasThinking = true;
        }
        for (let i = 0; i < msg.content.length; i++) {
            const block = msg.content[i];
            if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
                continue;
            } else if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
                let blockText = stripPlanContentForChatDisplay(block.text);
                if (blockText.trim()) {
                    const content = el('div', 'message-content');
                    content.innerHTML = renderMarkdown(blockText);
                    wrapper.appendChild(content);
                    hasText = true;
                }
            }
        }
    } else {
        const thinking = extractThinking(msg);
        let text = extractText(msg);
        if (text) {
            text = stripPlanContentForChatDisplay(text);
        }
        if (thinking.trim()) {
            wrapper.appendChild(
                buildThinkingBlock(thinking, false, msg._thinkingDurationSec, `${index}:0`),
            );
            hasThinking = true;
        }
        if (text) {
            const content = el('div', 'message-content');
            content.innerHTML = renderMarkdown(text);
            wrapper.appendChild(content);
            hasText = true;
        }
    }

    const isAssistantError = role === 'assistant' && msg.stopReason === 'error';
    const errorText =
        isAssistantError &&
        typeof msg.errorMessage === 'string' &&
        msg.errorMessage.trim()
            ? msg.errorMessage.trim()
            : '';

    if (!hasThinking && !hasText && !errorText) {
        const empty = el('div');
        empty.hidden = true;
        return empty;
    }

    if (errorText) {
        const errBlock = el('div', 'message-error');
        errBlock.textContent = errorText;
        wrapper.appendChild(errBlock);
    }

    group.appendChild(wrapper);
    // An intermediate step that only reasons before its tool calls has no reply to copy,
    // regenerate, or measure; footer chrome there would split the thought from its tools.
    if (!hasText && !errorText) {
        return group;
    }
    group.appendChild(buildMessageActions('assistant', index, msg));

    const footer = buildMessageFooter(msg, index);
    if (footer) {
        group.appendChild(footer);
    }

    return group;
}

/**
 * Footer segments under a user/assistant message: timestamp, then input tokens (user: taken from
 * the next assistant reply before the next user message) or tok/s + output tokens (assistant).
 * Empty for other roles or when nothing is known.
 */
export function messageFooterParts(msg: any, index: number, messages: any[]): string[] {
    const role = msg.role ?? 'unknown';
    if (role !== 'user' && role !== 'assistant') return [];

    const parts: string[] = [];

    const ts = msg.timestamp;
    if (ts) {
        parts.push(formatTimestamp(ts));
    }

    if (role === 'user') {
        // Show input tokens from the next assistant message's usage
        for (let j = index + 1; j < messages.length; j++) {
            const next = messages[j];
            if (next.role === 'assistant' && next.usage && next.usage.input > 0) {
                parts.push(`${next.usage.input.toLocaleString()} input tokens`);
                break;
            }
            if (next.role === 'user') break;
        }
    }

    if (role === 'assistant') {
        if (msg._messageEndTime && msg.timestamp) {
            const startMs = msg.timestamp < 1e12 ? msg.timestamp * 1000 : msg.timestamp;
            const durationSec = (msg._messageEndTime - startMs) / 1000;
            const usage = msg.usage;
            if (usage && usage.output > 0 && durationSec > 0) {
                const tokPerSec = usage.output / durationSec;
                parts.push(`${tokPerSec.toFixed(1)} tok/s`);
            }
        }

        const usage = msg.usage;
        if (usage && usage.output > 0) {
            parts.push(`${usage.output.toLocaleString()} output tokens`);
        }
    }

    return parts;
}

function buildMessageFooter(msg: any, index: number): HTMLElement | null {
    const parts = messageFooterParts(msg, index, state.messages);
    if (parts.length === 0) return null;

    const footer = el('div', 'message-footer');
    footer.textContent = parts.join(' · ');
    return footer;
}
