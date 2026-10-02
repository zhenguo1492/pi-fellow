import { describe, expect, it, vi } from 'vitest';
import { toVoiceAttachments, type PendingAttachment } from '../../../pi/pendingAttachments';
import { voiceUserMessage } from '../../../shared/voiceViewProtocol';
import { VoiceTranscriptStore, type VoiceSessionRecord } from '../../../voiceAgent/transcriptStore';
import { VoicePanel, type BotViewSurface, type VoiceViewController } from '../../../voiceAgent/voicePanel';
import type { WorkerController } from '../../../voiceAgent/workerController';

vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
        onDidChangeConfiguration: () => ({ dispose: () => {} }),
    },
}));

const pasted: PendingAttachment = {
    id: '1',
    displayName: 'pasted-image-1.png',
    isImage: true,
    absolutePath: '/store/pasted-attachments/pasted-image-1.png',
    textFragment: '<file name="/store/pasted-attachments/pasted-image-1.png"></file>\n',
    image: { type: 'image', mimeType: 'image/png', data: 'AAAA' },
};
const dropped: PendingAttachment = {
    id: '2',
    displayName: 'shot.png',
    isImage: true,
    absolutePath: '/home/me/Desktop/shot.png',
    textFragment: '<file name="/home/me/Desktop/shot.png"></file>\n',
    image: { type: 'image', mimeType: 'image/png', data: 'BBBB' },
};
const notes: PendingAttachment = { id: '3', displayName: 'notes.md', isImage: false, absolutePath: '/w/notes.md', textFragment: '<file name="/w/notes.md">\nhi\n</file>\n' };
/** An image too large to resize goes in as a note: there is no picture to show. */
const omitted: PendingAttachment = { id: '4', displayName: 'huge.png', isImage: false, textFragment: '<file name="/w/huge.png">[Image omitted]</file>\n' };

describe('images attached to a message for the voice agent', () => {
    it('go on the message’s image card, while other attachments keep their names in its text', () => {
        const attachments = toVoiceAttachments([pasted, notes, dropped, omitted])!;
        expect(voiceUserMessage('what is wrong here?', attachments)).toEqual({
            text: 'what is wrong here? [notes.md] [huge.png]',
            images: [
                { name: 'pasted-image-1.png', path: '/store/pasted-attachments/pasted-image-1.png' },
                { name: 'shot.png', path: '/home/me/Desktop/shot.png' },
            ],
        });
        // The voice model still gets every image and file.
        expect(attachments.images.map((i) => i.data)).toEqual(['AAAA', 'BBBB']);
        expect(attachments.files).toBe(pasted.textFragment + notes.textFragment + dropped.textFragment + omitted.textFragment);
        expect(voiceUserMessage('', toVoiceAttachments([notes]))).toEqual({ text: '[notes.md]' });
    });

    it('are saved with the transcript by path, and reach the Bot view with a webview URI where the webview may load them', () => {
        const task = { tabId: 't1', sessionFile: '/s/worker.jsonl', name: 'Task' };
        const saved = new Map<string, unknown>();
        const memento = {
            get: <T>(key: string) => saved.get(key) as T | undefined,
            update: async (key: string, value: unknown) => void saved.set(key, JSON.parse(JSON.stringify(value))),
        };
        const store = new VoiceTranscriptStore(memento, { sessions: () => 20, entries: 300 }, () => task);
        const user = voiceUserMessage('what is wrong here?', toVoiceAttachments([pasted, dropped]));
        store.addUser(user.text, 'text', undefined, user.images);
        store.flush();

        const surface: BotViewSurface = {
            onDidReceiveVoiceMessage: () => ({ dispose: () => {} }),
            onDidChangeBotViewVisibility: () => ({ dispose: () => {} }),
            isBotViewVisible: () => false,
            postVoice: () => {},
            imageSrc: (path) => (path.startsWith('/store/') ? `https://res${path}` : undefined),
            showBotView: async () => {},
        };
        const worker = { activeTask: () => undefined, onActiveTaskChanged: () => ({ dispose: () => {} }), onRequestsChanged: () => ({ dispose: () => {} }) } as unknown as WorkerController;
        const controller = { phase: () => 'off', engines: () => undefined, agent: () => undefined } as unknown as VoiceViewController;
        const [entry] = new VoicePanel(store, worker, controller, surface).snapshot().entries;

        expect(entry.kind === 'user' && entry.images).toEqual([
            { name: 'pasted-image-1.png', path: '/store/pasted-attachments/pasted-image-1.png', src: 'https://res/store/pasted-attachments/pasted-image-1.png' },
            { name: 'shot.png', path: '/home/me/Desktop/shot.png', src: undefined },
        ]);
        const [record] = saved.get('voiceAgent.transcripts') as VoiceSessionRecord[];
        expect(record.entries[0]).toMatchObject({ text: 'what is wrong here?', images: [{ name: 'pasted-image-1.png', path: pasted.absolutePath }, { name: 'shot.png', path: dropped.absolutePath }] });
        expect(JSON.stringify(record)).not.toContain('https://res');
    });
});
