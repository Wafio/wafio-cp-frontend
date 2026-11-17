import { toast } from '#lib/stores/toast.js';

/** Copies text with a toast; tells the operator to copy by hand when the browser refuses. */
export async function copyWithToast(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied.`);
  } catch {
    toast.error('The browser did not allow copying. Select the text and copy it manually.', 'Not copied');
  }
}
