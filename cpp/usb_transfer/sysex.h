#pragma once

#include <stddef.h>
#include <stdint.h>

/*
The SysEx that asks a device to switch from USB MIDI to transfer mode, and its
reply. A device is told apart by its signature: the non-commercial manufacturer
ID 0x7D followed by two ASCII bytes, e.g. 0x7D 'S' 'K'.

  host → device  F0 <signature[3]> 01 F7           enter transfer mode
  device → host  F0 <signature[3]> 02 <status> F7  status 0 = OK (switching now),
                                                   any other value is the device's
*/
namespace usb_transfer::sysex {

static constexpr uint8_t kManufacturer = 0x7D; // non-commercial
static constexpr uint8_t kEnter = 0x01;
static constexpr uint8_t kReply = 0x02;
static constexpr uint8_t kStatusOk = 0;
static constexpr size_t  kSignatureSize = 3;
static constexpr size_t  kReplySize = 7; // with F0 and F7

struct Signature {
    uint8_t bytes[kSignatureSize];
};

/* A signature from the two ASCII bytes after the manufacturer ID. */
constexpr Signature signature(const char a, const char b)
{
    return Signature { { kManufacturer, static_cast<uint8_t>(a), static_cast<uint8_t>(b) } };
}

/* Whether `data` (the bytes between F0 and F7, as libDaisy's MidiEvent::sysex_data
holds them) is the enter request for this signature. */
inline bool is_enter(const Signature& signature, const uint8_t* data, const size_t size)
{
    return size == kSignatureSize + 1
        && data[0] == signature.bytes[0]
        && data[1] == signature.bytes[1]
        && data[2] == signature.bytes[2]
        && data[3] == kEnter;
}

/* The reply, F0 to F7, into `out` (kReplySize bytes). Returns its size. */
inline size_t reply(const Signature& signature, const uint8_t status, uint8_t* out)
{
    out[0] = 0xF0;
    out[1] = signature.bytes[0];
    out[2] = signature.bytes[1];
    out[3] = signature.bytes[2];
    out[4] = kReply;
    out[5] = status & 0x7F;
    out[6] = 0xF7;
    return kReplySize;
}

};
