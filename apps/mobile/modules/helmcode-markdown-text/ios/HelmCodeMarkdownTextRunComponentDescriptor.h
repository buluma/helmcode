#pragma once

#include "HelmCodeMarkdownTextRunShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

namespace facebook::react {
using HelmCodeMarkdownTextRunComponentDescriptor = ConcreteComponentDescriptor<HelmCodeMarkdownTextRunShadowNode>;

void HelmCodeMarkdownTextRunSpec_registerComponentDescriptorsFromCodegen(
  std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
}
