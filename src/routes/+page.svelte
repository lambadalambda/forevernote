<script lang="ts">
	import { invalidate } from '$app/navigation';
	import NoteEditor from '$lib/components/NoteEditor.svelte';
	import NoteList from '$lib/components/NoteList.svelte';
	import Sidebar from '$lib/components/Sidebar.svelte';

	let { data } = $props();

	let list = $state<ReturnType<typeof NoteList>>();
	let dragging = $state(false);
	let queued = $state(0);

	const onDrop = (e: DragEvent) => {
		e.preventDefault();
		dragging = false;
		const files = [...(e.dataTransfer?.files ?? [])];
		if (files.length) void list?.uploadFiles(files);
	};

	// While the worker has anything queued, refresh so new titles and tags appear on their own.
	$effect(() => {
		const id = setInterval(async () => {
			try {
				const res = await fetch('/api/status');
				const { jobs } = (await res.json()) as { jobs: { pending: number; running: number } };
				const outstanding = jobs.pending + jobs.running;
				if (outstanding !== queued) {
					queued = outstanding;
					await invalidate('app:data');
				}
			} catch {
				/* transient; the next tick retries */
			}
		}, 4000);
		return () => clearInterval(id);
	});
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="app"
	class:dragging
	ondragover={(e) => {
		e.preventDefault();
		dragging = true;
	}}
	ondragleave={(e) => {
		if (!e.relatedTarget) dragging = false;
	}}
	ondrop={onDrop}
>
	<Sidebar notebooks={data.notebooks} tags={data.tags} filter={data.filter} />
	<NoteList
		bind:this={list}
		notes={data.notes}
		selectedId={data.note?.id}
		notebookId={data.filter.notebookId}
		trashed={data.filter.trashed}
	/>
	{#if data.note}
		{#key data.note.id}
			<NoteEditor note={data.note} notebooks={data.notebooks} />
		{/key}
	{:else}
		<div class="editor">
			<p class="empty">Select a note, or drop a file anywhere to file it.</p>
		</div>
	{/if}

	{#if queued > 0}
		<div class="queue-badge">Reading {queued} {queued === 1 ? 'item' : 'items'}…</div>
	{/if}
	{#if dragging}
		<div class="drop-overlay">Drop files to file them as notes</div>
	{/if}
</div>
