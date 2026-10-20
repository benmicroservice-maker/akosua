/*---------------------------------------------------------------------------------------------
 *  Akosua — native chat view (DESIGN.md UI-2). A real workbench ViewPane in
 *  the Secondary Sidebar: phase stepper, streaming rich text, tool cards,
 *  plan gate, composer, working indicator. Talks to the agent (still hosted
 *  by the bundled extension during migration, see NATIVE_NOT_EXTENSION.md)
 *  through workbench commands:
 *    -> akosua.agent.send {text} · akosua.agent.cancel
 *    <- akosua.native.event (AgentEvent JSON, see akosua.contribution.ts)
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
import { el, codicon, toolCard, noticeCard, planCard, changeSetCard, ToolCardHandle, formatWorked, renderMarkdownInto } from './cards.js';
import { bindAkosuaView } from './state.js';

export const AKOSUA_VIEW_ID = 'akosua.chatView';
const PHASES = ['understand', 'research', 'plan', 'build', 'verify'] as const;
const PHASE_LABEL: Record<string, string> = { understand: '1 Understand', research: '2 Research', plan: '3 Plan', build: '4 Build', verify: '5 Verify' };
/** Human verbs for tool cards — the user never reads raw tool names as prose. */
const TOOL_VERB: Record<string, [string, string]> = {
	file_editor: ['pencil', 'Edit file'], formatter: ['paintcan', 'Format on edit'], terminal: ['terminal', 'Run command'], terminal_jobs: ['server-process', 'Background job'], run_verification: ['beaker', 'Verify'],
	search_code: ['search', 'Search code'], list_files: ['folder-opened', 'List files'], semantic_search: ['sparkle', 'Semantic search'],
	project_brain: ['library', 'Project Brain'], git_checkpoint: ['git-commit', 'Checkpoint'], diagnostics: ['pulse', 'Diagnostics'],
	context7_query_docs: ['book', 'Docs lookup'], delegate_research: ['comment-discussion', 'Sub-agent research'], delegate_research_batch: ['comment-discussion', 'Parallel sub-agents'], agent_notes: ['notebook', 'Notebook'], skill: ['mortar-board', 'Skill'], firecrawl_search: ['globe', 'Web research'], firecrawl_scrape: ['globe', 'Read page'],
	youtube_search: ['play', 'YouTube search'], youtube_learn: ['play', 'YouTube learn'], package_lookup: ['package', 'Package lookup'],
};

interface AgentEventLike { type: string; phase?: string; delta?: string; name?: string; result?: string; verdict?: string; text?: string; durationMs?: number; action?: string; }

export class AkosuaChatViewPane extends ViewPane {
	private logEl!: HTMLElement;
	private stepperEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private statusEl!: HTMLElement;
	private sendBtn!: HTMLButtonElement;
	private currentText: HTMLElement | undefined;
	private currentRaw = '';
	private working = false;
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
		@IConfigurationService private readonly akosuaConfigService: IConfigurationService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		bindAkosuaView(this);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		const root = el('div', 'akosua-chat');
		// Cursor-style panel chrome: one quiet tab strip, a compact phase
		// line, the conversation, a working-status line, then ONE rounded
		// composer whose send button MORPHS into Stop while a run is live.
		const strip = el('div', 'akosua-tabstrip');
		const tab = el('span', 'akosua-tab active');
		tab.append(codicon('comment-discussion'), el('span', '', 'New Agent'));
		const gear = el('button', 'akosua-icon-btn');
		gear.append(codicon('gear'));
		gear.title = 'Akosua Settings';
		gear.addEventListener('click', () => void this.commandService.executeCommand('akosua.openSettings'));
		const brainBtn = el('button', 'akosua-icon-btn');
		brainBtn.append(codicon('library'));
		brainBtn.title = 'Project Brain (its own place — left sidebar)';
		brainBtn.addEventListener('click', () => void this.commandService.executeCommand('akosua.focusBrain'));
		const flagBtn = el('button', 'akosua-icon-btn');
		flagBtn.append(codicon('flag'));
		flagBtn.title = 'Mark issue in flight log (pins a note into the diagnostics timeline)';
		flagBtn.addEventListener('click', () => void this.commandService.executeCommand('akosua.diagnostics.markIssue'));
		const diagBtn = el('button', 'akosua-icon-btn');
		diagBtn.append(codicon('pulse'));
		diagBtn.title = 'Export diagnostics bundle (.akosua/diagnostics — share it with the developers; no API keys inside)';
		diagBtn.addEventListener('click', () => void this.commandService.executeCommand('akosua.diagnostics.export'));
		strip.append(tab, el('span', 'akosua-tab-spacer'), flagBtn, diagBtn, brainBtn, gear);
		this.stepperEl = el('div', 'akosua-stepper');
		this.renderStepper('understand');
		this.logEl = el('div', 'akosua-log');
		this.logEl.appendChild(noticeCard('info', 'Describe the task. Akosua understands your codebase, checks live docs, and stops for your plan approval before editing anything.'));
		this.statusEl = el('div', 'akosua-working hidden');
		const composer = el('div', 'akosua-composer');
		this.inputEl = document.createElement('textarea');
		this.inputEl.placeholder = 'Plan, Build, / for skills, @ for context';
		this.inputEl.rows = 3;
		this.inputEl.addEventListener('keydown', e => {
			if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void this.onPrimaryAction(); }
		});
		const crow = el('div', 'akosua-composer-row');
		const modeChip = el('span', 'akosua-chip-static');
		modeChip.append(codicon('infinity'), el('span', '', 'Agent'));
		const model = String(this.akosuaConfigService.getValue<string>('akosua.plannerModel') ?? '').trim();
		const provider = String(this.akosuaConfigService.getValue<string>('akosua.plannerProvider') ?? '').trim();
		const modelChip = el('button', 'akosua-chip-btn', model ? model : 'Set model in Settings');
		modelChip.title = 'Model routing lives in Akosua Settings';
		modelChip.addEventListener('click', () => void this.commandService.executeCommand('akosua.openSettings'));
		this.sendBtn = el('button', 'akosua-send-btn') as HTMLButtonElement;
		this.sendBtn.append(codicon('arrow-up'));
		this.sendBtn.title = 'Send (Enter)';
		this.sendBtn.addEventListener('click', () => void this.onPrimaryAction());
		crow.append(modeChip, modelChip, el('span', 'akosua-tab-spacer'), this.sendBtn);
		composer.append(this.inputEl, crow);
		root.append(strip, this.stepperEl, this.logEl, this.statusEl, composer);
		void provider;
		container.appendChild(root);
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
	}

	/** Send morphs to Stop while working (Cursor/Claude-Code pattern):
	 * the SAME button tells the truth about the run's state. */
	private setWorking(on: boolean, label?: string): void {
		this.working = on;
		this.sendBtn.textContent = '';
		this.sendBtn.append(codicon(on ? 'debug-stop' : 'arrow-up'));
		this.sendBtn.title = on ? 'Stop the current run' : 'Send (Enter)';
		this.sendBtn.classList.toggle('working', on);
		this.statusEl.textContent = '';
		if (on) {
			this.statusEl.append(codicon('sync~spin'), el('span', '', label ?? 'Akosua is working…'));
			this.statusEl.classList.remove('hidden');
		} else this.statusEl.classList.add('hidden');
	}

	private async onPrimaryAction(): Promise<void> {
		if (this.working) { await this.commandService.executeCommand('akosua.agent.cancel'); return; }
		await this.send();
	}

	private renderStepper(active: string): void {
		this.stepperEl.textContent = ''; // Trusted Types: innerHTML is blocked in the workbench
		const activeIdx = PHASES.indexOf(active as typeof PHASES[number]);
		PHASES.forEach((p, i) => {
			const s = el('span', `step${p === active ? ' active' : i < activeIdx ? ' done' : ''}`, PHASE_LABEL[p]);
			this.stepperEl.appendChild(s);
			if (i < PHASES.length - 1) this.stepperEl.appendChild(el('span', 'arrow', '→'));
		});
	}

	/** Streaming text lands as plain text; when the bubble closes it is
	 * re-rendered as rich markdown (headings/bold/bullets/code) with real
	 * DOM nodes — never innerHTML. */
	private finalizeText(): void {
		if (this.currentText && this.currentRaw && /(^|\n)\s*(#{1,3}\s|[-*]\s)|(\*\*[^*]+\*\*)|(```)/.test(this.currentRaw)) {
			renderMarkdownInto(this.currentText, this.currentRaw);
			this.currentText.classList.add('akosua-rich');
		}
		this.currentText = undefined;
		this.currentRaw = '';
	}

	private async send(): Promise<void> {
		const text = this.inputEl.value.trim();
		if (!text) return;
		this.inputEl.value = '';
		const mine = el('div', 'akosua-msg user', text);
		this.logEl.appendChild(mine);
		this.finalizeText();
		this.setWorking(true, 'Akosua is working…');
		try {
			await this.commandService.executeCommand('akosua.agent.send', { text });
		} catch (e) {
			this.setWorking(false);
			this.logEl.appendChild(noticeCard('error', `Agent host unavailable: ${(e as Error).message}. The Akosua extension host may still be starting — try again in a moment.`));
		}
		this.scroll();
	}

	/** Entry point for akosua.native.event (registered in the contribution). */
	handleEvent(ev: AgentEventLike): void {
		switch (ev.type) {
			case 'phase': this.finalizeText(); this.renderStepper(ev.phase ?? 'understand'); if (this.working) this.setWorking(true, `Working — ${PHASE_LABEL[ev.phase ?? 'understand'] ?? ev.phase}…`); break; // new phase = new bubble
			case 'text': {
				if (!this.currentText) { this.currentText = el('div', 'akosua-msg assistant'); this.currentRaw = ''; this.logEl.appendChild(this.currentText); }
				this.currentRaw += ev.delta ?? '';
				this.currentText.textContent = this.currentRaw;
				break;
			}
			case 'tool': {
				this.finalizeText();
				const mcp = (ev.name ?? '').match(/^mcp_([^_]+)_(.+)$/);
				let [icon, verb] = mcp ? ['plug', `MCP · ${mcp[1]}: ${mcp[2].replace(/_/g, ' ')}`] : (TOOL_VERB[ev.name ?? ''] ?? ['tools', (ev.name ?? 'Tool').replace(/_/g, ' ')]);
				// file_editor is read-mostly during Understand: never label a
				// view as an edit (live screenshot looked like edits in phase 1).
				const action = ev.action ?? '';
				if (ev.name === 'file_editor') { verb = action.startsWith('view') ? 'Read file' : 'Edit file'; icon = action.startsWith('view') ? 'book' : 'pencil'; }
				if (ev.name === 'delegate_research' || ev.name === 'delegate_research_batch') icon = 'comment-discussion';
				const firstLine = (ev.result ?? '').split('\n')[0].slice(0, 90);
				const { root, handle } = toolCard(icon, verb, firstLine);
				handle.setBody(ev.result ?? '');
				handle.setDone(!(ev.result ?? '').startsWith('Blocked'), ev.durationMs);
				this.logEl.appendChild(root);
				break;
			}
			case 'review':
				this.finalizeText();
				void this.commandService.executeCommand('akosua.diagnostics.uiEvent', { kind: 'review', verdict: ev.verdict });
				this.logEl.appendChild(noticeCard(ev.verdict === 'approved' ? 'info' : 'warn',
					`Cross-model review: ${(ev.verdict ?? '').replace('_', ' ')}${ev.text ? `\n${ev.text.slice(0, 1200)}` : ''}`));
				break;
			case 'changeset':
				void this.commandService.executeCommand('akosua.diagnostics.uiEvent', { kind: 'changeset', files: ((ev as unknown as { files?: unknown[] }).files ?? []).length });
				this.logEl.appendChild(changeSetCard((ev as unknown as { files: { path: string; status: string }[] }).files ?? [],
					() => void this.commandService.executeCommand('akosua.agent.openChangeDiff'),
					() => void this.commandService.executeCommand('akosua.agent.toggleInlineDiff'),
					() => void this.commandService.executeCommand('akosua.agent.undoChanges')));
				break;
			case 'done': {
				this.finalizeText();
				this.setWorking(false);
				void this.commandService.executeCommand('akosua.diagnostics.uiEvent', { kind: 'done', phase: ev.phase });
				const worked = ev.durationMs ? `Worked for ${formatWorked(ev.durationMs)} · ` : '';
				this.logEl.appendChild(noticeCard('info', `${worked}Run finished (phase: ${ev.phase ?? 'verify'}). Review the change-set, then Keep it or Undo.`));
				break;
			}
			case 'cancelled': this.finalizeText(); this.setWorking(false); void this.commandService.executeCommand('akosua.diagnostics.uiEvent', { kind: 'cancelled', phase: ev.phase }); this.logEl.appendChild(noticeCard('warn', `Run cancelled during ${ev.phase ?? ''}. The pre-run checkpoint still lets you undo partial changes.`)); break;
			case 'plan':
				this.finalizeText();
				this.setWorking(false);
				void this.commandService.executeCommand('akosua.diagnostics.uiEvent', { kind: 'plan' });
				this.statusEl.textContent = '';
				this.statusEl.append(codicon('pause'), el('span', '', 'Waiting for your plan approval — nothing will be edited until you approve.'));
				this.statusEl.classList.remove('hidden');
				this.logEl.appendChild(planCard(ev.text ?? '',
					() => { this.statusEl.classList.add('hidden'); void this.commandService.executeCommand('akosua.agent.send', { text: 'PLAN APPROVED: proceed' }); },
					comment => { this.statusEl.classList.add('hidden'); void this.commandService.executeCommand('akosua.agent.send', { text: `PLAN CHANGES REQUESTED: ${comment}` }); }));
				break;
			default:
				if (ev.text) this.logEl.appendChild(noticeCard('info', ev.text));
		}
		this.scroll();
	}

	private scroll(): void { this.logEl.scrollTop = this.logEl.scrollHeight; }
}
