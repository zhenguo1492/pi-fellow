import * as vscode from 'vscode';
import type { VoiceSettings } from '../shared/protocol';

let _verifiedSttUrl: string | null = null;
const _sttValidityListeners = new Set<(valid: boolean) => void>();

function validFor(url: string): boolean {
    if (_verifiedSttUrl !== null && _verifiedSttUrl !== url) {
        setSttValid(false);
    }
    return _verifiedSttUrl !== null;
}

export function isSttValid(): boolean {
    const url = vscode.workspace.getConfiguration('oh-my-pi-chater.voice').get<string>('sttUrl', '').trim();
    return validFor(url);
}

export function setSttValid(valid: boolean): void {
    const url = valid ? vscode.workspace.getConfiguration('oh-my-pi-chater.voice').get<string>('sttUrl', '').trim() : '';
    const next = url || null;
    const wasValid = _verifiedSttUrl !== null;
    _verifiedSttUrl = next;
    if (wasValid !== (next !== null)) {
        for (const listener of _sttValidityListeners) {
            try {
                listener(next !== null);
            } catch {
                // Ignore listener exceptions
            }
        }
    }
}

export function onSttValidityChange(listener: (valid: boolean) => void): vscode.Disposable {
    _sttValidityListeners.add(listener);
    return {
        dispose: () => {
            _sttValidityListeners.delete(listener);
        },
    };
}

/** `oh-my-pi-chater.voice.*` — defaults mirror package.json. */
export function readVoiceSettings(): VoiceSettings {
    const config = vscode.workspace.getConfiguration('oh-my-pi-chater.voice');
    const sttUrl = config.get<string>('sttUrl', '').trim();
    return {
        sttUrl,
        sttModel: config.get<string>('sttModel', '').trim(),
        language: config.get<string>('language', '').trim(),
        vadConfidence: config.get<number>('vadConfidence', 0.5),
        vadStopSecs: config.get<number>('vadStopSecs', 0.8),
        sttValid: validFor(sttUrl),
    };
}

