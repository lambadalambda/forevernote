<script lang="ts">
	import { goto, invalidate } from '$app/navigation';
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import type { Note, Notebook } from '$lib/server/notes';
	import { deleteNoteForever, fetchNote, patchNote, uploadResources } from '$lib/client/api';
	import type { NoteApiPatch } from '$lib/server/api';
	import { debounce, formatDate, withParams } from '$lib/client/url';

	interface Props {
		note: Note;
		notebooks: Notebook[];
	}
	let { note, notebooks }: Props = $props();

	let title = $state('');
	let tagsText = $state('');
	let notebookId = $state(0);
	let status = $state<'saved' | 'saving' | 'error'>('saved');
	let bodyEl: HTMLDivElement;

	// Saves are chained so two in-flight PATCHes can never land out of order.
	let queue: Promise<unknown> = Promise.resolve();
	const save = (patch: NoteApiPatch) => {
		status = 'saving';
		queue = queue
			.then(() => patchNote(note.id, patch))
			.then(() => {
				status = 'saved';
				return invalidate('app:data');
			})
			.catch((e) => {
				console.error(e);
				status = 'error';
			});
		return queue;
	};
	const flush = () => {
		saveBody.flush();
		saveTitle.flush();
	};
	const saveBody = debounce(() => save({ html: bodyEl.innerHTML }), 600);
	const saveTitle = debounce((t: string) => save({ title: t }), 600);

	// What the server last told us, so we can tell an untouched field from an edited one.
	let seededTitle = $state('');
	let seededTags = $state('');

	// The parent re-creates this component per note ({#key}), so this runs once per note:
	// seed the local editing state and flush pending saves when leaving.
	$effect(() => {
		untrack(() => {
			title = seededTitle = note.title;
			tagsText = seededTags = note.tags.join(', ');
			notebookId = note.notebookId;
			bodyEl.innerHTML = note.html;
		});
		return flush;
	});

	// The worker titles and tags an upload after the note is already open. Adopt those
	// values, but never overwrite a field the user has started editing.
	$effect(() => {
		const incomingTitle = note.title;
		const incomingTags = note.tags.join(', ');
		untrack(() => {
			if (incomingTitle !== seededTitle && title === seededTitle) title = incomingTitle;
			if (incomingTags !== seededTags && tagsText === seededTags) tagsText = incomingTags;
			seededTitle = incomingTitle;
			seededTags = incomingTags;
		});
	});

	const onCheckbox = (e: Event) => {
		const t = e.target as HTMLInputElement;
		if (t.type !== 'checkbox') return;
		t.toggleAttribute('checked', t.checked);
		saveBody();
	};
	const onTagsChange = () =>
		save({
			tags: tagsText
				.split(',')
				.map((t) => t.trim())
				.filter(Boolean)
		});
	const onNotebookChange = () => save({ notebookId });

	const exec = (cmd: string, value?: string) => {
		bodyEl.focus();
		document.execCommand(cmd, false, value);
		saveBody();
	};
	const insertTodo = () => exec('insertHTML', '<input type="checkbox" class="en-todo"> ');

	// goto() re-runs load itself, so no separate invalidate is needed after these.
	const closeNote = () => goto(withParams(page.url.search, { note: null }));
	const trash = () => patchNote(note.id, { trashed: true }).then(closeNote);
	const restore = () => save({ trashed: false });
	const destroy = async () => {
		if (!confirm('Delete this note permanently?')) return;
		await deleteNoteForever(note.id);
		await closeNote();
	};

	// The note prop is replaced by the server load; live is the newer of the two, so an
	// upload or a finished extraction shows without waiting for a navigation.
	let live = $state<Note | null>(null);
	const current = $derived(live && live.id === note.id ? live : note);

	const pdfs = $derived(current.resources.filter((r) => r.mime === 'application/pdf'));
	const others = $derived(
		current.resources.filter((r) => r.mime !== 'application/pdf' && !r.mime.startsWith('image/'))
	);
	// Scan-style notes (body is nothing but the attachment link) open in PDF view by default.
	const isScanNote = (() => {
		const text = note.snippet.trim();
		return (
			pdfs.length > 0 && (text === '' || pdfs.some((p) => text.startsWith(p.fileName ?? '\0')))
		);
	})();
	let uploading = $state(false);
	let uploadError = $state('');
	let dragging = $state(false);
	let fileInput = $state<HTMLInputElement>();

	const extracting = $derived(current.resources.some((r) => r.textState === 'pending'));

	const upload = async (files: File[]) => {
		if (!files.length) return;
		uploading = true;
		uploadError = '';
		try {
			live = await uploadResources(note.id, files);
			await invalidate('app:data');
		} catch (e) {
			uploadError = (e as Error).message;
		} finally {
			uploading = false;
		}
	};

	const onDrop = (e: DragEvent) => {
		e.preventDefault();
		dragging = false;
		if (!note.trashed) void upload([...(e.dataTransfer?.files ?? [])]);
	};

	const onPick = (e: Event) => {
		const input = e.currentTarget as HTMLInputElement;
		void upload([...(input.files ?? [])]).then(() => (input.value = ''));
	};

	// While anything is being extracted, poll so the attachment list settles on its own.
	$effect(() => {
		if (!extracting) return;
		const id = setInterval(async () => {
			try {
				live = await fetchNote(note.id);
			} catch {
				/* transient; the next tick retries */
			}
		}, 3000);
		return () => clearInterval(id);
	});

	const ocrd = $derived(current.resources.filter((r) => r.ocrText));
	let view = $state<'text' | 'pdf' | 'ocr'>(isScanNote ? 'pdf' : 'text');
	let copied = $state(false);
	const copyOcr = async () => {
		await navigator.clipboard.writeText(ocrd.map((r) => r.ocrText).join('\n\n'));
		copied = true;
		setTimeout(() => (copied = false), 1500);
	};
	const fmtSize = (n: number) =>
		n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.ceil(n / 1e3)} KB`;
</script>

<svelte:window onbeforeunload={flush} onvisibilitychange={flush} />

<article
	class="editor"
	class:dragging
	ondragover={(e) => {
		e.preventDefault();
		dragging = !note.trashed;
	}}
	ondragleave={() => (dragging = false)}
	ondrop={onDrop}
>
	<div class="meta">
		<label>
			Notebook
			<select bind:value={notebookId} onchange={onNotebookChange} disabled={note.trashed}>
				{#each notebooks as nb (nb.id)}
					<option value={nb.id}>{nb.name}</option>
				{/each}
			</select>
		</label>
		<span>Created {formatDate(note.created)}</span>
		<span>Updated {formatDate(note.updated)}</span>
		<span class="spacer"></span>
		{#if !note.trashed}
			<input
				type="file"
				multiple
				bind:this={fileInput}
				onchange={onPick}
				style="display:none"
				aria-hidden="true"
			/>
			<button onclick={() => fileInput?.click()} disabled={uploading}>
				{uploading ? 'Uploading…' : '+ Attach'}
			</button>
		{/if}
		{#if pdfs.length || ocrd.length}
			<span class="view-toggle" role="group" aria-label="View">
				<button class:active={view === 'text'} onclick={() => (view = 'text')}>Text</button>
				{#if pdfs.length}
					<button class:active={view === 'pdf'} onclick={() => (view = 'pdf')}>PDF</button>
				{/if}
				{#if ocrd.length}
					<button class:active={view === 'ocr'} onclick={() => (view = 'ocr')}>OCR</button>
				{/if}
			</span>
		{/if}
		<span class="status">
			{status === 'saving' ? 'Saving…' : status === 'error' ? 'Save failed' : 'Saved'}
		</span>
		{#if note.trashed}
			<button onclick={restore}>Restore</button>
			<button class="danger" onclick={destroy}>Delete forever</button>
		{:else}
			<button class="danger" onclick={trash}>Trash</button>
		{/if}
	</div>

	{#if uploadError}
		<p class="upload-note error">{uploadError}</p>
	{:else if dragging}
		<p class="upload-note">Drop files to attach them to this note</p>
	{:else if extracting}
		<p class="upload-note">Reading text from the new attachment, search will catch up shortly…</p>
	{/if}

	<input
		class="note-title"
		type="text"
		placeholder="Title"
		bind:value={title}
		oninput={(e) => saveTitle(e.currentTarget.value)}
		readonly={note.trashed}
	/>
	<div class="tags">
		<span>Tags</span>
		<input
			type="text"
			placeholder="comma, separated"
			bind:value={tagsText}
			onchange={onTagsChange}
			readonly={note.trashed}
		/>
	</div>

	{#if !note.trashed && view === 'text'}
		<div class="toolbar">
			<button title="Bold" onclick={() => exec('bold')}><b>B</b></button>
			<button title="Italic" onclick={() => exec('italic')}><i>I</i></button>
			<button title="Underline" onclick={() => exec('underline')}><u>U</u></button>
			<button title="Heading" onclick={() => exec('formatBlock', 'h2')}>H</button>
			<button title="Paragraph" onclick={() => exec('formatBlock', 'div')}>¶</button>
			<button title="Bullet list" onclick={() => exec('insertUnorderedList')}>• List</button>
			<button title="Numbered list" onclick={() => exec('insertOrderedList')}>1. List</button>
			<button title="Checkbox" onclick={insertTodo}>☑</button>
			<button title="Code block" onclick={() => exec('formatBlock', 'pre')}>{'</>'}</button>
		</div>
	{/if}

	<div
		class="body"
		class:hidden={view !== 'text'}
		bind:this={bodyEl}
		contenteditable={!note.trashed}
		oninput={saveBody}
		onchange={onCheckbox}
	></div>

	{#if view === 'pdf'}
		<div class="pdf-view">
			{#each pdfs as r (r.hash)}
				<div class="name">
					<a href="/api/resources/{r.hash}" target="_blank">{r.fileName ?? r.hash}</a>
					<span class="status">{fmtSize(r.size)}</span>
					<a href="/api/resources/{r.hash}?download" class="status">download</a>
				</div>
				<iframe src="/api/resources/{r.hash}" title={r.fileName ?? 'PDF'}></iframe>
			{/each}
		</div>
	{:else if view === 'ocr'}
		<div class="ocr-view">
			<div class="name">
				<span class="status">Extracted text, not editable</span>
				<span class="spacer"></span>
				<button onclick={copyOcr}>{copied ? 'Copied' : 'Copy all'}</button>
			</div>
			{#each ocrd as r (r.hash)}
				<h3>{r.fileName ?? r.hash}</h3>
				<pre>{r.ocrText}</pre>
			{/each}
		</div>
	{:else if pdfs.length || others.length}
		<div class="attachments">
			<h3>Attachments</h3>
			{#each [...pdfs, ...others] as r (r.hash)}
				<div class="item">
					<div class="name">
						{#if r.mime === 'application/pdf'}
							<button onclick={() => (view = 'pdf')}>Show PDF</button>
						{/if}
						<a href="/api/resources/{r.hash}?download">{r.fileName ?? r.hash}</a>
						<span class="status">{r.mime} · {fmtSize(r.size)}</span>
						{#if r.textState === 'pending'}
							<span class="badge">reading text…</span>
						{:else if r.textState === 'failed'}
							<span class="badge failed">text extraction failed</span>
						{:else if r.textState === 'ready'}
							<span class="badge ok">searchable</span>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</article>
