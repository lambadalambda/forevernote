<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import type { Notebook, Tag } from '$lib/server/notes';
	import { createNotebook } from '$lib/client/api';
	import { withParams } from '$lib/client/url';

	interface Props {
		notebooks: Notebook[];
		tags: Tag[];
		filter: { notebookId?: number; tagId?: number; query?: string; trashed: boolean };
	}
	let { notebooks, tags, filter }: Props = $props();

	let query = $state('');
	$effect(() => {
		query = filter.query ?? '';
	});
	let newNotebook = $state('');

	// Navigating between views clears the note selection and other filters.
	const link = (changes: Record<string, string | number | null>) =>
		withParams(page.url.search, { notebook: null, tag: null, view: null, note: null, ...changes });

	const submitSearch = (e: Event) => {
		e.preventDefault();
		goto(withParams(page.url.search, { q: query.trim() || null, note: null }), { keepFocus: true });
	};

	// The native "x" in a search field only fires input, not submit: treat an emptied box as a reset.
	const clearIfEmpty = (e: Event) => {
		if ((e.currentTarget as HTMLInputElement).value === '' && filter.query)
			goto(withParams(page.url.search, { q: null }), { keepFocus: true });
	};

	const addNotebook = async (e: Event) => {
		e.preventDefault();
		const name = newNotebook.trim();
		if (!name) return;
		const nb = await createNotebook(name);
		newNotebook = '';
		await goto(link({ notebook: nb.id }));
	};

	const allActive = $derived(
		filter.notebookId === undefined && filter.tagId === undefined && !filter.trashed
	);
	const total = $derived(notebooks.reduce((n, nb) => n + nb.noteCount, 0));
</script>

<nav class="sidebar">
	<h1>Forevernote</h1>

	<form onsubmit={submitSearch}>
		<input
			type="search"
			placeholder="Search notes…"
			bind:value={query}
			aria-label="Search"
			oninput={clearIfEmpty}
		/>
	</form>

	<ul>
		<li>
			<a href={link({})} class:active={allActive}>All notes <span class="count">{total}</span></a>
		</li>
		<li>
			<a href={link({ view: 'trash' })} class:active={filter.trashed}>Trash</a>
		</li>
	</ul>

	<div>
		<h2>Notebooks</h2>
		<ul>
			{#each notebooks as nb (nb.id)}
				<li>
					<a href={link({ notebook: nb.id })} class:active={filter.notebookId === nb.id}>
						{nb.name} <span class="count">{nb.noteCount}</span>
					</a>
				</li>
			{/each}
		</ul>
		<form onsubmit={addNotebook}>
			<input type="text" placeholder="New notebook" bind:value={newNotebook} />
			<button type="submit">+</button>
		</form>
	</div>

	{#if tags.length}
		<div>
			<h2>Tags</h2>
			<ul>
				{#each tags as tag (tag.id)}
					<li>
						<a href={link({ tag: tag.id })} class:active={filter.tagId === tag.id}>
							{tag.name} <span class="count">{tag.noteCount}</span>
						</a>
					</li>
				{/each}
			</ul>
		</div>
	{/if}
</nav>
