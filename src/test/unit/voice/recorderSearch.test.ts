import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { chooseCapture, micErrorMessage, noRecorderMessage, recorderExitHint, recorderSearchDirs } from '../../../voice/dictation';

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

    it('offers the browser everywhere, since it needs no package manager at all', () => {
        for (const platform of ['darwin', 'linux', 'win32'] as NodeJS.Platform[]) {
            expect(noRecorderMessage(platform)).toContain('Google Chrome');
        }
    });

    it('says what went wrong before saying what to install', () => {
        for (const platform of ['darwin', 'linux', 'win32'] as NodeJS.Platform[]) {
            expect(noRecorderMessage(platform)).toMatch(/^No way to record found\. /);
        }
    });
});

/** A directory holding only the named executables, so a lookup answers for it and not for this machine. */
const temps: string[] = [];
function binDir(...executables: string[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-fellow-recorders-'));
    temps.push(dir);
    for (const name of executables) {
        fs.writeFileSync(path.join(dir, name), '', { mode: 0o755 });
    }
    return dir;
}
afterAll(() => temps.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe('chooseCapture', () => {
    const chrome = () => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

    it('takes the command-line recorder when the machine has one', () => {
        const capture = chooseCapture([binDir('arecord')], chrome);

        expect(capture).toEqual({ kind: 'recorder', recorder: expect.objectContaining({ command: expect.stringContaining('arecord') }) });
    });

    it('prefers arecord over sox rec, which takes seconds to deliver audio', () => {
        const capture = chooseCapture([binDir('rec', 'arecord')], chrome);

        expect(capture?.kind === 'recorder' && capture.recorder.command).toContain('arecord');
    });

    it('falls back to the hidden browser when no recorder is installed, as on a stock macOS', () => {
        expect(chooseCapture([binDir()], chrome)).toEqual({ kind: 'browser', chrome: chrome() });
    });

    it('gives up only when neither a recorder nor a browser is there', () => {
        expect(chooseCapture([binDir()], () => undefined)).toBeUndefined();
    });
});

describe('micErrorMessage', () => {
    it('reads a missing device as something to plug in, not as a failure to explain', () => {
        expect(micErrorMessage('NotFoundError: Requested device not found')).toMatch(/No microphone found/);
    });

    it('separates a denied permission from a missing device', () => {
        expect(micErrorMessage('NotAllowedError: Permission denied')).toMatch(/denied/i);
        expect(micErrorMessage('NotReadableError: Could not start audio source')).toMatch(/could not be read/i);
    });

    it('passes an error it does not recognise through rather than guessing', () => {
        expect(micErrorMessage('WeirdError: something new')).toContain('WeirdError: something new');
    });
});

describe('recorderExitHint', () => {
    it('explains the device error SoX reports on a machine with no microphone', () => {
        expect(recorderExitHint("formats: can't open input `default': can not open audio device")).toMatch(/no microphone/i);
    });

    it('adds nothing to an exit it has no explanation for', () => {
        expect(recorderExitHint('exit code 1')).toBe('');
    });
});
