import { escapeHtml } from '../../shared/html';
import { vscode } from '../vscodeApi';
import { emptyPlanMode, state } from './state';

export function updateModeSwitch(): void {
    const root = document.getElementById('mode-switch');
    if (!root) return;

    // pi's plan mode (pi-plan-mode) is switched with the composer's permission menu (Plan); the header
    // only shows that a proposed plan is ready and offers to implement it.
    const pm = state.planMode ?? emptyPlanMode();
    const canImplement =
        state.activeBackend === 'pi' && pm.hasPlan && (pm.statusLabel === 'ready' || (!pm.enabled && pm.statusLabel === 'off'));
    if (!canImplement || state.isStreaming) {
        root.style.display = 'none';
        root.innerHTML = '';
        return;
    }
    root.style.display = '';
    const planReadyDot = pm.statusLabel === 'ready' ? '<span class="mode-ready-dot" title="Plan ready"></span>' : '';
    root.innerHTML = `
        <div class="mode-switch-row">
            ${planReadyDot}
            <button type="button" class="mode-action-btn" id="btn-implement-plan" title="Leave Plan and implement the proposed plan">Implement</button>
        </div>
    `;
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
        const preview = widgetLines.slice(0, 6).map((l) => escapeHtml(l)).join('<br>');
        const more = widgetLines.length > 6 ? `<div class="plan-panel-more">+${widgetLines.length - 6} more lines in editor</div>` : '';
        panel.innerHTML = `
            <div class="plan-panel-header">
                <span class="plan-panel-title">Plan</span>
                <span class="plan-panel-status">${escapeHtml(planStatus || (pm.statusLabel === 'ready' ? 'Ready to implement' : 'In progress'))}</span>
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
            <span class="plan-panel-status">${escapeHtml(planStatus || 'Exploring… When ready, the plan opens in the editor automatically.')}</span>
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
                `<div class="extension-chrome-widget"><div class="extension-chrome-widget-title">${escapeHtml(w.key)}</div>${w.lines!.map((l) => `<div class="extension-chrome-widget-line">${escapeHtml(l)}</div>`).join('')}</div>`,
        )
        .join('');
}
