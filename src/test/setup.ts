import { beforeAll, afterAll } from 'vitest';
import type { AgentSession, ModelRegistry } from '@earendil-works/pi-coding-agent';

export const TEST_MODEL_PROVIDER = 'ollama';
export const TEST_MODEL_ID = 'local/Qwen3.6-27B-Coding';

let _authStorage: any;
let _modelRegistry: ModelRegistry;
let _initialized = false;

export async function initTestInfra() {
    if (_initialized) { return { authStorage: _authStorage, modelRegistry: _modelRegistry }; }

    const { AuthStorage, ModelRegistry } = await import('@earendil-works/pi-coding-agent');
    _authStorage = AuthStorage.create();
    _modelRegistry = ModelRegistry.create(_authStorage);
    _initialized = true;
    return { authStorage: _authStorage, modelRegistry: _modelRegistry };
}

export async function createTestSession(cwd?: string): Promise<AgentSession> {
    const { createAgentSession, SessionManager } = await import('@earendil-works/pi-coding-agent');
    const { authStorage, modelRegistry } = await initTestInfra();

    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const tmpDir = cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pi-test-'));

    const sessionManager = SessionManager.create(tmpDir);
    const { session } = await createAgentSession({
        cwd: tmpDir,
        authStorage,
        modelRegistry,
        sessionManager,
    });

    const model = modelRegistry.find(TEST_MODEL_PROVIDER, TEST_MODEL_ID);
    if (model) {
        await session.setModel(model);
    } else {
        console.warn(`Test model ${TEST_MODEL_PROVIDER}/${TEST_MODEL_ID} not found in registry, using default`);
    }

    return session;
}

export function getModelRegistry(): ModelRegistry {
    if (!_modelRegistry) { throw new Error('Call initTestInfra() first'); }
    return _modelRegistry;
}

beforeAll(async () => {
    try {
        await initTestInfra();
    } catch {
        // Ignored when running unit tests without local pi-coding-agent
    }
}, 30_000);

afterAll(() => {
    _initialized = false;
});
