// Device side of the tests: usb_transfer::Server with a small test device on the
// host, USB CDC on stdin/stdout. The test device keeps one blob in memory, written
// with chunked writes and read with ranged reads (docs/protocol.md), on the internal
// port with a 4 KB chunk.
//
// usage: harness
// FAULT environment variable, for the retry paths:
//   write-noreply  drops the reply to the 5th WRITE_DATA
//   read-cut       sends half of the 5th READ reply
//   read-drop      drops the 5th READ reply
//   read-burst     cuts every other READ reply larger than 2 KB to 2 KB,
//                  like a macOS tty overflowing
#include <chrono>
#include <string>
#include <cstdlib>
#include <unistd.h>
#include <fcntl.h>
#include <poll.h>
#include "daisy_seed.h"
#include "usbd_cdc.h"
#include "usb_transfer/server.h"
#include "usb_transfer/sysex.h"

using namespace usb_transfer;

extern "C" {
    uint8_t usbd_mode = 0;
    USBD_HandleTypeDef hUsbDeviceFS { nullptr };
    USBD_HandleTypeDef hUsbDeviceHS { nullptr };
}

static daisy::UsbHandle::ReceiveCallback g_rx = nullptr;
static int g_external_writes = 0;

uint32_t daisy::System::GetNow()
{
    using namespace std::chrono;
    static auto t0 = steady_clock::now();
    return duration_cast<milliseconds>(steady_clock::now() - t0).count();
}

static constexpr uint8_t kWriteBegin = 0x10;
static constexpr uint8_t kWriteData  = 0x11;
static constexpr uint8_t kRead       = 0x21;
static constexpr uint8_t kBadOffset  = kFirstDeviceStatus; // the test device's own status
static constexpr size_t  kMaxChunk   = 4096;
static constexpr size_t  kMaxPayload = kMaxChunk + 16;
static constexpr size_t  kMaxBlob    = 1 << 20;

daisy::UsbHandle::Result daisy::UsbHandle::TransmitInternal(uint8_t* buf, size_t size)
{
    static int writes = 0, reads = 0, large_reads = 0;
    static const char* fault = getenv("FAULT");
    if (fault) {
        std::string f = fault;
        if (buf[2] == (kWriteData | kResponseFlag) && ++writes == 5 && f == "write-noreply") return Result::OK;
        if (buf[2] == (kRead | kResponseFlag)) {
            ++reads;
            if (reads == 5 && f == "read-drop") return Result::OK;
            if (reads == 5 && f == "read-cut") size /= 2;
            if (f == "read-burst" && size > 2048 + 16 && (++large_reads % 2)) size = 2048;
        }
    }
    for (size_t off = 0; off < size;) {
        auto written = write(1, buf + off, size - off);
        if (written <= 0) return Result::ERR;
        off += written;
    }
    return Result::OK;
}

// The test device is on the internal port: nothing may go out on the external one
daisy::UsbHandle::Result daisy::UsbHandle::TransmitExternal(uint8_t*, size_t)
{
    g_external_writes++;
    return Result::ERR;
}

void daisy::UsbHandle::SetReceiveCallback(ReceiveCallback cb, UsbPeriph) { g_rx = cb; }

class TestDevice: public Handler {
  public:
    void hello(Server& server, const Link::Frame& frame) override
    {
        auto p = server.payload();
        p[0] = static_cast<uint8_t>(Status::ok);
        p[1] = 1; // proto_major
        p[2] = 0; // proto_minor
        p[3] = 0;
        put_u32(&p[4], kMaxChunk);
        put_u32(&p[8], _size);
        server.send(frame, 12);
    }

    bool handle(Server& server, const Link::Frame& frame) override
    {
        switch (frame.type) {
            case kWriteBegin: _write_begin(server, frame); return true;
            case kWriteData:  _write_data(server, frame); return true;
            case kRead:       _read(server, frame); return true;
            default:          return false;
        }
    }

    void reset_session() override
    {
        _is_writing = false;
    }

  private:
    void _write_begin(Server& server, const Link::Frame& frame)
    {
        if (frame.size < 4 || get_u32(frame.payload) > kMaxBlob) {
            server.reply(frame, Status::bad_arg);
            return;
        }
        _size = get_u32(frame.payload);
        _offset = 0;
        _is_writing = true;
        server.reply(frame, Status::ok);
    }

    void _reply_offset(Server& server, const Link::Frame& frame, const uint8_t status)
    {
        auto p = server.payload();
        p[0] = status;
        p[1] = p[2] = p[3] = 0;
        put_u32(&p[4], _offset);
        server.send(frame, 8);
    }

    void _write_data(Server& server, const Link::Frame& frame)
    {
        if (!_is_writing) {
            _reply_offset(server, frame, static_cast<uint8_t>(Status::bad_state));
            return;
        }
        if (frame.size < 4) {
            _reply_offset(server, frame, static_cast<uint8_t>(Status::bad_arg));
            return;
        }
        auto offset = get_u32(frame.payload);
        auto length = frame.size - 4;
        if (offset != _offset) {
            _reply_offset(server, frame, kBadOffset);
            return;
        }
        if (length == 0 || length > kMaxChunk || _offset + length > _size) {
            _reply_offset(server, frame, static_cast<uint8_t>(Status::bad_arg));
            return;
        }
        std::memcpy(&_blob[_offset], &frame.payload[4], length);
        _offset += length;
        if (_offset == _size) _is_writing = false;
        _reply_offset(server, frame, static_cast<uint8_t>(Status::ok));
    }

    void _read(Server& server, const Link::Frame& frame)
    {
        if (frame.size < 8) {
            server.reply(frame, Status::bad_arg);
            return;
        }
        auto offset = get_u32(frame.payload);
        auto length = get_u32(&frame.payload[4]);
        if (length == 0 || length > kMaxChunk || (uint64_t)offset + length > _size) {
            server.reply(frame, Status::bad_arg);
            return;
        }
        auto p = server.payload();
        p[0] = static_cast<uint8_t>(Status::ok);
        p[1] = p[2] = p[3] = 0;
        std::memcpy(&p[4], &_blob[offset], length);
        server.send(frame, 4 + length);
    }

    uint8_t  _blob[kMaxBlob];
    uint32_t _size = 0;
    uint32_t _offset = 0;
    bool     _is_writing = false;
};

static uint8_t rx_buffer[frame_size(kMaxPayload)];
static uint8_t tx_buffer[frame_size(kMaxPayload)];
static TestDevice device;

// sysex.h: the enter request and reply of signature 'T' 'B'
static bool check_sysex()
{
    constexpr auto signature = sysex::signature('T', 'B');
    const uint8_t enter[] = { 0x7D, 'T', 'B', 0x01 };
    const uint8_t other[] = { 0x7D, 'S', 'K', 0x01 };
    uint8_t reply[sysex::kReplySize];
    auto size = sysex::reply(signature, 2, reply);
    const uint8_t expected[] = { 0xF0, 0x7D, 'T', 'B', 0x02, 2, 0xF7 };
    return sysex::is_enter(signature, enter, sizeof(enter))
        && !sysex::is_enter(signature, other, sizeof(other))
        && !sysex::is_enter(signature, enter, 3)
        && size == sizeof(expected) && std::memcmp(reply, expected, size) == 0;
}

int main()
{
    if (!check_sysex()) {
        fprintf(stderr, "harness: sysex check failed\n");
        return 4;
    }

    Server server;
    Server::Config config;
    config.link = { Link::Port::internal, { 'T', 'B' }, rx_buffer, tx_buffer, sizeof(rx_buffer) };
    server.init(config, &device);
    server.begin();

    fcntl(0, F_SETFL, O_NONBLOCK);
    uint8_t packet[64]; // USB full speed packets
    while (!server.should_exit()) {
        pollfd pfd { 0, POLLIN, 0 };
        poll(&pfd, 1, 5);
        while (true) {
            auto n = read(0, packet, sizeof(packet));
            if (n == 0) return 0;
            if (n < 0) break;
            uint32_t len = n;
            g_rx(packet, &len);
        }
        server.process();
    }
    server.end();
    if (g_external_writes) {
        fprintf(stderr, "harness: %d writes on the external port\n", g_external_writes);
        return 3;
    }
    return 0;
}
