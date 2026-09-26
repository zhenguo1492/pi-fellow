/**
 * The Bot view in the bottom panel (src/voiceAgent/voicePanelView.ts): the voice agent's engines,
 * token use and conversation (voicePanel.ts), filling the view.
 */
import type { ServerMessage } from '../shared/protocol';
import { handleVoiceMessage, mountVoicePanel } from './voicePanel';

mountVoicePanel(document.getElementById('app')!);
window.addEventListener('message', (event: MessageEvent<ServerMessage>) => {
    if (event.data?.type === 'voice') {
        handleVoiceMessage(event.data.message);
    }
});
