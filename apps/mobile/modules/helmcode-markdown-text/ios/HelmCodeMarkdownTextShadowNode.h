#pragma once

#include <react/renderer/components/HelmCodeMarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/HelmCodeMarkdownTextSpec/Props.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>
#include <react/renderer/textlayoutmanager/TextLayoutManager.h>
#include <react/renderer/core/LayoutContext.h>
#include <react/renderer/core/ShadowNode.h>

#include <string>
#include <vector>

namespace facebook::react {

extern const char HelmCodeMarkdownTextComponentName[];

struct HelmCodeMarkdownTextParagraphStyleRange {
  size_t location;
  size_t length;
  Float firstLineHeadIndent;
  Float headIndent;
  Float paragraphSpacing;
};

struct HelmCodeMarkdownTextAttachmentRange {
  size_t location;
  size_t length;
  std::string imageUri;
};

inline Float HelmCodeMarkdownTextAttachmentSize(const HelmCodeMarkdownTextAttachmentRange &) {
  return 14;
}

inline Float HelmCodeMarkdownTextAttachmentBaselineOffset(
    const HelmCodeMarkdownTextAttachmentRange &) {
  return -2;
}

class HelmCodeMarkdownTextStateReal final {
 public:
  AttributedString attributedString;
  std::vector<HelmCodeMarkdownTextParagraphStyleRange> paragraphStyleRanges;
  std::vector<HelmCodeMarkdownTextAttachmentRange> attachmentRanges;
};

class HelmCodeMarkdownTextShadowNode final : public ConcreteViewShadowNode<
HelmCodeMarkdownTextComponentName,
HelmCodeMarkdownTextProps,
HelmCodeMarkdownTextEventEmitter,
HelmCodeMarkdownTextStateReal> {
public:
  using ConcreteViewShadowNode::ConcreteViewShadowNode;

  HelmCodeMarkdownTextShadowNode(
   const ShadowNode& sourceShadowNode,
   const ShadowNodeFragment& fragment
  );

  static ShadowNodeTraits BaseTraits() {
    auto traits = ConcreteViewShadowNode::BaseTraits();
    traits.set(ShadowNodeTraits::Trait::LeafYogaNode);
    traits.set(ShadowNodeTraits::Trait::MeasurableYogaNode);
    return traits;
  }

  void layout(LayoutContext layoutContext) override;

  Size measureContent(
      const LayoutContext& layoutContext,
      const LayoutConstraints& layoutConstraints) const override;

private:
  mutable AttributedString _attributedString;
  mutable std::vector<HelmCodeMarkdownTextParagraphStyleRange> _paragraphStyleRanges;
  mutable std::vector<HelmCodeMarkdownTextAttachmentRange> _attachmentRanges;
};
} // namespace facebook::React
