#include "protocol.h"

uint32_t usb_transfer::crc32_update(uint32_t crc, const uint8_t* data, size_t size)
{
    static uint32_t table[256];
    static bool is_table_ready = false;
    if (!is_table_ready) {
        for (uint32_t i = 0; i < 256; i++) {
            uint32_t c = i;
            for (uint8_t k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320u ^ (c >> 1) : c >> 1;
            table[i] = c;
        }
        is_table_ready = true;
    }
    crc = ~crc;
    for (size_t i = 0; i < size; i++) crc = table[(crc ^ data[i]) & 0xff] ^ (crc >> 8);
    return ~crc;
}
