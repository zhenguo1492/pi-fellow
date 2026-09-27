import { access } from 'node:fs/promises';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processPastedImages } from '../../../pi/fileAttachments';
import { pastedAttachmentsDir, savePastedFile } from '../../../pi/pastedAttachmentStore';

describe('pastedAttachmentStore', () => {
    let baseDir = '';

    beforeAll(async () => {
        baseDir = await mkdtemp(join(tmpdir(), 'pi-paste-'));
    });

    afterAll(async () => {
        if (baseDir) {
            await rm(baseDir, { recursive: true, force: true });
        }
    });

    it('savePastedFile creates the storage dir on first paste and writes bytes to it', async () => {
        const dir = pastedAttachmentsDir(baseDir);
        const path = await savePastedFile(dir, 'clip.png', Buffer.from('png-bytes'));
        const onDisk = await readFile(path, 'utf8');
        expect(onDisk).toBe('png-bytes');
        expect(path).toContain('clip.png');
    });

    it('processPastedImages uses real paths when storage dir provided', async () => {
        const dir = pastedAttachmentsDir(join(baseDir, 'proc'));
        const png1x1 =
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
        const [item] = await processPastedImages(
            [{ mimeType: 'image/png', dataBase64: png1x1, name: 'pasted-image-1.png' }],
            dir,
        );
        expect(item).toBeDefined();
        const pathMatch = item!.textFragment.match(/<file name="([^"]+)">/);
        expect(pathMatch?.[1]).toContain('pasted-image-1.png');
        await access(pathMatch![1]!);
        expect(item!.displayName).toBe('pasted-image-1.png');
        expect(item!.previewDataUrl?.startsWith('data:image/')).toBe(true);
    });
});
