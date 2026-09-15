# WebSpeak3 Beta Roadmap

WebSpeak3 is a public beta: it already connects to real TeamSpeak 3 and
TeamSpeak 6 servers, but some browser-specific behavior and less common server
features still need wider testing.

This roadmap is intentionally outcome-focused. It does not promise fixed dates.

## Available today

- Connect to any reachable TS3 or TS6 server through the WebSpeak3 gateway
- Low-latency Opus voice, voice activation, whisper, and audio-device selection
- Live channel/client tree with status updates and context actions
- Server, channel, and private text chat
- Favorites, identities, contacts, pokes, away state, and reconnect
- File transfers, local session recording, sound packs, and administration tools
- Responsive desktop and mobile interfaces in German and English
- Docker image and Compose-based self-hosting

## Experimental or still being validated

- **Screen streaming to and from TeamSpeak 6 (alpha, unstable).** WebSpeak3 can
  publish a screen share that a native TS6 client can watch, and watch a stream
  a TS6 client publishes. It speaks TS6's Stream/Call protocol, which TeamSpeak
  does not document, so the wire format was derived from observed behavior and
  may break with any TS6 update. Connection setup, picture quality, and viewer
  admission are not yet dependable. The "Server" connection mode (TS6's SFU) is
  not implemented; only direct P2P works. The UI is gated by a build-time flag,
  because the hosted client updates on every push while the gateway image is
  deployed by hand, and a browser that offers streaming to a gateway too old to
  answer waits forever instead of reporting an error — on since 2026-09-11 for
  client.webspeak3.de now that its gateway answers setupStream/joinStream/
  sendStreamSignal (v0.11.0-beta.1+). The durable fix is a capability handshake
  so the client can detect what its gateway supports rather than assuming;
  until then the flag is flipped by hand whenever the frontend gains a stream
  feature the deployed gateway doesn't have yet.
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

The interface currently assumes a mouse and sighted use; a real pass is
still needed:

- Replace clickable `<div>`s that aren't real `<button>`s with actual
  buttons, so they're reachable and operable by keyboard
- Add keyboard handlers next to the many click-only interactions (channel
  tree, context menus, client list)
- Label icon-only toggle controls (mute, away, streaming, recording, ...)
  with `aria-label`/`aria-pressed` so their state is announced, not just shown
  as a color/icon change
- Fix the document's `lang` attribute to follow the active UI language
  instead of staying fixed
- Manage focus in modals and dialogs: move it in on open, return it on close
- Do a full screen-reader pass (NVDA/VoiceOver) through a real connect
  session to find what else is missing beyond the above

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
