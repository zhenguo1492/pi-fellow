import { vscode } from './settings/api';
import { registerMessageListener } from './settings/messages';

registerMessageListener();

vscode.postMessage({ type: 'getSettings' });
vscode.postMessage({ type: 'getSkills' });
vscode.postMessage({ type: 'getMcpSnapshot' });
