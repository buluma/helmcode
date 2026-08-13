#import <React/RCTViewManager.h>
#import <React/RCTUIManager.h>
#import "RCTBridge.h"
#import "Utils.h"

@interface HelmCodeMarkdownTextManager : RCTViewManager
@end

@implementation HelmCodeMarkdownTextManager

RCT_EXPORT_MODULE(HelmCodeMarkdownText)

- (UIView *)view
{
  return [[UIView alloc] init];
}

RCT_CUSTOM_VIEW_PROPERTY(color, NSString, UIView)
{
}

@end

@interface HelmCodeMarkdownTextRunManager : RCTViewManager
@end

@implementation HelmCodeMarkdownTextRunManager

RCT_EXPORT_MODULE(HelmCodeMarkdownTextRun)

- (UIView *)view
{
  return nil;
}

@end
