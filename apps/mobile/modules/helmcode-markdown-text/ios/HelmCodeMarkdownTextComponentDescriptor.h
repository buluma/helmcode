#pragma once

#include "HelmCodeMarkdownTextShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

namespace facebook::react {
using HelmCodeMarkdownTextComponentDescriptor = ConcreteComponentDescriptor<HelmCodeMarkdownTextShadowNode>;

void HelmCodeMarkdownTextSpec_registerComponentDescriptorsFromCodegen(
  std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
}
