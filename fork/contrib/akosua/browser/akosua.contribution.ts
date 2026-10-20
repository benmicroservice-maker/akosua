/*---------------------------------------------------------------------------------------------
 *  Akosua — workbench contribution registration (DESIGN.md UI-2).
 *  Registers: Akosua view container in the Secondary Sidebar (AuxiliaryBar),
 *  the chat view, the akosua.native.event bridge command the agent host uses
 *  to stream events into the native UI, and user-facing commands.
 *--------------------------------------------------------------------------------------------*/
import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { IViewContainersRegistry, IViewsRegistry, Extensions as ViewExtensions, ViewContainer, ViewContainerLocation } from '../../../common/views.js';
import { AkosuaChatViewPane, AKOSUA_VIEW_ID } from './akosuaView.js';
import { localize, localize2 } from '../../../../nls.js';
import { registerAction2, Action2 } from '../../../../platform/actions/common/actions.js';
import { KeyMod, KeyCode } from '../../../../base/common/keyCodes.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { akosuaView, akosuaBrainView } from './state.js';
import { AkosuaBrainViewPane, AKOSUA_BRAIN_VIEW_ID, BrainPayload } from './brainView.js';

const akosuaIcon = registerIcon('akosua-view-icon', Codicon.sparkle, localize('akosuaViewIcon', 'Akosua agent view icon.'));

const VIEW_CONTAINER: ViewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: 'akosua',
	title: localize2('akosua', 'Akosua'),
	icon: akosuaIcon,
	order: 5,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, ['akosua', { mergeViewWithContainerWhenSingleView: true }]),
	storageId: 'akosua.viewContainer',
	hideIfEmpty: false,
}, ViewContainerLocation.AuxiliaryBar, { isDefault: true, doNotRegisterOpenCommand: false });

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
	id: AKOSUA_VIEW_ID,
	name: localize2('akosuaChat', 'Chat'),
	containerIcon: akosuaIcon,
	canToggleVisibility: true,
	canMoveView: true,
	ctorDescriptor: new SyncDescriptor(AkosuaChatViewPane),
}], VIEW_CONTAINER);

// Project Brain gets its OWN container in the Primary (left) Sidebar:
// chat owns the entire Secondary Sidebar so the conversation is never
// squeezed by Brain content stacked in the same place.
const BRAIN_CONTAINER: ViewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: 'akosuaBrain',
	title: localize2('akosuaBrain', 'Akosua Brain'),
	icon: registerIcon('akosua-brain-icon', Codicon.library, localize('akosuaBrainIcon', 'Akosua Project Brain icon.')),
	order: 6,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, ['akosuaBrain', { mergeViewWithContainerWhenSingleView: true }]),
	storageId: 'akosua.brainViewContainer',
	hideIfEmpty: false,
}, ViewContainerLocation.Sidebar, { isDefault: true, doNotRegisterOpenCommand: false });

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
	id: AKOSUA_BRAIN_VIEW_ID,
	name: localize2('akosuaBrainView', 'Project Brain'),
	containerIcon: akosuaIcon,
	canToggleVisibility: true,
	canMoveView: true,
	ctorDescriptor: new SyncDescriptor(AkosuaBrainViewPane),
}], BRAIN_CONTAINER);

/** Bridge: the agent host streams AgentEvents here (akosua.native.event);
 * routed to the chat view instance via state.ts. */

class NativeEventCommand extends Action2 {
	constructor() {
		super({ id: 'akosua.native.event', title: localize('akosuaNativeEvent', 'Akosua: native event (internal)') });
	}
	override async run(_accessor: ServicesAccessor, event: unknown): Promise<void> {
		akosuaView()?.handleEvent(event as never);
	}
}
registerAction2(NativeEventCommand);

class FocusChatCommand extends Action2 {
	constructor() {
		super({ id: 'akosua.focusChat', title: localize2('akosuaFocusChat', 'Akosua: Focus Chat'), keybinding: { primary: KeyMod.CtrlCmd | KeyCode.KeyL, weight: 200 } });
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IViewsService).openView(AKOSUA_VIEW_ID, true);
	}
}
registerAction2(FocusChatCommand);
registerAction2(class extends Action2 {
	constructor() { super({ id: 'akosua.focusBrain', title: localize2('akosuaFocusBrain', 'Akosua: Focus Project Brain') }); }
	override async run(accessor: ServicesAccessor): Promise<void> { await accessor.get(IViewsService).openView(AKOSUA_BRAIN_VIEW_ID, true); }
});

class NativeBrainCommand extends Action2 {
	constructor() {
		super({ id: 'akosua.native.brain', title: localize('akosuaNativeBrain', 'Akosua: native brain (internal)') });
	}
	override async run(_accessor: ServicesAccessor, payload: unknown): Promise<void> {
		const p = payload as { type?: string; text?: string; message?: string } & BrainPayload;
		// Tagged brain events get honest UI states; a bare BrainPayload
		// (legacy call shape) is treated as a completed rebuild.
		if (p?.type === 'brainLoading') { akosuaBrainView()?.showLoading(p.message); return; }
		if (p?.type === 'brainError') { akosuaBrainView()?.showError(p.text ?? 'Rebuild failed.'); return; }
		akosuaBrainView()?.showBrain(payload as BrainPayload);
	}
}
registerAction2(NativeBrainCommand);
