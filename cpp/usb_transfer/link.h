#pragma once

#include <stddef.h>
#include <stdint.h>
#include "protocol.h"

namespace usb_transfer {

/*
Framing over USB CDC on one of libDaisy's USB ports.

The host waits for a response before sending the next request, so one frame
buffer each way is enough. The buffers belong to the device: it picks their
size (its largest payload, see frame_size()) and where they live (SDRAM, AXI
SRAM...). USB doesn't use DMA, so any RAM works.

The USB receive callback is a plain function, so only one Link may be started
at a time.
*/
class Link {
  public:
    enum class Port: uint8_t {
      internal, // the MCU's own full-speed port, libDaisy UsbHandle::FS_INTERNAL
      external  // the second port through an external PHY, UsbHandle::FS_EXTERNAL
    };

    struct Config {
      Port     port;
      uint8_t  magic[2];   // first two bytes of every frame, e.g. 'S' 'K'
      uint8_t* rx_buffer;  // frame_size(max_payload) bytes each
      uint8_t* tx_buffer;
      size_t   buffer_size;
    };

    struct Frame {
      uint8_t type;
      uint8_t seq;
      const uint8_t* payload;
      size_t size;
    };

    enum class Poll: uint8_t {
      none,
      frame,
      error
    };

    Link() = default;
    ~Link() = default;
    Link(const Link&) = delete;
    Link& operator=(const Link&) = delete;

    void init(const Config&);

    /* Switches the port to CDC (libDaisy's usbd_mode) and starts receiving.
    USB MIDI on the port must be stopped before. */
    void start();
    void stop();

    /* Checks the receive buffer for a complete frame. After Poll::frame
    the frame stays valid until the next call to send(). */
    Poll poll(Frame& out);

    /* Response payload is written by the caller into payload()
    (status byte first) before calling send(). */
    uint8_t* payload();
    size_t max_payload() const { return _config.buffer_size - kHeaderSize; }
    bool send(const uint8_t type, const uint8_t seq, const size_t size);
    bool send_status(const uint8_t type, const uint8_t seq, const uint8_t status);

    uint32_t last_rx_ms() const;
    /* Why the last Poll::error happened */
    FrameError last_error() const { return _last_error; }

  private:
    void _drop(const size_t count);
    Poll _frame_error(const FrameError);
    bool _wait_tx_idle(const uint32_t timeout_ms);
    bool _transmit(uint8_t* data, const size_t size);

    Config     _config {};
    FrameError _last_error = FrameError::unknown;
};

};
