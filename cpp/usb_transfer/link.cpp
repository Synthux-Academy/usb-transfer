#include "link.h"

#include <cstring>
#include <daisy_seed.h>
#include "usbd_cdc.h"

using namespace usb_transfer;
using namespace daisy;

extern "C" {
    // libDaisy: FS_INTERNAL runs on hUsbDeviceFS, FS_EXTERNAL on hUsbDeviceHS
    extern USBD_HandleTypeDef hUsbDeviceFS;
    extern USBD_HandleTypeDef hUsbDeviceHS;
}

static constexpr uint32_t kStaleFrameMs = 2000;
// After a frame error, incoming bytes are discarded until the line is quiet
// this long, so the rest of a broken frame isn't taken for a new one.
static constexpr uint32_t kQuietMs = 100;
static constexpr uint32_t kTxTimeoutMs = 200;

// Receive state, shared with the USB interrupt
static uint8_t*          _rx_buf = nullptr;
static size_t            _rx_capacity = 0;
static volatile size_t   _rx_len = 0;
static volatile bool     _rx_overflow = false;
static volatile uint32_t _rx_last_ms = 0;
static size_t            _frame_size = 0;
static bool              _discarding = false;

static void clear_rx()
{
    __disable_irq();
    _rx_len = 0;
    _rx_overflow = false;
    __enable_irq();
}

// Called from the USB interrupt
static void rx_callback(uint8_t* buf, uint32_t* len)
{
    auto size = *len;
    if (_rx_len + size > _rx_capacity) {
        _rx_overflow = true;
        return;
    }
    std::memcpy(&_rx_buf[_rx_len], buf, size);
    _rx_len = _rx_len + size;
    _rx_last_ms = System::GetNow();
}

static UsbHandle::UsbPeriph periph(const Link::Port port)
{
    return port == Link::Port::internal ? UsbHandle::FS_INTERNAL : UsbHandle::FS_EXTERNAL;
}

void Link::init(const Config& config)
{
    _config = config;
}

void Link::start()
{
    __disable_irq();
    _rx_buf = _config.rx_buffer;
    _rx_capacity = _config.buffer_size;
    _rx_len = 0;
    _rx_overflow = false;
    __enable_irq();
    _frame_size = 0;
    _discarding = false;
    _rx_last_ms = System::GetNow();

    UsbHandle usb;
    usbd_mode = USBD_MODE_CDC;
    usb.Init(periph(_config.port));
    System::Delay(10);
    usb.SetReceiveCallback(rx_callback, periph(_config.port));
}

void Link::stop()
{
    _wait_tx_idle(kTxTimeoutMs);
    UsbHandle usb;
    usb.DeInit(periph(_config.port));
}

uint32_t Link::last_rx_ms() const
{
    return _rx_last_ms;
}

Link::Poll Link::_frame_error(const FrameError error)
{
    clear_rx();
    _discarding = true;
    _last_error = error;
    return Poll::error;
}

void Link::_drop(const size_t count)
{
    __disable_irq();
    auto len = _rx_len;
    if (count >= len) {
        _rx_len = 0;
    }
    else {
        std::memmove(_rx_buf, &_rx_buf[count], len - count);
        _rx_len = len - count;
    }
    __enable_irq();
}

Link::Poll Link::poll(Frame& out)
{
    if (_frame_size > 0) {
        // Previous frame was not answered, discard it
        _drop(_frame_size);
        _frame_size = 0;
    }

    if (_discarding) {
        clear_rx();
        if (System::GetNow() - _rx_last_ms < kQuietMs) return Poll::none;
        _discarding = false;
    }

    if (_rx_overflow) return _frame_error(FrameError::overflow);

    size_t len = _rx_len;
    if (len == 0) return Poll::none;

    // Resync: anything before the magic is discarded (e.g. modem probing)
    auto m0 = _config.magic[0];
    auto m1 = _config.magic[1];
    if (_rx_buf[0] != m0 || (len > 1 && _rx_buf[1] != m1)) {
        size_t idx = 1;
        while (idx < len && !(_rx_buf[idx] == m0 && (idx + 1 == len || _rx_buf[idx + 1] == m1))) idx++;
        _drop(idx);
        return Poll::none;
    }

    auto is_stale = System::GetNow() - _rx_last_ms > kStaleFrameMs;
    if (len < kHeaderSize) {
        if (is_stale) {
            return _frame_error(FrameError::stale);
        }
        return Poll::none;
    }

    auto payload_size = get_u32(&_rx_buf[4]);
    if (payload_size > max_payload()) {
        return _frame_error(FrameError::bad_length);
    }

    if (len < kHeaderSize + payload_size) {
        if (is_stale) {
            return _frame_error(FrameError::stale);
        }
        return Poll::none;
    }

    auto crc = crc32_update(crc32(&_rx_buf[2], 6), &_rx_buf[kHeaderSize], payload_size);
    if (crc != get_u32(&_rx_buf[8])) {
        return _frame_error(FrameError::crc);
    }

    out.type = _rx_buf[2];
    out.seq = _rx_buf[3];
    out.payload = &_rx_buf[kHeaderSize];
    out.size = payload_size;
    _frame_size = kHeaderSize + payload_size;
    return Poll::frame;
}

bool Link::_wait_tx_idle(const uint32_t timeout_ms)
{
    auto& handle = _config.port == Port::internal ? hUsbDeviceFS : hUsbDeviceHS;
    auto start = System::GetNow();
    while (true) {
        auto hcdc = static_cast<USBD_CDC_HandleTypeDef*>(handle.pClassData);
        if (hcdc == nullptr || hcdc->TxState == 0) return true;
        if (System::GetNow() - start > timeout_ms) return false;
    }
}

uint8_t* Link::payload()
{
    // The TX buffer is handed to the USB stack as is, it must not
    // be overwritten while the previous response is still going out.
    _wait_tx_idle(kTxTimeoutMs);
    return &_config.tx_buffer[kHeaderSize];
}

bool Link::_transmit(uint8_t* data, const size_t size)
{
    UsbHandle usb;
    auto result = _config.port == Port::internal ? usb.TransmitInternal(data, size) : usb.TransmitExternal(data, size);
    return result == UsbHandle::Result::OK;
}

bool Link::send(const uint8_t type, const uint8_t seq, const size_t size)
{
    if (_frame_size > 0) {
        _drop(_frame_size);
        _frame_size = 0;
    }

    auto tx = _config.tx_buffer;
    tx[0] = _config.magic[0];
    tx[1] = _config.magic[1];
    tx[2] = type;
    tx[3] = seq;
    put_u32(&tx[4], size);
    put_u32(&tx[8], crc32_update(crc32(&tx[2], 6), &tx[kHeaderSize], size));

    auto start = System::GetNow();
    while (!_transmit(tx, kHeaderSize + size)) {
        if (System::GetNow() - start > kTxTimeoutMs) return false;
    }
    return true;
}

bool Link::send_status(const uint8_t type, const uint8_t seq, const uint8_t status)
{
    payload()[0] = status;
    return send(type, seq, 1);
}
