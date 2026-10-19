/*---------------------------------------------------------------------------------------------
 *  Akosua — native chat card components (DESIGN.md §4). Pure DOM builders:
 *  no framework, VS Code colour tokens + Codicon classes only, so the panel
 *  is indistinguishable from workbench UI in every theme.
 *--------------------------------------------------------------------------------------------*/

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
	const e = document.createElement(tag);
	if (cls) e.className = cls;
	if (text !== undefined) e.textContent = text;
	return e;
}

export function codicon(name: string): HTMLElement {
	const i = el('span', `codicon codicon-${name}`);
	i.setAttribute('aria-hidden', 'true');
	return i;
}

export interface ToolCardHandle {
	setRunning(): void;
	setDone(ok: boolean, durationMs?: number): void;
	setBody(text: string): void;
}

/** Tool-call card: header (icon, human verb, target, status, duration),
 * collapsible body. Identical consecutive calls are NOT merged here — the
 * loop's repeat-guard already prevents true duplicates. */
export function toolCard(icon: string, verb: string, target: string): { root: HTMLElement; handle: ToolCardHandle } {
	const root = el('div', 'akosua-card akosua-tool-card');
	const head = el('div', 'akosua-card-head');
	const status = codicon('sync~spin');
	status.classList.add('akosua-card-status');
	const title = el('span', 'akosua-card-title', verb);
	const tgt = el('span', 'akosua-card-target', target);
	const dur = el('span', 'akosua-card-duration');
	head.append(status, title, tgt, dur);
	const body = el('pre', 'akosua-card-body hidden');
	root.append(head, body);
	head.addEventListener('click', () => body.classList.toggle('hidden'));
	// (durations come from the agent's real measurements; never faked here)
	return {
		root,
		handle: {
			setRunning() { status.className = 'codicon codicon-sync~spin akosua-card-status'; },
			setDone(ok, durationMs) {
				status.className = `codicon codicon-${ok ? 'check' : 'error'} akosua-card-status ${ok ? 'ok' : 'bad'}`;
				dur.textContent = durationMs === undefined ? '' : `${(durationMs / 1000).toFixed(1)}s`; // never show a fake 0.0s
			},
			setBody(text) {
			// Citation chips (C3): every source URL in evidence becomes a
			// visible badge — the user sees WHERE a claim came from.
			const urls = [...new Set(text.match(/https?:\/\/[^\s)'"]+/g) ?? [])].slice(0, 6);
			if (urls.length) {
				const chips = el('div', 'akosua-chips');
				for (const u of urls) chips.appendChild(el('span', 'akosua-chip', u.replace(/^https?:\/\//, '').slice(0, 42)));
				body.before(chips);
			}
			body.textContent = text.length > 4000 ? `${text.slice(0, 4000)}\n…[truncated in view — full output in Akosua Runs]` : text; },
		},
	};
}

export function noticeCard(kind: 'info' | 'warn' | 'error', text: string): HTMLElement {
	const root = el('div', `akosua-card akosua-notice ${kind}`);
	root.append(codicon(kind === 'error' ? 'error' : kind === 'warn' ? 'warning' : 'info'), el('span', '', text));
	return root;
}

/** Plan gate card (DESIGN §4.2): the plan as an artifact with actions. */
export function planCard(markdown: string, onApprove: () => void, onRequestChanges: (comment: string) => void): HTMLElement {
	const root = el('div', 'akosua-card akosua-plan-card');
	const head = el('div', 'akosua-card-head');
	head.append(codicon('checklist'), el('span', 'akosua-card-title', 'Implementation plan — your approval gates all edits'));
	root.append(head);
	const body = el('div', 'akosua-md', markdown);
	root.append(body);
	const actions = el('div', 'akosua-card-actions');
	const approve = el('button', 'akosua-btn primary', 'Approve & Build');
	approve.addEventListener('click', () => { approve.setAttribute('disabled', 'true'); onApprove(); });
	const comment = document.createElement('textarea');
	comment.className = 'akosua-comment';
	comment.placeholder = 'Request changes… (feeds back without restarting the run)';
	const request = el('button', 'akosua-btn', 'Request changes');
	request.addEventListener('click', () => onRequestChanges(comment.value.trim()));
	actions.append(approve, request);
	root.append(actions, comment);
	return root;
}

export function formatWorked(ms: number): string {
	const s = Math.round(ms / 1000);
	return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

/** Lightweight, Trusted-Types-safe markdown: headings, bullets, bold and
 * code fences rendered with real DOM nodes (never innerHTML). Enough for
 * agent answers to read like Cursor's instead of one raw text blob. */
export function renderMarkdownInto(root: HTMLElement, md: string): void {
	root.textContent = '';
	let inFence = false; let fence: HTMLElement | undefined;
	const inline = (parent: HTMLElement, line: string): void => {
		const parts = line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
		for (const p of parts) {
			if (p.startsWith('**') && p.endsWith('**')) { const b = el('strong', '', p.slice(2, -2)); parent.appendChild(b); }
			else if (p.startsWith('`') && p.endsWith('`')) { const c = el('code', 'akosua-inline-code', p.slice(1, -1)); parent.appendChild(c); }
			else parent.appendChild(document.createTextNode(p));
		}
	};
	for (const raw of md.split('\n')) {
		const line = raw.trimEnd();
		if (line.startsWith('```')) { inFence = !inFence; fence = inFence ? el('pre', 'akosua-code') : undefined; if (fence) root.appendChild(fence); continue; }
		if (inFence && fence) { fence.textContent += (fence.textContent ? '\n' : '') + line; continue; }
		if (!line.trim()) continue;
		const h = line.match(/^(#{1,3})\s+(.*)/);
		if (h) { const hd = el('div', 'akosua-md-h', h[2]); root.appendChild(hd); continue; }
		const li = line.match(/^\s*[-*]\s+(.*)/);
		if (li) { const row = el('div', 'akosua-md-li'); row.appendChild(el('span', 'akosua-md-dot', '• ')); inline(row, li[1]); root.appendChild(row); continue; }
		const p = el('div', 'akosua-md-p'); inline(p, line); root.appendChild(p);
	}
}

/** Change-set summary card (UI-3): what changed, per file, with review actions. */
export function changeSetCard(files: { path: string; status: string }[], onReview: () => void, onInline: () => void, onUndo?: () => void): HTMLElement {
	const root = el('div', 'akosua-card akosua-plan-card');
	const head = el('div', 'akosua-card-head');
	head.append(codicon('diff'), el('span', 'akosua-card-title', `Change-set — ${files.length} file${files.length === 1 ? '' : 's'} since checkpoint`));
	root.append(head);
	if (!files.length) root.appendChild(el('div', 'akosua-md', 'No tracked-file changes.'));
	for (const f of files.slice(0, 30)) {
		const row = el('div', 'akosua-changeset-row');
		row.append(el('span', 'akosua-chip', f.status), el('span', 'akosua-card-target', f.path));
		root.appendChild(row);
	}
	if (files.length > 30) root.appendChild(el('div', 'akosua-md', `…and ${files.length - 30} more (Review opens the picker).`));
	const actions = el('div', 'akosua-card-actions');
	const review = el('button', 'akosua-btn primary', 'Review changes');
	review.addEventListener('click', onReview);
	const inline = el('button', 'akosua-btn', 'Inline diff');
	inline.addEventListener('click', onInline);
	actions.append(review, inline);
	if (onUndo) {
		const undo = el('button', 'akosua-btn', 'Undo changes');
		undo.addEventListener('click', onUndo);
		actions.append(undo);
	}
	actions.append(el('span', 'akosua-hint', 'Keep = do nothing (changes stay).'));
	root.append(actions);
	return root;
}
