import * as vscode from 'vscode';
import type { WorkerAnswer, WorkerController, WorkerRequest } from './workerController';

/** One task-control call against the active tab, the target voice control is bound to (design §5.12). */
export type WorkerControlCall =
    | { action: 'activeTask' }
    | { action: 'send'; text: string; when: 'now' | 'after'; includeEditorContext?: boolean }
    | { action: 'abort' }
    | { action: 'status' }
    | { action: 'pendingRequests' }
    | { action: 'answer'; requestId: string; answer: WorkerAnswer };

/**
 * `oh-my-pi-chater.voiceAgent.workerControl` (internal, scriptable) runs one call and returns its result.
 * `oh-my-pi-chater.voiceAgent.debugWorkerControl` (palette) builds the call through QuickPicks.
 */
export function registerWorkerControlCommands(
    controller: WorkerController,
    output: vscode.OutputChannel,
): vscode.Disposable[] {
    const run = async (call: WorkerControlCall): Promise<unknown> => {
        const task = controller.activeTask();
        if (!task) {
            throw new Error('No chat tab');
        }
        let result: unknown;
        switch (call.action) {
            case 'activeTask':
                result = task;
                break;
            case 'send':
                result = await controller.send(task.tabId, call.text, {
                    when: call.when,
                    includeEditorContext: call.includeEditorContext,
                });
                break;
            case 'abort':
                await controller.abort(task.tabId);
                result = 'aborted';
                break;
            case 'status':
                result = controller.status(task.tabId);
                break;
            case 'pendingRequests':
                result = controller.pendingRequests(task.tabId);
                break;
            case 'answer':
                result = controller.answer(task.tabId, call.requestId, call.answer);
                break;
        }
        output.appendLine(`[worker-control] ${task.tabId} ${JSON.stringify(call)} → ${JSON.stringify(result)}`);
        return result;
    };

    return [
        vscode.commands.registerCommand('oh-my-pi-chater.voiceAgent.workerControl', run),
        vscode.commands.registerCommand('oh-my-pi-chater.voiceAgent.debugWorkerControl', async () => {
            try {
                const call = await pickCall(controller);
                if (!call) {
                    return;
                }
                const result = await run(call);
                void vscode.window.showInformationMessage(`${call.action}: ${JSON.stringify(result)}`);
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                output.appendLine(`[worker-control] error: ${message}`);
                void vscode.window.showErrorMessage(`Worker control: ${message}`);
            }
        }),
    ];
}

async function pickCall(controller: WorkerController): Promise<WorkerControlCall | undefined> {
    const task = controller.activeTask();
    if (!task) {
        throw new Error('No chat tab');
    }
    const requests = controller.pendingRequests(task.tabId);
    const actions: Array<vscode.QuickPickItem & { id: string }> = [
        { id: 'now', label: 'Tell worker', description: 'new task when idle, steer when busy' },
        { id: 'after', label: 'Tell worker after current task', description: 'new task when idle, queue when busy' },
        { id: 'nowEditor', label: 'Tell worker with editor selection', description: 'as "Tell worker" + file/selection' },
        { id: 'abort', label: 'Stop worker' },
        { id: 'status', label: 'Worker status' },
        { id: 'answer', label: `Answer worker request (${requests.length} pending)` },
    ];
    const action = await vscode.window.showQuickPick(actions, {
        title: `Worker control: ${task.name} (${task.backend}, ${task.tabId})`,
    });
    if (!action) {
        return undefined;
    }
    switch (action.id) {
        case 'abort':
            return { action: 'abort' };
        case 'status':
            return { action: 'status' };
        case 'answer':
            return pickAnswer(requests);
        default: {
            const text = await vscode.window.showInputBox({ title: action.label, prompt: 'Instruction for the worker' });
            if (!text) {
                return undefined;
            }
            return {
                action: 'send',
                text,
                when: action.id === 'after' ? 'after' : 'now',
                includeEditorContext: action.id === 'nowEditor',
            };
        }
    }
}

async function pickAnswer(requests: WorkerRequest[]): Promise<WorkerControlCall | undefined> {
    if (requests.length === 0) {
        void vscode.window.showInformationMessage('The worker is not waiting on anything.');
        return undefined;
    }
    const picked = await vscode.window.showQuickPick(
        requests.map((request) => ({ request, label: `${request.method}: ${request.title ?? ''}`, detail: request.message })),
        { title: 'Pending worker requests' },
    );
    if (!picked) {
        return undefined;
    }
    const { request } = picked;
    let answer: WorkerAnswer | undefined;
    if (request.method === 'confirm') {
        const choice = await vscode.window.showQuickPick(['Yes', 'No', 'Cancel request'], { title: picked.label });
        answer = choice === undefined ? undefined : choice === 'Cancel request' ? { cancelled: true } : { confirmed: choice === 'Yes' };
    } else if (request.method === 'select') {
        const choice = await vscode.window.showQuickPick([...(request.options ?? []), 'Cancel request'], { title: picked.label });
        answer = choice === undefined ? undefined : choice === 'Cancel request' ? { cancelled: true } : { value: choice };
    } else {
        const value = await vscode.window.showInputBox({ title: picked.label, prompt: 'Empty cancels the request' });
        answer = value === undefined ? undefined : value ? { value } : { cancelled: true };
    }
    return answer && { action: 'answer', requestId: request.id, answer };
}
