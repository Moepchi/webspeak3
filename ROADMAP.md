# WebSpeak3 Beta Roadmap

WebSpeak3 is a public beta: it already connects to real TeamSpeak 3 and
TeamSpeak 6 servers, but some browser-specific behavior and less common server
features still need wider testing.

This roadmap is intentionally outcome-focused. It does not promise fixed dates.

## Available today

- Connect to any reachable TS3 or TS6 server through the WebSpeak3 gateway
- Low-latency Opus voice, voice activation, whisper, and audio-device selection
- Live channel/client tree with status updates, search, avatars, and context actions
- Per-person volume, remembered per user across sessions
- Server, channel, and private text chat
- Favorites, identities, contacts, pokes, away state, and reconnect
- File transfers, local session recording, sound packs, and administration tools
- Design Store: browse, upload, rate, and download community-made themes
- Opt-in WASM AEC3 echo cancellation for speaker+mic setups
- Responsive desktop and mobile interfaces in German, English, Simplified Chinese, and Persian (Beta)
- Docker image and Compose-based self-hosting

## Experimental or still being validated

- **Screen streaming to and from TeamSpeak 6 (alpha, unstable).** WebSpeak3 can
  publish a screen share that a native TS6 client can watch, and watch a stream
  a TS6 client publishes. It speaks TS6's Stream/Call protocol, which TeamSpeak
  does not document, so the wire format was derived from observed behavior and
  may break with any TS6 update. Connection setup, picture quality, and viewer
  admission are not yet dependable. The "Server" connection mode (TS6's SFU) is
  not implemented; only direct P2P works. Streaming needs a gateway from v0.11.0-beta.1
  on; since v0.15 the gateway announces its features when the browser connects,
  so newer features stay hidden behind an older gateway instead of hanging.
- Safari and Mobile Safari audio/microphone behavior
- Uncommon TeamSpeak permission combinations and large permission sets
- Very large servers and long-running browser sessions
- Mobile browser behavior across a wider range of devices
- Reverse-proxy and hosting configurations beyond the documented examples

## Next milestones

### Beta hardening

- Expand real-browser audio testing, especially Safari
- Improve reconnect and recovery behavior under unstable networks
- Turn recurring deployment and compatibility reports into documentation

### Accessibility

Basics are in place: the UI language sets the document's `lang`/`dir`,
dialogs take focus on open, keep Tab inside, close on Escape, and hand focus
back; toolbar icon buttons are labelled; channel and client rows are
focusable (Enter joins a channel or opens a private chat, Space selects,
the context-menu key or Shift+F10 opens the menu with focus in it). Still to do:

- Replace the remaining clickable `<div>`s with real buttons
- Arrow-key navigation through the tree and menus
- Do a full screen-reader pass (NVDA/VoiceOver) through a real connect
  session to find what else is missing

### Deployment experience

- Keep the one-command Docker path reliable
- Add clearer HTTPS and reverse-proxy examples
- Document backup and upgrade expectations for persistent browser identities
- Improve release notes and migration guidance when configuration changes

### Toward a stable release

- Define and complete a repeatable browser compatibility checklist
- Resolve confirmed high-impact beta issues
- Stabilize configuration and deployment contracts
- Publish a support matrix based on verified devices and browsers

## Feedback

Please use [GitHub Issues](https://github.com/Moepchi/webspeak3/issues) for
reproducible bugs and feature requests. Include the browser and version,
operating system, deployment method, and whether the issue affects voice,
microphone access, or only the interface.

WebSpeak3 is independent and is not affiliated with or endorsed by TeamSpeak
Systems GmbH.
