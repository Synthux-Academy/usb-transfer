#pragma once

#include <stddef.h>
#include <stdint.h>

/*
The part of the USB transfer protocol every device shares, see docs/protocol.md.
A device adds its own commands, status codes and HELLO body on top.
All multi-byte values are little-endian.
*/
namespace usb_transfer {

// Frame ///////////////////////////////////////////
// magic[2] type seq len:u32 crc:u32 payload[len]
static constexpr size_t  kHeaderSize = 12;
static constexpr uint8_t kResponseFlag = 0x80;
// Response type of the reserved command 0x00: the device rejected a frame
static constexpr uint8_t kFrameErrorType = 0x80;

/* The size of a frame buffer for payloads up to `max_payload` bytes. */
constexpr size_t frame_size(const size_t max_payload) { return kHeaderSize + max_payload; }

// Commands every device answers. A device's own commands use the IDs in between.
enum class Command: uint8_t {
    reserved = 0x00, // never sent, its response type marks frame errors
    hello    = 0x01, // resets the device session, the reply body is the device's
    ping     = 0x02,
    exit     = 0x7F
};

// Status codes every device uses, first byte of every reply.
// A device's own codes start at kFirstDeviceStatus.
enum class Status: uint8_t {
    ok          = 0,
    bad_frame   = 1,
    unknown_cmd = 2,
    bad_state   = 3,
    bad_arg     = 4
};
static constexpr uint8_t kFirstDeviceStatus = 5;

// Why a frame was rejected: second payload byte of a BAD_FRAME reply (type kFrameErrorType)
enum class FrameError: uint8_t {
    unknown    = 0,
    crc        = 1, // checksum mismatch, bytes changed on the way
    stale      = 2, // a partial frame stopped arriving
    overflow   = 3, // more data than the receive buffer holds
    bad_length = 4  // header announces a payload above the device's maximum
};

// CRC-32 (IEEE 802.3, same as zlib) ///////////////
uint32_t crc32_update(uint32_t crc, const uint8_t* data, size_t size);
inline uint32_t crc32(const uint8_t* data, size_t size) { return crc32_update(0, data, size); }

// Little-endian helpers ///////////////////////////
inline uint16_t get_u16(const uint8_t* p) { return p[0] | (p[1] << 8); }
inline uint32_t get_u32(const uint8_t* p) { return p[0] | (p[1] << 8) | (p[2] << 16) | ((uint32_t)p[3] << 24); }
inline void put_u16(uint8_t* p, uint16_t v) { p[0] = v; p[1] = v >> 8; }
inline void put_u32(uint8_t* p, uint32_t v) { p[0] = v; p[1] = v >> 8; p[2] = v >> 16; p[3] = v >> 24; }

};
