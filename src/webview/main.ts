import type { ServerMessage } from '../shared/protocol';
import { installToolViewInteractions } from './toolView';
import { botSentences, mountVoicePanel } from './voicePanel';
import { installSentenceActions } from './sentenceActions';
import { chatSentences } from './chat/sentenceSurface';
import { vscode } from './vscodeApi';
import { resendUserMessage, startComposerEdit } from './chat/composer';
import { botHost, render } from './chat/layout';
import { installMessageActions } from './chat/messageActions';
import { handleMessage } from './chat/messageHandler';

mountVoicePanel(botHost);
installSentenceActions([botSentences, chatSentences]);

window.addEventListener('message', (event) => {
    handleMessage(event.data as ServerMessage);
});

installToolViewInteractions((filePath) => vscode.postMessage({ type: 'openFile', filePath }));
installMessageActions({ editUserMessage: startComposerEdit, resendUserMessage });

render();
