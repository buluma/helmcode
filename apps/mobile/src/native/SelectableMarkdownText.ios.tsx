import {
  SelectableMarkdownText as HelmCodeSelectableMarkdownText,
  type SelectableMarkdownTextProps,
} from "@helmcode/mobile-markdown-text/renderer";

import { highlightCodeSnippet } from "../features/review/shikiReviewHighlighter";

type MobileSelectableMarkdownTextProps = Omit<SelectableMarkdownTextProps, "highlightCode">;

export type {
  NativeMarkdownTextStyle,
  SelectableMarkdownSkill,
} from "@helmcode/mobile-markdown-text/types";

export function hasNativeSelectableMarkdownText(): boolean {
  return true;
}

export function SelectableMarkdownText(props: MobileSelectableMarkdownTextProps) {
  return <HelmCodeSelectableMarkdownText {...props} highlightCode={highlightCodeSnippet} />;
}
