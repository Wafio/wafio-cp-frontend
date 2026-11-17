<!--
  CodeEditor: CodeMirror 6 for response templates, loaded on first use
  (dynamic import, its own chunk). Until it has loaded, or if it fails to
  load, a plain textarea edits the same value. `value` is bindable; outside
  changes (Clear, Insert example, Discard) are pushed into the editor.
-->
<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { theme } from '#lib/stores/theme.js';

  type Language = 'html' | 'json' | 'xml';

  let {
    value = $bindable(''),
    language = 'html',
    label,
    id = undefined,
    readonly = false,
    placeholder = undefined
  }: {
    value?: string;
    language?: Language;
    /** Accessible name of the editor. */
    label: string;
    id?: string;
    readonly?: boolean;
    placeholder?: string;
  } = $props();

  type CM = { view: any; state: any; html: any; json: any; oneDark: any; basicSetup: any; placeholder: any };

  let host = $state<HTMLDivElement>();
  let cm = $state.raw<CM | null>(null);
  let failed = $state(false);
  let view: any = null;
  let applying = false;

  let modulesPromise: Promise<CM> | null = null;
  function loadModules(): Promise<CM> {
    modulesPromise ??= Promise.all([
      import('@codemirror/view'),
      import('@codemirror/state'),
      import('@codemirror/lang-html'),
      import('@codemirror/lang-json'),
      import('@codemirror/theme-one-dark'),
      import('codemirror')
    ]).then(([viewMod, stateMod, htmlMod, jsonMod, darkMod, setupMod]) => ({
      view: viewMod.EditorView,
      state: stateMod.EditorState,
      html: htmlMod.html,
      json: jsonMod.json,
      oneDark: darkMod.oneDark,
      basicSetup: setupMod.basicSetup,
      placeholder: viewMod.placeholder
    }));
    return modulesPromise;
  }

  $effect(() => {
    loadModules().then((modules) => (cm = modules)).catch(() => (failed = true));
  });

  function lightTheme(mods: CM) {
    return mods.view.theme({
      '&': { backgroundColor: 'var(--bg-code)', color: 'var(--text-primary)' },
      '.cm-gutters': { backgroundColor: 'var(--bg-code)', color: 'var(--text-muted)', borderRight: '1px solid var(--border)' },
      '.cm-activeLine': { backgroundColor: 'var(--bg-hover)' },
      '.cm-activeLineGutter': { backgroundColor: 'var(--bg-hover)' },
      '.cm-content': { caretColor: 'var(--accent)' },
      '.cm-cursor': { borderLeftColor: 'var(--accent)' },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--accent-soft)' }
    });
  }

  // (Re)build the editor when the modules arrive or the language, theme or read-only state changes.
  $effect(() => {
    const mods = cm;
    const parent = host;
    const lang = language;
    const dark = $theme === 'dark';
    const ro = readonly;
    const hint = placeholder;
    if (!mods || !parent) return;
    const doc = untrack(() => value);
    const extensions = [
      mods.basicSetup,
      lang === 'json' ? mods.json() : mods.html(),
      dark ? mods.oneDark : lightTheme(mods),
      mods.view.lineWrapping,
      mods.view.theme({ '&': { height: '100%' }, '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono)' } }),
      mods.view.contentAttributes.of({ 'aria-label': label, ...(id ? { id } : {}) }),
      mods.state.readOnly.of(ro),
      mods.view.editable.of(!ro),
      mods.view.updateListener.of((update: { docChanged: boolean; state: { doc: { toString(): string } } }) => {
        if (update.docChanged && !applying) value = update.state.doc.toString();
      })
    ];
    if (hint) extensions.push(mods.placeholder(hint));
    view = new mods.view({ state: mods.state.create({ doc, extensions }), parent });
    return () => {
      view?.destroy();
      view = null;
    };
  });

  // Push outside changes into the editor.
  $effect(() => {
    const next = value;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === next) return;
    applying = true;
    view.dispatch({ changes: { from: 0, to: current.length, insert: next } });
    applying = false;
  });

  onDestroy(() => {
    view?.destroy();
    view = null;
  });
</script>

<div class="wp-code" class:is-readonly={readonly}>
  {#if cm && !failed}
    <div class="wp-code-host" bind:this={host}></div>
  {:else}
    <textarea
      {id}
      class="wp-code-fallback"
      aria-label={label}
      spellcheck="false"
      bind:value
      {placeholder}
      readonly={readonly}
    ></textarea>
    {#if failed}<p class="wp-code-note">The code editor could not load; editing as plain text.</p>{/if}
  {/if}
</div>

<style>
  .wp-code { display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; }
  .wp-code-host { flex: 1 1 auto; min-height: 16rem; height: 100%; border: 1px solid var(--border-strong); border-radius: var(--radius); overflow: hidden; }
  .wp-code-host:focus-within { border-color: var(--accent); box-shadow: var(--ring); }
  .wp-code-host :global(.cm-editor) { height: 100%; font-size: var(--fs-sm); }
  .wp-code-host :global(.cm-editor.cm-focused) { outline: none; }
  .wp-code-fallback {
    flex: 1 1 auto;
    width: 100%;
    min-height: 16rem;
    padding: var(--sp-3);
    background: var(--bg-code);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    line-height: 1.5;
    resize: vertical;
  }
  .wp-code-fallback:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 1px; }
  .wp-code-note { margin: var(--sp-1) 0 0; font-size: var(--fs-xs); color: var(--text-muted); }
</style>
