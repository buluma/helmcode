#import "HelmCodeMarkdownTextRun.h"
#import "HelmCodeMarkdownText.h"
#import "HelmCodeMarkdownTextRunComponentDescriptor.h"
#import <react/renderer/components/HelmCodeMarkdownTextSpec/EventEmitters.h>
#import <react/renderer/components/HelmCodeMarkdownTextSpec/Props.h>
#import <react/renderer/components/HelmCodeMarkdownTextSpec/RCTComponentViewHelpers.h>
#import "RCTFabricComponentsPlugins.h"
#import "Utils.h"

using namespace facebook::react;

@interface HelmCodeMarkdownTextRun () <RCTHelmCodeMarkdownTextRunViewProtocol>

@end

@implementation HelmCodeMarkdownTextRun {
  NSString * _text;
  RCTBubblingEventBlock _onPress;
  RCTBubblingEventBlock _onLongPress;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider
{
    return concreteComponentDescriptorProvider<HelmCodeMarkdownTextRunComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps = std::make_shared<const HelmCodeMarkdownTextRunProps>();
    _props = defaultProps;
  }
  return self;
}

- (void)updateProps:(Props::Shared const &)props oldProps:(Props::Shared const &)oldProps
{
  const auto &oldViewProps = *std::static_pointer_cast<HelmCodeMarkdownTextRunProps const>(_props);
  const auto &newViewProps = *std::static_pointer_cast<HelmCodeMarkdownTextRunProps const>(props);

  if (newViewProps.text != oldViewProps.text) {
    NSString *text = [NSString stringWithUTF8String:newViewProps.text.c_str()];
    _text = text;
  }

  [super updateProps:props oldProps:oldProps];
}

- (void)onPress {
  if (_eventEmitter != nullptr) {
    std::dynamic_pointer_cast<const facebook::react::HelmCodeMarkdownTextRunEventEmitter>(_eventEmitter)
    ->onPress(facebook::react::HelmCodeMarkdownTextRunEventEmitter::OnPress{});
  }
}

- (void)onLongPress {
  if (_eventEmitter != nullptr) {
    std::dynamic_pointer_cast<const facebook::react::HelmCodeMarkdownTextRunEventEmitter>(_eventEmitter)
    ->onLongPress(facebook::react::HelmCodeMarkdownTextRunEventEmitter::OnLongPress{});
  }
}

+ (BOOL)shouldBeRecycled {
  return NO;
}

Class<RCTComponentViewProtocol> HelmCodeMarkdownTextRunCls(void)
{
    return HelmCodeMarkdownTextRun.class;
}

@end
