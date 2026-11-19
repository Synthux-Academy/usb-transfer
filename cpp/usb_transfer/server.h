#pragma once

#include <stddef.h>
#include <stdint.h>
#include "link.h"
#include "protocol.h"

namespace usb_transfer {

class Server;

/*
What a device adds to the protocol: its HELLO body and its own commands.
Each call answers its request with exactly one reply (Server::reply / send).
*/
class Handler {
  public:
    virtual ~Handler() = default;

    /* HELLO: the device's whole reply payload, status byte first, by convention
    followed by proto_major, proto_minor. reset_session() has run just before. */
    virtual void hello(Server&, const Link::Frame&) = 0;

    /* Any command other than HELLO, PING and EXIT. Returns false for a command
    the device doesn't know; the server then replies UNKNOWN_CMD. */
    virtual bool handle(Server&, const Link::Frame&) = 0;

    /* Drops a session that spans several requests (an open file, a partial
    upload): before HELLO, on EXIT and on Server::end(). */
    virtual void reset_session() {}
};

/*
One transfer mode session: polls the link, answers frame errors, PING, HELLO
and EXIT, passes everything else to the handler, and asks to leave after the
idle timeout. Runs from the main loop; each request is answered within one
process() call.
*/
class Server {
  public:
    struct Config {
      Link::Config link;
      // Leave after this long without a valid frame...
      uint32_t idle_timeout_ms = 10000;
      // ...or this long before the first one, while the user picks the port in the browser
      uint32_t connect_timeout_ms = 60000;
    };

    Server() = default;
    ~Server() = default;
    Server(const Server&) = delete;
    Server& operator=(const Server&) = delete;

    void init(const Config&, Handler*);

    /* Starts CDC on the port. USB MIDI on the port must be stopped before. */
    void begin();
    /* Resets the handler's session and stops CDC. */
    void end();
    void process();

    /* EXIT received or timed out: the device should call end() and go back to MIDI. */
    bool should_exit() const { return _should_exit; }
    /* A valid frame has arrived since begin() */
    bool is_connected() const { return _is_connected; }

    Link& link() { return _link; }

    // For the handler ////////////////////////////
    /* The reply payload to fill, status byte first. */
    uint8_t* payload() { return _link.payload(); }
    size_t max_payload() const { return _link.max_payload(); }
    /* Sends `size` bytes of payload() as the reply to `frame`. */
    bool send(const Link::Frame& frame, const size_t size);
    /* A reply that is only a status byte. */
    bool reply(const Link::Frame& frame, const uint8_t status);
    template <typename S>
    bool reply(const Link::Frame& frame, const S status) { return reply(frame, static_cast<uint8_t>(status)); }

  private:
    void _handle(const Link::Frame&);

    Config   _config {};
    Handler* _handler = nullptr;
    Link     _link;
    bool     _should_exit = false;
    bool     _is_connected = false;
    uint32_t _last_frame_ms = 0;
};

};
