export const EXPAND_ICON_SELECTOR = ".fui-TreeItemLayout__expandIcon";

/** Extra pixels around the chevron slot (padding gutter + icon). */
export const CHEVRON_HIT_PAD_PX = 10;

const DEFAULT_INDENT_PX = 24;
const EXPAND_SLOT_PX = 24;

/** Horizontal chevron hit band (includes branch indent gutter + icon slot). */
export function computeChevronBandX(
  rowRectLeft: number,
  level: number,
  indentPx: number,
  expandIconRight: number | null,
): { left: number; right: number } {
  const left = rowRectLeft - CHEVRON_HIT_PAD_PX;
  let right = rowRectLeft + (level - 1) * indentPx + EXPAND_SLOT_PX;
  if (expandIconRight !== null) {
    right = expandIconRight;
  }
  right += CHEVRON_HIT_PAD_PX;
  return { left, right };
}

function readIndentPx(layoutRoot: HTMLElement): number {
  const styles = getComputedStyle(layoutRoot);
  const xxl = parseFloat(styles.getPropertyValue("--spacingHorizontalXXL"));
  if (Number.isFinite(xxl) && xxl > 0) return xxl;
  const guide = parseFloat(styles.getPropertyValue("--tree-guide-indent"));
  if (Number.isFinite(guide) && guide > 0) return guide;
  return DEFAULT_INDENT_PX;
}

/**
 * True when (x, y) falls in the branch indent gutter and expand chevron column.
 * Clicks here often miss `.fui-TreeItemLayout__expandIcon` because Fluent puts
 * level padding on the layout root, not on the icon node.
 */
export function isChevronAreaByGeometry(
  clientX: number,
  clientY: number,
  layoutRoot: HTMLElement,
  level: number,
): boolean {
  if (level < 1) return false;
  const rowRect = layoutRoot.getBoundingClientRect();
  if (
    clientY < rowRect.top - CHEVRON_HIT_PAD_PX ||
    clientY > rowRect.bottom + CHEVRON_HIT_PAD_PX
  ) {
    return false;
  }

  const indent = readIndentPx(layoutRoot);
  const icon = layoutRoot.querySelector(EXPAND_ICON_SELECTOR);
  let expandIconRight: number | null = null;
  if (icon instanceof HTMLElement) {
    expandIconRight = icon.getBoundingClientRect().right;
  }
  const { left: bandLeft, right: bandRight } = computeChevronBandX(
    rowRect.left,
    level,
    indent,
    expandIconRight,
  );

  return clientX >= bandLeft && clientX <= bandRight;
}

export function isChevronAreaInteraction(
  target: EventTarget | null,
  clientX: number,
  clientY: number,
  layoutRoot: HTMLElement | null,
  hasChildren: boolean,
  level: number,
): boolean {
  if (!hasChildren || !layoutRoot) return false;
  if (target instanceof HTMLElement && target.closest(EXPAND_ICON_SELECTOR)) {
    return true;
  }
  return isChevronAreaByGeometry(clientX, clientY, layoutRoot, level);
}
