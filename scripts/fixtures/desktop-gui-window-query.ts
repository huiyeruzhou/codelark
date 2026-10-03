/** 一次编译后用于所有窗口检查，避免在每次查询时启动 Swift 编译器。只输出指定 PID 的屏幕窗口。 */
export const desktopWindowQuerySource = String.raw`
#include <CoreFoundation/CoreFoundation.h>
#include <CoreGraphics/CoreGraphics.h>
#include <stdio.h>
#include <stdlib.h>

static int number(CFDictionaryRef dictionary, CFStringRef key, int *value) {
  CFTypeRef raw = CFDictionaryGetValue(dictionary, key);
  return raw && CFGetTypeID(raw) == CFNumberGetTypeID()
    && CFNumberGetValue((CFNumberRef)raw, kCFNumberIntType, value);
}

int main(int argc, char **argv) {
  if (argc != 2) return 2;
  char *end = NULL;
  long pid = strtol(argv[1], &end, 10);
  if (pid <= 0 || !end || *end) return 2;
  CFArrayRef windows = CGWindowListCopyWindowInfo(
    kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
  if (!windows) { fputs("CoreGraphics returned no window list\n", stderr); return 3; }
  fputs("[", stdout);
  int first = 1;
  for (CFIndex i = 0; i < CFArrayGetCount(windows); i++) {
    CFDictionaryRef window = (CFDictionaryRef)CFArrayGetValueAtIndex(windows, i);
    int owner = 0, layer = 0, windowId = 0;
    if (!number(window, kCGWindowOwnerPID, &owner) || owner != pid
      || !number(window, kCGWindowLayer, &layer) || layer != 0) continue;
    CFDictionaryRef bounds = (CFDictionaryRef)CFDictionaryGetValue(window, kCGWindowBounds);
    CGRect rect;
    if (!bounds || !CGRectMakeWithDictionaryRepresentation(bounds, &rect)) continue;
    number(window, kCGWindowNumber, &windowId);
    printf("%s{\"kCGWindowOwnerPID\":%d,\"kCGWindowLayer\":%d,\"kCGWindowNumber\":%d,"
      "\"kCGWindowBounds\":{\"X\":%.3f,\"Y\":%.3f,\"Width\":%.3f,\"Height\":%.3f}}",
      first ? "" : ",", owner, layer, windowId, rect.origin.x, rect.origin.y, rect.size.width, rect.size.height);
    first = 0;
  }
  fputs("]\n", stdout);
  CFRelease(windows);
  return 0;
}
`;
