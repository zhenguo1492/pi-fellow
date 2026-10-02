import { describe, expect, it } from 'vitest';
import { noRecorderMessage, recorderSearchDirs } from '../../../voice/dictation';

describe('recorderSearchDirs', () => {
    it('keeps PATH first and appends the Homebrew directories a GUI app does not inherit', () => {
        // What VS Code gets when macOS launches it from the Dock.
        const dirs = recorderSearchDirs('/usr/bin:/bin:/usr/sbin:/sbin', 'darwin');

        expect(dirs.slice(0, 4)).toEqual(['/usr/bin', '/bin', '/usr/sbin', '/sbin']);
        expect(dirs).toContain('/opt/homebrew/bin');
        expect(dirs).toContain('/usr/local/bin');
    });

    it('does not repeat a directory PATH already lists', () => {
        const dirs = recorderSearchDirs('/opt/homebrew/bin:/usr/bin', 'darwin');

        expect(dirs.filter((dir) => dir === '/opt/homebrew/bin')).toHaveLength(1);
        expect(dirs).toEqual(['/opt/homebrew/bin', '/usr/bin', '/usr/local/bin']);
    });

    it('appends them on Linux too, where a packaged editor can miss /usr/local/bin', () => {
        expect(recorderSearchDirs('/usr/bin', 'linux')).toEqual(['/usr/bin', '/opt/homebrew/bin', '/usr/local/bin']);
    });

    it('leaves Windows to its own PATH, where those directories mean nothing', () => {
        expect(recorderSearchDirs('C:\\Windows\\System32', 'win32')).toEqual(['C:\\Windows\\System32']);
    });

    it('still yields the fallbacks when PATH is empty or unset', () => {
        expect(recorderSearchDirs('', 'darwin')).toEqual(['/opt/homebrew/bin', '/usr/local/bin']);
    });
});

describe('noRecorderMessage', () => {
    it('names the package manager of the platform the user is on', () => {
        expect(noRecorderMessage('darwin')).toContain('brew install sox');
        expect(noRecorderMessage('linux')).toContain('alsa-utils');
        expect(noRecorderMessage('win32')).toContain('SoX');
    });

    it('says what went wrong before saying what to install', () => {
        for (const platform of ['darwin', 'linux', 'win32'] as NodeJS.Platform[]) {
            expect(noRecorderMessage(platform)).toMatch(/^No audio recorder found\. /);
        }
    });
});
