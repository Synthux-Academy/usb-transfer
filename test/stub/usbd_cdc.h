// Host stand-in for libDaisy's patched USB CDC class header, used by link.cpp.
#pragma once
#include <cstdint>
typedef struct { uint32_t TxState; } USBD_CDC_HandleTypeDef;
typedef struct { void* pClassData; } USBD_HandleTypeDef;
#define USBD_MODE_CDC 0
#define USBD_MODE_MIDI 1
extern "C" uint8_t usbd_mode;
