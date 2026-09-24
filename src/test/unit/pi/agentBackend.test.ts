import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { resolveAgentDir } from '../../../pi/agentBackend';

describe('agentBackend', () => {
    it('resolves pi agent directory by default', () => {
        const home = '/home/tester';
        expect(resolveAgentDir('pi', {}, home)).toBe(path.join(home, '.pi', 'agent'));
    });

    it('resolves omp agent directory by default', () => {
        const home = '/home/tester';
        expect(resolveAgentDir('omp', {}, home)).toBe(path.join(home, '.omp', 'agent'));
    });

    it('honors PI_CODING_AGENT_DIR override', () => {
        const home = '/home/tester';
        const override = '/custom/agent/dir';
        expect(resolveAgentDir('pi', { PI_CODING_AGENT_DIR: override }, home)).toBe(override);
        expect(resolveAgentDir('omp', { PI_CODING_AGENT_DIR: override }, home)).toBe(override);
    });

    it('honors omp profile overrides', () => {
        const home = '/home/tester';
        expect(resolveAgentDir('omp', { OMP_PROFILE: 'work' }, home)).toBe(
            path.join(home, '.omp', 'profiles', 'work', 'agent'),
        );
        expect(resolveAgentDir('omp', { PI_PROFILE: 'custom' }, home)).toBe(
            path.join(home, '.omp', 'profiles', 'custom', 'agent'),
        );
    });
});
