#include "server.h"

#include <daisy_seed.h>

using namespace usb_transfer;

void Server::init(const Config& config, Handler* handler)
{
    _config = config;
    _handler = handler;
    _link.init(config.link);
    _should_exit = false;
}

void Server::begin()
{
    _should_exit = false;
    _is_connected = false;
    _link.start();
    _last_frame_ms = daisy::System::GetNow();
}

void Server::end()
{
    _handler->reset_session();
    _link.stop();
}

void Server::process()
{
    if (_should_exit) return;

    Link::Frame frame;
    switch (_link.poll(frame)) {
        case Link::Poll::none: break;
        case Link::Poll::error: {
            // The broken frame wasn't processed, the session stays as it was
            // so the host can resend it.
            auto p = _link.payload();
            p[0] = static_cast<uint8_t>(Status::bad_frame);
            p[1] = static_cast<uint8_t>(_link.last_error());
            _link.send(kFrameErrorType, 0, 2);
            break;
        }
        case Link::Poll::frame:
            _last_frame_ms = daisy::System::GetNow();
            _is_connected = true;
            _handle(frame);
            break;
    }

    auto timeout = _is_connected ? _config.idle_timeout_ms : _config.connect_timeout_ms;
    if (daisy::System::GetNow() - _last_frame_ms > timeout) {
        _should_exit = true;
    }
}

void Server::_handle(const Link::Frame& frame)
{
    switch (static_cast<Command>(frame.type)) {
        case Command::hello:
            _handler->reset_session();
            _handler->hello(*this, frame);
            break;

        case Command::ping:
            reply(frame, Status::ok);
            break;

        case Command::exit:
            _handler->reset_session();
            reply(frame, Status::ok);
            _should_exit = true;
            break;

        default:
            if (!_handler->handle(*this, frame)) reply(frame, Status::unknown_cmd);
    }
}

bool Server::send(const Link::Frame& frame, const size_t size)
{
    return _link.send(frame.type | kResponseFlag, frame.seq, size);
}

bool Server::reply(const Link::Frame& frame, const uint8_t status)
{
    return _link.send_status(frame.type | kResponseFlag, frame.seq, status);
}
