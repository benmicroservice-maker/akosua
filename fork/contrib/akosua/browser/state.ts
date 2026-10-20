/* Akosua — shared view binding (avoids a view<->contribution import cycle). */
import type { AkosuaChatViewPane } from './akosuaView.js';
let view: AkosuaChatViewPane | undefined;
export function bindAkosuaView(v: AkosuaChatViewPane): void { view = v; }
export function akosuaView(): AkosuaChatViewPane | undefined { return view; }

import type { AkosuaBrainViewPane } from './brainView.js';
let brain: AkosuaBrainViewPane | undefined;
export function bindBrainView(v: AkosuaBrainViewPane): void { brain = v; }
export function akosuaBrainView(): AkosuaBrainViewPane | undefined { return brain; }
