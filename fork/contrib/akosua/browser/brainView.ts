/*---------------------------------------------------------------------------------------------
 *  Akosua — Project Brain view (DESIGN.md UI-4). Shows what the engine knows
 *  about THIS workspace: detected stacks, contract map, stack-pack rules in
 *  force. Data arrives via akosua.native.brain (host computes fingerprint +
 *  contract map); refresh via akosua.agent.brainRefresh.
 *--------------------------------------------------------------------------------------------*/
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
import { el, codicon } from './cards.js';
import { bindBrainView } from './state.js';

export const AKOSUA_BRAIN_VIEW_ID = 'akosua.brainView';

export interface BrainPayload {
	fingerprintMarkdown: string;
	contractMapMarkdown: string;
	packIds: string[];
}

export class AkosuaBrainViewPane extends ViewPane {
	private bodyEl!: HTMLElement;

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
		bindBrainView(this);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		const root = el('div', 'akosua-chat');
		const bar = el('div', 'akosua-model-strip');
		bar.append(codicon('library'), el('span', '', 'Project Brain — what the agent knows about this repo'));
		const refresh = el('button', 'akosua-btn', 'Rebuild');
		refresh.addEventListener('click', () => void this.commandService.executeCommand('akosua.agent.brainRefresh'));
		bar.appendChild(refresh);
		this.bodyEl = el('div', 'akosua-log');
		this.bodyEl.appendChild(el('div', 'akosua-md', 'Brain not built yet for this workspace. Press Rebuild — fingerprinting reads manifests/lockfiles (Detect-Never-Assume).'));
		root.append(bar, this.bodyEl);
		container.appendChild(root);
		void this.commandService.executeCommand('akosua.agent.brainRefresh');
	}

	protected override layoutBody(height: number, width: number): void { super.layoutBody(height, width); }

	showBrain(payload: BrainPayload): void {
		this.bodyEl.textContent = ''; // Trusted Types: innerHTML is blocked in the workbench
		const packs = el('div', 'akosua-card');
		packs.append(codicon('shield'), el('span', 'akosua-card-title', ` Stack packs: ${payload.packIds.length ? payload.packIds.join(' · ') : 'none detected'}`));
		this.bodyEl.appendChild(packs);
		this.bodyEl.appendChild(el('div', 'akosua-md', payload.fingerprintMarkdown));
		this.bodyEl.appendChild(el('div', 'akosua-md', payload.contractMapMarkdown));
	}
}
