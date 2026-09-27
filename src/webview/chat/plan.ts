import { vscode } from '../vscodeApi';
import { escHtml } from './helpers';
import { emptyPlanMode, state } from './state';

export function updateModeSwitch(): void {
    const root = document.getElementById('mode-switch');
    if (!root) return;

    // Plan mode is the pi-plan-mode extension; omp's RPC mode has no plan-mode control.
    if (state.activeBackend !== 'pi') {
        root.style.display = 'none';
        root.innerHTML = '';
        return;
    }
    root.style.display = '';

    const pm = state.planMode ?? emptyPlanMode();
    const active = pm.enabled ? 'plan' : 'agent';
    const canImplement =
        pm.hasPlan && (pm.statusLabel === 'ready' || (!pm.enabled && pm.statusLabel === 'off'));
    const implementBtn =
        canImplement && !state.isStreaming
            ? '<button type="button" class="mode-action-btn" id="btn-implement-plan">Implement</button>'
            : '';

    const planReadyDot =
        pm.statusLabel === 'ready'
            ? '<span class="mode-ready-dot" title="Plan ready"></span>'
            : '';

    root.innerHTML = `
        <div class="mode-switch-row">
            <div class="mode-segment" role="tablist" aria-label="Agent mode">
                <button type="button" class="mode-segment-btn ${active === 'agent' ? 'active' : ''}" data-mode="agent">Agent</button>
                <button type="button" class="mode-segment-btn ${active === 'plan' ? 'active' : ''}" data-mode="plan">
                    <span class="mode-segment-label">Plan</span>${planReadyDot}
                </button>
            </div>
            ${implementBtn}
        </div>
    `;

    root.querySelectorAll('[data-mode]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const mode = (btn as HTMLButtonElement).dataset.mode as 'agent' | 'plan';
            const pm = state.planMode ?? emptyPlanMode();
            if ((mode === 'plan') === pm.enabled) return;
            root.classList.add('mode-switch--pending');
            root.querySelectorAll('[data-mode]').forEach((b) => {
                (b as HTMLButtonElement).disabled = true;
            });
            vscode.postMessage({ type: 'setAgentMode', mode });
        });
    });
    document.getElementById('btn-implement-plan')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'implementPlan' });
    });
}

/** Plan markdown/todos live in the editor; composer shows live status from Pi extension chrome. */
export function updatePlanPanel(): void {
    const panel = document.getElementById('plan-panel');
    if (!panel) return;

    const pm = state.planMode;
    const chrome = state.piExtensionChrome;
    const planWidget = chrome?.widgets.find((w) => w.key === 'plan-mode-plan');
    const widgetLines = planWidget?.lines?.filter((l) => l.trim()) ?? [];
    const planStatus = chrome?.statuses.find((s) => s.key === 'plan-mode')?.text?.trim();

    const planSupported = state.activeBackend === 'pi';
    const showHint = planSupported && pm.enabled && !pm.hasPlan && !state.isStreaming;
    const showWidget = planSupported && pm.enabled && widgetLines.length > 0;

    if (!showHint && !showWidget) {
        panel.style.display = 'none';
        panel.innerHTML = '';
        return;
    }

    panel.style.display = '';
    if (showWidget) {
        const preview = widgetLines.slice(0, 6).map((l) => escHtml(l)).join('<br>');
        const more = widgetLines.length > 6 ? `<div class="plan-panel-more">+${widgetLines.length - 6} more lines in editor</div>` : '';
        panel.innerHTML = `
            <div class="plan-panel-header">
                <span class="plan-panel-title">Plan</span>
                <span class="plan-panel-status">${escHtml(planStatus || (pm.statusLabel === 'ready' ? 'Ready to implement' : 'In progress'))}</span>
            </div>
            <div class="plan-panel-preview">${preview}${more}</div>
            <button type="button" class="plan-panel-open" id="btn-open-plan-doc">Open plan in editor</button>
        `;
        document.getElementById('btn-open-plan-doc')?.addEventListener('click', () => {
            vscode.postMessage({ type: 'openPlanDocument' });
        });
        return;
    }

    panel.innerHTML = `
        <div class="plan-panel-header plan-panel-hint-only">
            <span class="plan-panel-title">Plan</span>
            <span class="plan-panel-status">${escHtml(planStatus || 'Exploring… When ready, the plan opens in the editor automatically.')}</span>
        </div>
    `;
}

export function updateExtensionChromeStrip(): void {
    const host = document.getElementById('extension-chrome-strip');
    if (!host) return;

    const chrome = state.piExtensionChrome;
    const belowWidgets =
        chrome?.widgets.filter(
            (w) => w.key !== 'plan-mode-plan' && w.placement === 'belowEditor' && w.lines?.length,
        ) ?? [];

    if (belowWidgets.length === 0) {
        host.style.display = 'none';
        host.innerHTML = '';
        return;
    }

    host.style.display = '';
    host.innerHTML = belowWidgets
        .map(
            (w) =>
                `<div class="extension-chrome-widget"><div class="extension-chrome-widget-title">${escHtml(w.key)}</div>${w.lines!.map((l) => `<div class="extension-chrome-widget-line">${escHtml(l)}</div>`).join('')}</div>`,
        )
        .join('');
}
