// Host stand-in for libDaisy, just enough for cpp/usb_transfer. Device repos that
// test their own code on the host usually have a fuller stand-in; it needs the same
// UsbHandle members.
#pragma once
#include <cstdint>
#include <cstddef>
#include <cstdio>
#include <cstring>
#include <algorithm>
inline void __disable_irq() {}
inline void __enable_irq() {}
namespace daisy {
struct System { static uint32_t GetNow(); static void Delay(uint32_t) {} };
class UsbHandle { public:
  enum UsbPeriph { FS_INTERNAL, FS_EXTERNAL, FS_BOTH }; enum class Result { OK, ERR };
  typedef void (*ReceiveCallback)(uint8_t*, uint32_t*);
  void Init(UsbPeriph) {} void DeInit(UsbPeriph) {}
  Result TransmitInternal(uint8_t*, size_t); Result TransmitExternal(uint8_t*, size_t);
  void SetReceiveCallback(ReceiveCallback, UsbPeriph); };
}
