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

- Safari and Mobile Safari audio/microphone behavior
- Uncommon TeamSpeak permission combinations and large permission sets
- Very large servers and long-running browser sessions
- Mobile browser behavior across a wider range of devices
- Reverse-proxy and hosting configurations beyond the documented examples

## Next milestones

### Beta hardening

- Expand real-browser audio testing, especially Safari
- Improve reconnect and recovery behavior under unstable networks
- Continue accessibility, keyboard-navigation, and mobile usability work
- Turn recurring deployment and compatibility reports into documentation

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
