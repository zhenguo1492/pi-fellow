import type { PiAgentConfigData } from '../../shared/protocol';

export function emptyPiConfig(): PiAgentConfigData {
    return {
        packages: [],
        extensionPaths: [],
        skillPaths: [],
        enableSkillCommands: true,
        steeringMode: 'one-at-a-time',
        followUpMode: 'one-at-a-time',
        authProviders: [],
        mcpFileExists: false,
        commands: [],
        availableModels: [],
    };
}
