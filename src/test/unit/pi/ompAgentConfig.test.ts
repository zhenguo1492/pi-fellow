import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    readOmpConfig,
    writeOmpConfig,
    readOmpConfigSummary,
    updateOmpDefaults,
    addOmpSkillPath,
    removeOmpSkillPathAt,
    setOmpEnableSkillCommands,
    setOmpSteeringMode,
    setOmpFollowUpMode,
} from '../../../pi/ompAgentConfig';

describe('ompAgentConfig', () => {
    function createTempAgentDir(): string {
        return fs.mkdtempSync(path.join(os.tmpdir(), 'omp-test-agent-'));
    }

    it('reads empty config when config.yml does not exist', () => {
        const dir = createTempAgentDir();
        try {
            expect(readOmpConfig(dir)).toEqual({});
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('writes and reads config.yml correctly', () => {
        const dir = createTempAgentDir();
        try {
            writeOmpConfig((cfg) => {
                cfg.theme = { dark: 'titanium' };
                cfg.symbolPreset = 'unicode';
                return cfg;
            }, dir);

            const readBack = readOmpConfig(dir);
            expect(readBack.theme).toEqual({ dark: 'titanium' });
            expect(readBack.symbolPreset).toBe('unicode');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('updates omp defaults (thinkingLevel and modelRoles.default)', async () => {
        const dir = createTempAgentDir();
        try {
            updateOmpDefaults({ provider: 'anthropic', model: 'claude-sonnet-5', thinkingLevel: 'xhigh' }, dir);

            const cfg = readOmpConfig(dir);
            expect(cfg.defaultThinkingLevel).toBe('xhigh');
            expect(cfg.modelRoles?.default).toBe('anthropic/claude-sonnet-5');

            const summary = readOmpConfigSummary(dir);
            expect(summary.defaultProvider).toBe('anthropic');
            expect(summary.defaultModel).toBe('claude-sonnet-5');
            expect(summary.defaultThinkingLevel).toBe('xhigh');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('adds and removes custom skill paths', async () => {
        const dir = createTempAgentDir();
        try {
            await addOmpSkillPath('/path/to/skill1', dir);
            await addOmpSkillPath('/path/to/skill2', dir);
            // duplicate add should be no-op
            await addOmpSkillPath('/path/to/skill1', dir);

            let cfg = readOmpConfig(dir);
            expect(cfg.skills?.customDirectories).toEqual(['/path/to/skill1', '/path/to/skill2']);

            await removeOmpSkillPathAt(0, dir);
            cfg = readOmpConfig(dir);
            expect(cfg.skills?.customDirectories).toEqual(['/path/to/skill2']);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('updates steeringMode, followUpMode and enableSkillCommands', async () => {
        const dir = createTempAgentDir();
        try {
            await setOmpSteeringMode('all', dir);
            await setOmpFollowUpMode('all', dir);
            await setOmpEnableSkillCommands(false, dir);

            const cfg = readOmpConfig(dir);
            expect(cfg.steeringMode).toBe('all');
            expect(cfg.followUpMode).toBe('all');
            expect(cfg.skills?.enableSkillCommands).toBe(false);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
