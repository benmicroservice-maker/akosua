/*---------------------------------------------------------------------------------------------
 *  Akosua — native chat view (DESIGN.md UI-2). A real workbench ViewPane in
 *  the Secondary Sidebar: phase stepper, streaming text, tool cards, plan
 *  gate, composer. Talks to the agent (still hosted by the bundled extension
 *  during migration) through workbench commands:
 *    -> akosua.agent.send {text} · akosua.agent.cancel
 *    <- akosua.native.event (AgentEvent JSON, see akosua.contribution.ts)
 *  At UI-6 the host moves into the fork and this view does not change.
 *--------------------------------------------------------------------------------------------*/
import './akosua.css';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { el, codicon, toolCard, noticeCard, planCard, changeSetCard, ToolCardHandle } from './cards.js';
import { bindAkosuaView } from './state.js';

export const AKOSUA_VIEW_ID = 'akosua.chatView';
const PHASES = ['understand', 'research', 'plan', 'build', 'verify'] as const;
const PHASE_LABEL: Record<string, string> = { understand: '1 Understand', research: '2 Research', plan: '3 Plan', build: '4 Build', verify: '5 Verify' };
/** Human verbs for tool cards — the user never reads raw tool names as prose. */
const TOOL_VERB: Record<string, [string, string]> = {
	file_editor: ['pencil', 'Edit file'], formatter: ['paintcan', 'Format on edit'], terminal: ['terminal', 'Run command'], run_verification: ['beaker', 'Verify'],
	search_code: ['search', 'Search code'], list_files: ['folder-opened', 'List files'], semantic_search: ['sparkle', 'Semantic search'],
	project_brain: ['library', 'Project Brain'], git_checkpoint: ['git-commit', 'Checkpoint'], diagnostics: ['pulse', 'Diagnostics'],
	context7_query_docs: ['book', 'Docs lookup'], delegate_research: ['comment-discussion', 'Delegate research'], delegate_research_batch: ['comment-discussion', 'Parallel research'], agent_notes: ['notebook', 'Notebook'], skill: ['mortar-board', 'Skill'], firecrawl_search: ['globe', 'Web research'], firecrawl_scrape: ['globe', 'Read page'],
	youtube_search: ['play', 'YouTube search'], youtube_learn: ['play', 'YouTube learn'], package_lookup: ['package', 'Package lookup'],
};

interface AgentEventLike { type: string; phase?: string; delta?: string; name?: string; result?: string; verdict?: string; text?: string; }

export class AkosuaChatViewPane extends ViewPane {
	private logEl!: HTMLElement;
	private stepperEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private currentText: HTMLElement | undefined;
	private openCards = new Map<string, { handle: ToolCardHandle; started: number }>();
	private cardSeq = 0;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		bindAkosuaView(this);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		const root = el('div', 'akosua-chat');
		const strip = el('div', 'akosua-model-strip');
		strip.append(codicon('sparkle'), el('span', '', 'Akosua agent — models & keys live in Settings → Akosua'));
		this.stepperEl = el('div', 'akosua-stepper');
		this.renderStepper('understand');
		this.logEl = el('div', 'akosua-log');
		this.logEl.appendChild(noticeCard('info', 'Open a project, then describe the task. Akosua will understand the codebase, research live docs, and stop for your plan approval before editing anything.'));
		const composer = el('div', 'akosua-composer');
		this.inputEl = document.createElement('textarea');
		this.inputEl.placeholder = 'Ask Akosua… (Enter to send, Shift+Enter for newline)';
		this.inputEl.addEventListener('keydown', e => {
			if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void this.send(); }
		});
		const row = el('div', 'akosua-composer-row');
		const sendBtn = el('button', 'akosua-btn primary', 'Send');
		sendBtn.addEventListener('click', () => void this.send());
		const stopBtn = el('button', 'akosua-btn', 'Stop');
		stopBtn.addEventListener('click', () => void this.commandService.executeCommand('akosua.agent.cancel'));
		const diffBtn = el('button', 'akosua-btn', 'Review changes');
		diffBtn.addEventListener('click', () => void this.commandService.executeCommand('akosua.agent.openChangeDiff'));
		const inlineBtn = el('button', 'akosua-btn', 'Inline diff');
		inlineBtn.addEventListener('click', () => void this.commandService.executeCommand('akosua.agent.toggleInlineDiff'));
		row.append(sendBtn, stopBtn, diffBtn, inlineBtn, el('span', 'akosua-hint', 'Phases are enforced: Understand → Research → Plan → Build → Verify'));
		composer.append(this.inputEl, row);
		root.append(strip, this.stepperEl, this.logEl, composer);
		container.appendChild(root);
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
	}

	private renderStepper(active: string): void {
		this.stepperEl.innerHTML = '';
		const activeIdx = PHASES.indexOf(active as typeof PHASES[number]);
		PHASES.forEach((p, i) => {
			const s = el('span', `step${p === active ? ' active' : i < activeIdx ? ' done' : ''}`, PHASE_LABEL[p]);
			this.stepperEl.appendChild(s);
			if (i < PHASES.length - 1) this.stepperEl.appendChild(el('span', 'arrow', '→'));
		});
	}

	private async send(): Promise<void> {
		const text = this.inputEl.value.trim();
		if (!text) return;
		this.inputEl.value = '';
		const mine = el('div', 'akosua-msg user', text);
		this.logEl.appendChild(mine);
		this.currentText = undefined;
		try {
			await this.commandService.executeCommand('akosua.agent.send', { text });
		} catch (e) {
			this.logEl.appendChild(noticeCard('error', `Agent host unavailable: ${(e as Error).message}. The Akosua extension host may still be starting — try again in a moment.`));
		}
		this.scroll();
	}

	/** Entry point for akosua.native.event (registered in the contribution). */
	handleEvent(ev: AgentEventLike): void {
		switch (ev.type) {
			case 'phase': this.renderStepper(ev.phase ?? 'understand'); break;
			case 'text': {
				if (!this.currentText) { this.currentText = el('div', 'akosua-msg assistant'); this.logEl.appendChild(this.currentText); }
				this.currentText.textContent += ev.delta ?? '';
				break;
			}
			case 'tool': {
				const mcp = (ev.name ?? '').match(/^mcp_([^_]+)_(.+)$/);
				const [icon, verb] = mcp ? ['plug', `MCP · ${mcp[1]}: ${mcp[2].replace(/_/g, ' ')}`] : (TOOL_VERB[ev.name ?? ''] ?? ['tools', (ev.name ?? 'Tool').replace(/_/g, ' ')]);
				const firstLine = (ev.result ?? '').split('\n')[0].slice(0, 90);
				const { root, handle } = toolCard(icon, verb, firstLine);
				handle.setBody(ev.result ?? '');
				handle.setDone(!(ev.result ?? '').startsWith('Blocked'), undefined);
				this.logEl.appendChild(root);
				this.currentText = undefined;
				break;
			}
			case 'review':
				this.logEl.appendChild(noticeCard(ev.verdict === 'approved' ? 'info' : 'warn',
					`Cross-model review: ${(ev.verdict ?? '').replace('_', ' ')}${ev.text ? `\n${ev.text.slice(0, 1200)}` : ''}`));
				this.currentText = undefined;
				break;
			case 'changeset':
				this.logEl.appendChild(changeSetCard((ev as unknown as { files: { path: string; status: string }[] }).files ?? [],
					() => void this.commandService.executeCommand('akosua.agent.openChangeDiff'),
					() => void this.commandService.executeCommand('akosua.agent.toggleInlineDiff')));
				break;
			case 'done': this.logEl.appendChild(noticeCard('info', `Run finished (phase: ${ev.phase ?? 'verify'}). Review the change-set, then Keep or Undo from the checkpoint.`)); break;
			case 'cancelled': this.logEl.appendChild(noticeCard('warn', `Run cancelled during ${ev.phase ?? ''}. The pre-run checkpoint still lets you undo partial changes.`)); break;
			case 'plan':
				this.logEl.appendChild(planCard(ev.text ?? '',
					() => void this.commandService.executeCommand('akosua.agent.send', { text: 'PLAN APPROVED: proceed' }),
					comment => void this.commandService.executeCommand('akosua.agent.send', { text: `PLAN CHANGES REQUESTED: ${comment}` })));
				break;
			default:
				if (ev.text) this.logEl.appendChild(noticeCard('info', ev.text));
		}
		this.scroll();
	}

	private scroll(): void { this.logEl.scrollTop = this.logEl.scrollHeight; }
}
