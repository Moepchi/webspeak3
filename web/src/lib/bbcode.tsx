import { Fragment, type ReactNode } from "react";

// TeamSpeak chat BBCode -> React elements (never HTML strings, so message text
// can't inject markup). Unknown tags stay as literal text, unclosed tags close
// at the end of the message, and bare URLs are linked too.
// ponytail: only the inline tags people actually send; [list]/[table]/[img]
// render as plain text ([img] as a link, so it never loads a remote image).

const TAG_REGEX = /\[(\/?)(b|i|u|s|url|img|color)(?:=([^\]]*))?\]/gi;
const BARE_URL_REGEX = /https?:\/\/[^\s<>"\[\]]+/g;
const COLOR_REGEX = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|[a-z]+)$/i;

interface Node {
  tag: string;
  arg?: string;
  children: (Node | string)[];
}

function safeHref(raw: string): string | null {
  const url = raw.trim();
  return /^https?:\/\//i.test(url) ? url : /^www\./i.test(url) ? `https://${url}` : null;
}

function link(href: string, children: ReactNode, key: number) {
  return (
    <a key={key} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

function linkify(text: string, key: number): ReactNode {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(BARE_URL_REGEX)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(link(m[0], m[0], m.index));
    last = m.index + m[0].length;
  }
  if (last === 0) return text;
  if (last < text.length) parts.push(text.slice(last));
  return <Fragment key={key}>{parts}</Fragment>;
}

function textOf(node: Node): string {
  return node.children.map((c) => (typeof c === "string" ? c : textOf(c))).join("");
}

function render(node: Node, key: number): ReactNode {
  const kids = () => node.children.map((c, i) => (typeof c === "string" ? linkify(c, i) : render(c, i)));
  switch (node.tag) {
    case "b":
      return <strong key={key}>{kids()}</strong>;
    case "i":
      return <em key={key}>{kids()}</em>;
    case "u":
      return <u key={key}>{kids()}</u>;
    case "s":
      return <s key={key}>{kids()}</s>;
    case "color":
      return node.arg && COLOR_REGEX.test(node.arg) ? (
        <span key={key} style={{ color: node.arg }}>
          {kids()}
        </span>
      ) : (
        <span key={key}>{kids()}</span>
      );
    case "url":
    case "img": {
      const href = safeHref(node.arg ?? textOf(node));
      // Plain-text label: a linkified URL or nested tag inside <a> would nest links.
      const label = textOf(node);
      return href ? link(href, label, key) : <span key={key}>{label}</span>;
    }
    default:
      return <Fragment key={key}>{kids()}</Fragment>;
  }
}

export function renderBbcode(text: string): ReactNode {
  const root: Node = { tag: "", children: [] };
  const stack = [root];
  let last = 0;
  for (const m of text.matchAll(TAG_REGEX)) {
    const top = stack[stack.length - 1];
    if (m.index > last) top.children.push(text.slice(last, m.index));
    last = m.index + m[0].length;
    const tag = m[2].toLowerCase();
    if (m[1]) {
      const at = stack.findLastIndex((n) => n.tag === tag);
      if (at > 0) stack.length = at;
      else top.children.push(m[0]);
    } else {
      const node: Node = { tag, arg: m[3], children: [] };
      top.children.push(node);
      stack.push(node);
    }
  }
  if (last < text.length) stack[stack.length - 1].children.push(text.slice(last));
  return render(root, 0);
}
