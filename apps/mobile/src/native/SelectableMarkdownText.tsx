import type { SelectableMarkdownTextProps } from "@helmcode/mobile-markdown-text/renderer";

type MobileSelectableMarkdownTextProps = Omit<SelectableMarkdownTextProps, "highlightCode">;

export type {
  NativeMarkdownTextStyle,
  SelectableMarkdownSkill,
} from "@helmcode/mobile-markdown-text/types";

export function hasNativeSelectableMarkdownText(): boolean {
  return false;
}

export function SelectableMarkdownText(_props: MobileSelectableMarkdownTextProps) {
  return null;
}
