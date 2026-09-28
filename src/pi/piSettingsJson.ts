import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentBackend } from './agentBackend';
import { getPiAgentDir } from './piCliPaths';

export interface PiSettingsJson {
    defaultProvider?: string;
    defaultModel?: string;
    defaultThinkingLevel?: string;
    packages?: string[];
    extensions?: string[];
    skills?: string[];
    enableSkillCommands?: boolean;
    steeringMode?: 'all' | 'one-at-a-time';
    followUpMode?: 'all' | 'one-at-a-time';
    [key: string]: unknown;
}

/** `<agent dir>/settings.json` of `backend`, else of the window's backend. */
function settingsPath(backend?: AgentBackend): string {
    return path.join(getPiAgentDir(backend), 'settings.json');
}

export function readPiSettingsJson(backend?: AgentBackend): PiSettingsJson {
    const filePath = settingsPath(backend);
    if (!fs.existsSync(filePath)) {
        return {};
    }
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8')) as PiSettingsJson;
    } catch {
        return {};
    }
}

export function writePiSettingsJson(mutator: (current: PiSettingsJson) => PiSettingsJson): void {
    const filePath = settingsPath();
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });

    const current = readPiSettingsJson();
    const next = mutator({ ...current });
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, filePath);
}

export function getPiPackagesFromSettings(): string[] {
    const raw = readPiSettingsJson().packages ?? [];
    return raw.map((p) => (typeof p === 'string' ? p : String((p as { source?: string }).source ?? p)));
}

export function readPiCliSettingsSummary(): {
    defaultProvider?: string;
    defaultModel?: string;
    defaultThinkingLevel?: string;
    packageCount: number;
    extensionCount: number;
} {
    const settings = readPiSettingsJson();
    const packages = getPiPackagesFromSettings();
    const extensions = settings.extensions ?? [];
    return {
        defaultProvider: settings.defaultProvider,
        defaultModel: settings.defaultModel,
        defaultThinkingLevel: settings.defaultThinkingLevel,
        packageCount: packages.length,
        extensionCount: extensions.length,
    };
}
