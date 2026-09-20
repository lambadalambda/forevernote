<script lang="ts">
	import { goto, invalidate } from '$app/navigation';
	import { page } from '$app/state';
	import type { NoteSummary } from '$lib/server/notes';
	import { createNote, intakeFiles } from '$lib/client/api';
	import { formatDate, withParams } from '$lib/client/url';

	interface Props {
		notes: NoteSummary[];
		selectedId: number | undefined;
		notebookId: number | undefined;
		trashed: boolean;
	}
	let { notes, selectedId, notebookId, trashed }: Props = $props();

	let uploading = $state(false);
	let uploadError = $state('');
	let fileInput = $state<HTMLInputElement>();

	const newNote = async () => {
		const { id } = await createNote(notebookId);
		await goto(withParams(page.url.search, { note: id, view: null, tag: null, q: null }));
	};

	/** Each dropped file becomes its own note; we open the first one. */
	export const uploadFiles = async (files: File[]) => {
		if (!files.length || uploading) return;
		uploading = true;
		uploadError = '';
		try {
			const created = await intakeFiles(files, notebookId);
			await invalidate('app:data');
			if (created[0]) await goto(withParams(page.url.search, { note: created[0].id, q: null }));
		} catch (e) {
			uploadError = (e as Error).message;
		} finally {
			uploading = false;
		}
	};

	const onPick = (e: Event) => {
		const input = e.currentTarget as HTMLInputElement;
		void uploadFiles([...(input.files ?? [])]).then(() => (input.value = ''));
	};
</script>

<section class="list">
	<div class="header">
		<span>{notes.length} {notes.length === 1 ? 'note' : 'notes'}</span>
		{#if !trashed}
			<span class="actions">
				<input
					type="file"
					multiple
					bind:this={fileInput}
					onchange={onPick}
					style="display:none"
					aria-hidden="true"
				/>
				<button onclick={() => fileInput?.click()} disabled={uploading}>
					{uploading ? 'Uploading…' : '↑ Upload'}
				</button>
				<button onclick={newNote}>+ New note</button>
			</span>
		{/if}
	</div>
	{#if uploadError}
		<p class="upload-note error">{uploadError}</p>
	{/if}
	{#if notes.length === 0}
		<p class="empty">Nothing here.</p>
	{/if}
	<ul>
		{#each notes as note (note.id)}
			<li>
				<a
					href={withParams(page.url.search, { note: note.id })}
					class:active={note.id === selectedId}
				>
					<div class="title">{note.title || 'Untitled'}</div>
					{#if note.snippet}
						<div class="snippet">{note.snippet}</div>
					{/if}
					<div class="date">{formatDate(note.updated)}</div>
				</a>
			</li>
		{/each}
	</ul>
</section>
