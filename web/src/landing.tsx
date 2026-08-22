import { StrictMode, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./landing.css";

const github = "https://github.com/Moepchi/webspeak3";
const demo = "https://demo.webspeak3.de/";
const client = "https://client.webspeak3.de/";

type Lang = "de" | "en";
type PhoneStyle = "android" | "iphone";

function detectPhoneStyle(): PhoneStyle {
  const device = `${navigator.userAgent} ${navigator.platform}`.toLowerCase();
  return /iphone|ipad|ipod|macintosh|mac os/.test(device) ? "iphone" : "android";
}

const copy = {
  de: {
    nav: ["Features", "Architektur", "Installation"], client: "Client öffnen", hero: ["Direkt im Browser.", "Dein vertrauter Voice-Client, neu gedacht fürs Web. Ohne Installation, ohne Cloud-Zwang – einfach Tab öffnen und verbinden."],
    demo: "Live Demo starten", github: "Auf GitHub ansehen", demoNote: "Die Demo nutzt simulierte Daten – ganz ohne echten Server.", built: "Gebaut mit",
    featureKicker: "ALLES, WAS DU BRAUCHST", featureTitle: "Voice-Chat ohne Kompromisse.", featureIntro: "Die Funktionen, die du von einem Desktop-Client erwartest – in einer modernen, offenen Web-App.",
    features: [["voice", "Voice ohne Umwege", "Opus-Audio mit geringer Latenz, Sprachaktivierung, Gerätewahl und anpassbarer Empfindlichkeit."],["chat", "Chat, der alles bündelt", "Channel-, Server- und private Chats in übersichtlichen Tabs – inklusive Server-Events."],["tree", "Live Channel Tree", "Channels, Nutzer, Status, Länderflaggen und Wechsel in Echtzeit – vertraut, aber fürs Web gedacht."],["whisper", "Gezieltes Whispern", "Sprich mit einzelnen Clients oder ganzen Channels, ohne deinen aktuellen Raum zu stören."],["docker", "Self-hosted by design", "Ein Container für Web-App, Gateway und Connector. Deine Instanz, deine Regeln – mit freier Serverwahl."],["mobile", "Unterwegs verbunden", "Eine echte responsive Oberfläche für schmale Displays – nicht nur Desktop in klein."]] as const,
    privacyKicker: "PRIVATSPHÄRE EINGEBAUT", privacyTitle: ["Dein Web-Client.", "Freie Serverwahl."], privacyText: "Du hostest nur WebSpeak3 und sein Gateway selbst. Von dort verbindest du dich mit jedem erreichbaren TeamSpeak-Server – egal, wo er läuft oder wem er gehört.", privacyList: ["WebSpeak3 vollständig selbst hostbar", "Freie Wahl des TeamSpeak-Servers", "Am Zielserver ist keine Änderung nötig"], control: ["Kontrolle über", "deinen Client"],
    architectureKicker: "UNTER DER HAUBE", architectureTitle: "Vom Tab zu jedem Server.", architectureText: "Dein selbst gehostetes Gateway übersetzt WebSocket-Nachrichten in das echte TeamSpeak-Protokoll und verbindet dich mit dem gewünschten Server.",
    screenKicker: "FÜR JEDEN BILDSCHIRM", screenTitle: ["Desktop-Komfort.", "Mobile Freiheit."], screenText: "Dark oder Light, großer Monitor oder Smartphone: WebSpeak3 passt sich an, ohne Kernfunktionen zu verstecken.",
    statusKicker: "OFFEN ENTWICKELT", statusTitle: "Beta, aber schon ziemlich gesprächig.", statusText: "WebSpeak3 ist ein aktiver Prototyp. Diese Übersicht zeigt transparent, was heute bereits funktioniert und wo noch Feinschliff folgt.", statusLabels: ["Verfügbar", "In Arbeit", "Als Nächstes"], statusCards: [["Voice, Chat & Channel Tree", "Echte TS3/TS6-Verbindungen, Opus-Audio, Whisper, Chats und Live-Status."], ["Browser-Kompatibilität", "Audioausgabe und Mikrofonverhalten werden für weitere Browser und Geräte verfeinert."], ["Mehr Komfort", "Weitere Desktop-Client-Details, stabilere Randfälle und Community-Feedback."]], roadmap: "Roadmap und Issues ansehen",
    tourKicker: "LIVE ERKUNDEN", tourTitle: "Der Client, erklärt im Kontext.", tourText: "Wähle einen Bereich und sieh direkt, wo die wichtigsten Funktionen im WebSpeak3-Client sitzen.", tourItems: [["tree", "Channel Tree", "Channels, Nutzer und Status wechseln in Echtzeit."], ["chat", "Chat & Events", "Server-, Channel- und Direktnachrichten bleiben übersichtlich getrennt."], ["voice", "Voice Controls", "Mikrofon, Lautsprecher, Aktivierung und Pegel immer griffbereit."], ["whisper", "Whisper", "Gezielt einzelne Nutzer oder komplette Channels ansprechen."]],
    installKicker: "IN MINUTEN STARTKLAR", installTitle: "Dein WebSpeak3. Jeder Server.", installText: "Hoste den Browser-Client mit Docker selbst und verbinde dich anschließend mit jedem erreichbaren TeamSpeak-Server.", installSteps: [["01", "WebSpeak3 starten", "Container laden und Port 8080 veröffentlichen."], ["02", "Browser öffnen", "WebSpeak3 lokal oder über deine Domain aufrufen."], ["03", "Server frei wählen", "Beliebige TS-Adresse und deinen Nickname eingeben – fertig."]], installGuide: "Installationsanleitung", copyCommand: "Befehl kopieren", copied: "Kopiert!",
    faqKicker: "GUT ZU WISSEN", faqTitle: "Fragen, bevor du loslegst.", faqs: [["Bin ich an einen bestimmten TeamSpeak-Server gebunden?", "Nein. Du kannst jede erreichbare TS3- oder TS6-Serveradresse eingeben – unabhängig davon, wer den Server hostet oder wo er läuft."], ["Was muss ich selbst hosten?", "Nur WebSpeak3 mit Gateway und Connector. Der TeamSpeak-Server kann dein eigener, der eines Freundes oder ein beliebiger anderer erreichbarer Server sein."], ["Wo laufen meine Sprachdaten?", "Sie laufen über deine WebSpeak3-Instanz direkt zum ausgewählten TeamSpeak-Server – ohne eine zentrale WebSpeak3-Cloud."], ["Welche Browser werden unterstützt?", "Moderne Chromium- und Firefox-Browser sind das Hauptziel. Einzelne Audiofunktionen können je nach Browser und Gerät abweichen."], ["Benötigt WebSpeak3 Zugriff auf mein Mikrofon?", "Erst wenn du das Mikrofon aktivierst. Dann fragt der Browser wie üblich nach deiner Erlaubnis."], ["Ist das Projekt produktionsreif?", "WebSpeak3 ist aktuell als Beta beziehungsweise Prototyp gekennzeichnet. Teste deine gewünschte Umgebung daher vor einem breiten Einsatz."], ["Kann ich mithelfen?", "Ja. Fehlerberichte, Ideen und Beiträge sind über das öffentliche GitHub-Repository willkommen."]],
    disclaimer: "Ein unabhängiges Open-Source-Projekt. Nicht mit TeamSpeak Systems GmbH verbunden.", imageAlt: "WebSpeak3 Client im Dark Mode",
  },
  en: {
    nav: ["Features", "Architecture", "Installation"], client: "Open client", hero: ["Right in your browser.", "The voice client you know, reimagined for the web. No installation, no cloud lock-in — just open a tab and connect."],
    demo: "Launch live demo", github: "View on GitHub", demoNote: "The demo uses simulated data — no real server required.", built: "Built with",
    featureKicker: "EVERYTHING YOU NEED", featureTitle: "Voice chat without compromise.", featureIntro: "Everything you expect from a desktop client — inside a modern, open web app.",
    features: [["voice", "Voice without detours", "Low-latency Opus audio, voice activation, device selection and adjustable sensitivity."],["chat", "Chat that brings it together", "Channel, server and private chats in clear tabs — including live server events."],["tree", "Live channel tree", "Channels, users, status icons, country flags and switching in real time — familiar, built for the web."],["whisper", "Targeted whisper", "Talk to individual clients or entire channels without interrupting your current room."],["docker", "Self-hosted by design", "One container for the web app, gateway and connector. Your instance, your rules — with free choice of server."],["mobile", "Connected on the go", "A truly responsive interface for narrow screens — not merely a shrunken desktop UI."]] as const,
    privacyKicker: "PRIVACY BUILT IN", privacyTitle: ["Your web client.", "Your choice of server."], privacyText: "You only self-host WebSpeak3 and its gateway. From there, connect to any reachable TeamSpeak server — no matter where it runs or who hosts it.", privacyList: ["WebSpeak3 is fully self-hostable", "Free choice of TeamSpeak server", "No changes required on the target server"], control: ["Control over", "your client"],
    architectureKicker: "UNDER THE HOOD", architectureTitle: "From your tab to any server.", architectureText: "Your self-hosted gateway translates WebSocket messages into the real TeamSpeak protocol and connects you to the server you choose.",
    screenKicker: "FOR EVERY SCREEN", screenTitle: ["Desktop comfort.", "Mobile freedom."], screenText: "Dark or light, large display or smartphone: WebSpeak3 adapts without hiding core functionality.",
    statusKicker: "BUILT IN THE OPEN", statusTitle: "Beta, but already quite talkative.", statusText: "WebSpeak3 is an active prototype. This overview is transparent about what works today and where refinement is still underway.", statusLabels: ["Available", "In progress", "Up next"], statusCards: [["Voice, chat & channel tree", "Real TS3/TS6 connections, Opus audio, whisper, chats and live status."], ["Browser compatibility", "Audio output and microphone behavior are being refined across more browsers and devices."], ["More polish", "More desktop-client details, resilient edge cases and community feedback."]], roadmap: "View roadmap and issues",
    tourKicker: "EXPLORE IT LIVE", tourTitle: "The client, explained in context.", tourText: "Choose an area to see exactly where WebSpeak3 keeps its most important features.", tourItems: [["tree", "Channel tree", "Channels, users and status update in real time."], ["chat", "Chat & events", "Server, channel and direct messages stay clearly separated."], ["voice", "Voice controls", "Microphone, speakers, activation and levels remain within reach."], ["whisper", "Whisper", "Talk directly to individual users or complete channels."]],
    installKicker: "READY IN MINUTES", installTitle: "Your WebSpeak3. Any server.", installText: "Self-host the browser client with Docker, then connect to any reachable TeamSpeak server.", installSteps: [["01", "Start WebSpeak3", "Pull the container and publish port 8080."], ["02", "Open your browser", "Visit WebSpeak3 locally or through your domain."], ["03", "Choose any server", "Enter any TS address and your nickname — done."]], installGuide: "Installation guide", copyCommand: "Copy command", copied: "Copied!",
    faqKicker: "GOOD TO KNOW", faqTitle: "Questions before you start.", faqs: [["Am I tied to a specific TeamSpeak server?", "No. Enter any reachable TS3 or TS6 server address, regardless of where it runs or who hosts it."], ["What do I need to self-host?", "Only WebSpeak3 with its gateway and connector. The TeamSpeak server can be yours, a friend's, or any other reachable server."], ["Where does my voice data go?", "It travels through your WebSpeak3 instance directly to the selected TeamSpeak server — without a central WebSpeak3 cloud."], ["Which browsers are supported?", "Modern Chromium and Firefox browsers are the main targets. Individual audio features may vary by browser and device."], ["Does WebSpeak3 need microphone access?", "Only when you enable the microphone. Your browser will then ask for permission as usual."], ["Is the project production-ready?", "WebSpeak3 is currently marked as a beta/prototype. Test your intended environment before rolling it out broadly."], ["Can I contribute?", "Yes. Bug reports, ideas and contributions are welcome through the public GitHub repository."]],
    disclaimer: "An independent open-source project. Not affiliated with TeamSpeak Systems GmbH.", imageAlt: "WebSpeak3 client in dark mode",
  },
} as const;

function Icon({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    voice: <><path d="M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z"/><path d="M5 10.5a7 7 0 0 0 14 0M12 17.5V22M8.5 22h7"/></>,
    chat: <><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z"/><path d="M8 9h8M8 13h5"/></>,
    tree: <><path d="M5 4v16M5 8h6M5 16h6"/><rect x="11" y="5" width="8" height="6" rx="2"/><rect x="11" y="13" width="8" height="6" rx="2"/></>,
    whisper: <><path d="M4 13a8 8 0 0 1 8-8M4 18A13 13 0 0 1 17 5"/><path d="M14 13a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM12 15v6"/></>,
    docker: <><path d="M3 11h18c0 6-3 9-9 9s-9-3-9-9Z"/><path d="M7 11V7h4v4M11 11V5h4v6M15 11V7h4v4"/></>,
    mobile: <><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 5h4M11 19h2"/></>,
    lock: <><rect x="4" y="10" width="16" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></>,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

function Landing() {
  const [lang, setLang] = useState<Lang>(() => {
    const saved = localStorage.getItem("webspeak3:landing-language");
    if (saved === "de" || saved === "en") return saved;
    return navigator.language.toLowerCase().startsWith("de") ? "de" : "en";
  });
  const t = copy[lang];
  const [activeTour, setActiveTour] = useState(0);
  const [copied, setCopied] = useState(false);
  const [phoneStyle] = useState<PhoneStyle>(detectPhoneStyle);

  const copyDockerCommand = () => {
    navigator.clipboard?.writeText("docker run -d -p 8080:8080 --name webspeak3 moepchi/webspeak3:latest");
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  useEffect(() => {
    localStorage.setItem("webspeak3:landing-language", lang);
    document.documentElement.lang = lang;
    document.title = lang === "de"
      ? "WebSpeak3 – TeamSpeak 3 im Browser | Open Source"
      : "WebSpeak3 – TeamSpeak 3 in Your Browser | Open Source";
  }, [lang]);

  useEffect(() => {
    const elements = document.querySelectorAll<HTMLElement>(".reveal");
    const observer = new IntersectionObserver(
      entries => entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      }),
      { threshold: 0.14 },
    );
    elements.forEach(element => observer.observe(element));
    return () => observer.disconnect();
  }, []);

  return <div className="landing">
    <div className="ambient ambient-one"></div><div className="ambient ambient-two"></div>
    <header className="nav shell">
      <a className="brand" href="#top"><img src="../logo.png" alt=""/><span>WebSpeak<span>3</span></span></a>
      <nav aria-label={lang === "de" ? "Hauptnavigation" : "Main navigation"}><a href="#features">{t.nav[0]}</a><a href="#architecture">{t.nav[1]}</a><a href="#install">{t.nav[2]}</a></nav>
      <div className="nav-actions"><div className="language-switch" role="group" aria-label={lang === "de" ? "Sprache wählen" : "Choose language"}><button className={lang === "de" ? "active" : ""} onClick={() => setLang("de")} aria-pressed={lang === "de"}>DE</button><button className={lang === "en" ? "active" : ""} onClick={() => setLang("en")} aria-pressed={lang === "en"}>EN</button></div><a className="nav-github" href={github} target="_blank" rel="noreferrer">GitHub <span>↗</span></a></div>
    </header>

    <main id="top">
      <section className="hero shell">
        <div className="hero-copy">
          <div className="eyebrow"><span></span> Open Source · Self-hosted · Beta</div>
          <h1>TeamSpeak 3.<br/><em>{t.hero[0]}</em></h1>
          <p>{t.hero[1]}</p>
          <div className="actions hero-actions"><a className="button primary" href={client}>{t.client} <span>→</span></a><a className="button secondary" href={demo}>{t.demo}</a><a className="button tertiary" href={github} target="_blank" rel="noreferrer">{t.github} ↗</a></div>
          <p className="demo-note"><span>●</span> {t.demoNote}</p>
          <div className="hero-stats"><span><strong>&lt; 30 ms</strong> Voice latency</span><span><strong>100%</strong> self-hosted</span><span><strong>MIT</strong> open source</span></div>
        </div>
        <div className="hero-visual">
          <div className="glow"></div>
          <div className="app-frame"><div className="frame-bar"><i></i><i></i><i></i><span>WebSpeak3 · Demo Server</span></div><img src="../screenshots/webspeak_dark.png" alt={t.imageAlt}/></div>
          <div className="signal-card"><span className="signal">▥</span><div><strong>Voice connected</strong><small>Opus · 48 kHz · 24 ms</small></div><b></b></div>
          <div className="voice-waves" aria-hidden="true">{[1,2,3,4,5,6,7,8,9,10,11,12].map(n=><i key={n}></i>)}</div>
        </div>
      </section>

      <section className="trust shell reveal"><span>{t.built}</span>{["React","TypeScript","Vite","Node.js","Rust","Docker"].map(x=><strong key={x}>{x}</strong>)}</section>

      <section className="section shell reveal" id="features">
        <div className="section-head"><div><span className="kicker">{t.featureKicker}</span><h2>{t.featureTitle}</h2></div><p>{t.featureIntro}</p></div>
        <div className="feature-grid">{t.features.map(([icon,title,description],index)=><article className={`feature-${index + 1}`} key={icon}><span className="card-index">0{index + 1}</span><div className="icon"><Icon name={icon}/></div><h3>{title}</h3><p>{description}</p>{index === 0 && <div className="mini-wave" aria-hidden="true">{[1,2,3,4,5,6,7,8,9].map(n=><i key={n}></i>)}</div>}</article>)}</div>
      </section>

      <section className="privacy reveal"><div className="shell privacy-inner"><div className="privacy-copy"><div className="icon large"><Icon name="lock"/></div><span className="kicker">{t.privacyKicker}</span><h2>{t.privacyTitle[0]}<br/>{t.privacyTitle[1]}</h2><p>{t.privacyText}</p><ul>{t.privacyList.map(item => <li key={item}>{item}</li>)}</ul></div><div className="privacy-card"><div className="orbit orbit-outer"><i></i></div><div className="orbit orbit-inner"><i></i></div><span>SELF-HOSTED</span><strong>100%</strong><small>{t.control[0]}<br/>{t.control[1]}</small></div></div></section>

      <section className="section shell status reveal" id="status"><div className="section-head"><div><span className="kicker">{t.statusKicker}</span><h2>{t.statusTitle}</h2></div><p>{t.statusText}</p></div><div className="status-grid">{t.statusCards.map(([title, description], index) => <article key={title}><span className={`status-dot status-${index}`}></span><small>{t.statusLabels[index]}</small><h3>{title}</h3><p>{description}</p></article>)}</div><a className="text-link status-link" href={`${github}/issues`} target="_blank" rel="noreferrer">{t.roadmap} <span>↗</span></a></section>

      <section className="section shell architecture reveal" id="architecture"><div className="section-head centered"><div><span className="kicker">{t.architectureKicker}</span><h2>{t.architectureTitle}</h2></div><p>{t.architectureText}</p></div><div className="flow">{[["Browser","React + Web Audio"],["Gateway","WebSocket · Node.js"],["Rust Connector","tsclientlib + Opus"],["TeamSpeak Server","TS3 / TS6 Protocol"]].map((x,i)=><div className="flow-wrap" style={{"--delay": `${i * 120}ms`} as React.CSSProperties} key={x[0]}><div className="flow-node"><span>0{i+1}</span><strong>{x[0]}</strong><small>{x[1]}</small></div>{i<3&&<div className="flow-arrow" aria-hidden="true"><i></i></div>}</div>)}</div></section>

      <section className="section shell showcase reveal"><div className="showcase-copy"><span className="kicker">{t.screenKicker}</span><h2>{t.screenTitle[0]}<br/>{t.screenTitle[1]}</h2><p>{t.screenText}</p><div className="theme-pills"><span>☾ Dark Mode</span><span>☀ Light Mode</span><span>⌁ Responsive</span></div></div><div className="screens"><img className="screen-desktop" src="../screenshots/webspeak_current.png" alt="WebSpeak3 Desktop Client"/><div className={`phone-frame phone-${phoneStyle}`} data-device-frame={phoneStyle}><i className="phone-button phone-button-left" aria-hidden="true"></i><i className="phone-button phone-button-right" aria-hidden="true"></i><div className="phone-sensor" aria-hidden="true"><span></span><b></b></div><img src="../screenshots/webspeak_mobile.png" alt="WebSpeak3 Mobile Client"/><div className="phone-home" aria-hidden="true"></div></div></div></section>

      <section className="section shell product-tour reveal"><div className="section-head"><div><span className="kicker">{t.tourKicker}</span><h2>{t.tourTitle}</h2></div><p>{t.tourText}</p></div><div className="tour-layout"><div className="tour-screen"><div className="tour-image"><img src="../screenshots/webspeak_current.png" alt={t.imageAlt}/>{t.tourItems.map((item, index) => <button key={item[0]} className={`hotspot hotspot-${item[0]} ${activeTour === index ? "active" : ""}`} onClick={() => setActiveTour(index)} aria-label={item[1]} aria-pressed={activeTour === index}><span>{index + 1}</span></button>)}</div><div className="tour-caption"><span>0{activeTour + 1}</span><div><strong>{t.tourItems[activeTour][1]}</strong><p>{t.tourItems[activeTour][2]}</p></div></div></div><div className="tour-tabs">{t.tourItems.map((item, index) => <button key={item[0]} className={activeTour === index ? "active" : ""} onClick={() => setActiveTour(index)}><span>0{index + 1}</span><div><strong>{item[1]}</strong><small>{item[2]}</small></div></button>)}</div></div></section>

      <section className="install shell reveal" id="install"><span className="kicker">{t.installKicker}</span><h2>{t.installTitle}</h2><p>{t.installText}</p><div className="install-steps">{t.installSteps.map(([number, title, description]) => <article key={number}><span>{number}</span><div><strong>{title}</strong><small>{description}</small></div></article>)}</div><div className="command"><code><i>$</i> docker run -d -p 8080:8080 --name webspeak3 moepchi/webspeak3:latest</code><button className={copied ? "copied" : ""} onClick={copyDockerCommand} aria-label={t.copyCommand}>{copied ? `✓ ${t.copied}` : "⧉"}</button></div><div className="actions centered-actions"><a className="button primary" href={`${github}#-installation`} target="_blank" rel="noreferrer">{t.installGuide} <span>→</span></a><a className="text-link" href="https://hub.docker.com/r/moepchi/webspeak3" target="_blank" rel="noreferrer">Docker Hub ↗</a></div></section>

      <section className="section shell faq reveal"><div className="section-head centered"><div><span className="kicker">{t.faqKicker}</span><h2>{t.faqTitle}</h2></div></div><div className="faq-list">{t.faqs.map(([question, answer], index) => <details key={question} open={index === 0}><summary><span>0{index + 1}</span>{question}<i>+</i></summary><p>{answer}</p></details>)}</div></section>
    </main>

    <footer><div className="shell footer-inner"><a className="brand" href="#top"><img src="../logo.png" alt=""/><span>WebSpeak<span>3</span></span></a><p>{t.disclaimer}</p><div><a href={`${github}/blob/main/LICENSE`}>MIT License</a><a href={github}>GitHub</a><a href={`${github}/issues`}>Issues</a></div></div></footer>
  </div>;
}

createRoot(document.getElementById("landing-root")!).render(<StrictMode><Landing /></StrictMode>);
