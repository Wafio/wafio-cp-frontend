<!--
  UddinCodeViewer: read-only uddin-lang source with syntax colours from the
  theme tokens (they follow light/dark by themselves). The view is rebuilt when the code changes and
  destroyed with the component; until CodeMirror has loaded, the plain source
  is shown.
-->
<script lang="ts">
  import { tick } from 'svelte';
  import type { EditorView } from '@codemirror/view';

  interface Props {
    code: string;
    maxHeight?: string;
    /** Accessible name of the code region. */
    label?: string;
  }

  let { code, maxHeight = '220px', label = 'Script source' }: Props = $props();

  let container: HTMLElement | null = $state(null);
  let ready = $state(false);
  let view: EditorView | null = null;
  // CodeMirror modules are cached after the first dynamic import.
  let mods: [typeof import('@codemirror/view'), typeof import('@codemirror/state'), typeof import('#lib/codemirror-uddin.js')] | null = null;
  let createToken = 0;

  async function createView(source: string, token: number) {
    if (!mods) {
      try {
        mods = await Promise.all([import('@codemirror/view'), import('@codemirror/state'), import('#lib/codemirror-uddin.js')]);
      } catch {
        return; // keep the plain-text fallback
      }
      await tick();
    }
    if (token !== createToken || !container) return; // superseded or unmounted
    const [viewMod, stateMod, uddinMod] = mods;
    view?.destroy();
    view = new viewMod.EditorView({
      state: stateMod.EditorState.create({
        doc: source,
        extensions: [
          ...uddinMod.uddinExtensions(),
          uddinMod.uddinEditorTheme({ fontSize: 'var(--fs-xs)' }),
          viewMod.EditorView.lineWrapping,
          viewMod.EditorView.editable.of(false),
          stateMod.EditorState.readOnly.of(true),
          viewMod.EditorView.contentAttributes.of({ 'aria-label': label }),
          viewMod.EditorView.theme({
            '.cm-content': { padding: 'var(--sp-2) var(--sp-3)', caretColor: 'transparent' },
            '.cm-cursor': { display: 'none' },
          }),
        ],
      }),
      parent: container,
    });
    ready = true;
  }

  $effect(() => {
    const source = code;
    const token = ++createToken;
    void createView(source, token);
    return () => {
      createToken++;
      view?.destroy();
      view = null;
      ready = false;
    };
  });
</script>

<div class="uddin-viewer" style="max-height: {maxHeight}">
  {#if !ready}
    <pre class="uddin-fallback" aria-label={label}>{code}</pre>
  {/if}
  <div class="uddin-host" class:hidden={!ready} bind:this={container}></div>
</div>

<style>
  .uddin-viewer {
    position: relative;
    overflow: hidden;
    background: var(--bg-code);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .uddin-host { height: 100%; }
  .uddin-host.hidden { display: none; }
  .uddin-fallback {
    margin: 0;
    padding: var(--sp-2) var(--sp-3);
    overflow: auto;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--text-secondary);
    white-space: pre-wrap;
  }
</style>
