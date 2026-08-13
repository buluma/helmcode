#pragma once

#include <react/renderer/components/HelmCodeMarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/HelmCodeMarkdownTextSpec/Props.h>
#include <react/renderer/components/HelmCodeMarkdownTextSpec/States.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>

namespace facebook::react {
extern const char HelmCodeMarkdownTextRunComponentName[];

using HelmCodeMarkdownTextRunShadowNode = ConcreteViewShadowNode<
    HelmCodeMarkdownTextRunComponentName,
    HelmCodeMarkdownTextRunProps,
    HelmCodeMarkdownTextRunEventEmitter,
    HelmCodeMarkdownTextRunState>;
}
