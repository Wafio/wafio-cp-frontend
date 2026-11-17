/**
 * Row disclosure keyboard rule: Escape on an expanded row's toggle or
 * inside its detail collapses it. An Escape another control already consumed
 * (defaultPrevented), one ending an IME composition, and any Escape on a
 * collapsed row pass through (so an enclosing Modal/Drawer still closes).
 */
export function collapsesOnEscape(
  event: Pick<KeyboardEvent, 'key' | 'isComposing' | 'defaultPrevented'>,
  expanded: boolean,
): boolean {
  return event.key === 'Escape' && !event.isComposing && !event.defaultPrevented && expanded;
}
