import { Fragment, type ReactNode } from "react";

// TeamSpeak chat text -> React elements (never HTML strings, so message text
// can't inject markup). Understands the TS3/TS6 BBCode tags plus the basic
// Markdown TS6 sends: Markdown is first rewritten into BBCode, then a single
// parser renders both. Unknown tags stay literal, unclosed tags close at the end.
// ponytail: no [table], nested Markdown lists/quotes, ==highlight==, ||spoiler||,
// math or mermaid - add them once people actually send them.

const TAG_REGEX =
  /\[(\/?)(b|i|u|s|url|img|color|size|left|center|right|list|\*|hr|noparse|md-code|md-quote|md-h)(?:=([^\]]*))?\]/gi;
const BLOCK_TAGS = new Set(["left", "center", "right", "list", "*", "hr", "md-quote", "md-h"]);
export const BARE_URL_REGEX = /https?:\/\/[^\s<>"\[\]]+/g;
const COLOR_REGEX = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|[a-z]+)$/i;
const LIST_STYLES: Record<string, string> = { "1": "decimal", a: "lower-alpha", A: "upper-alpha", i: "lower-roman", I: "upper-roman" };

// Spans Markdown must not touch: noparse, tagged links, inline code, Markdown
// links/images, <autolinks>, bare URLs and backslash escapes.
const MD_SPANS = new RegExp(
  [
    String.raw`\[noparse\][\s\S]*?\[\/noparse\]`,
    String.raw`\[(url|img)(?:=[^\]]*)?\][\s\S]*?\[\/\1\]`,
    String.raw`\x60([^\x60\n]+)\x60`,
    String.raw`(!?)\[([^\]\n]*)\]\(<?(https?:\/\/[^\s)>]+)>?(?:\s[^)\n]*)?\)`,
    String.raw`<(https?:\/\/[^\s>]+)>`,
    BARE_URL_REGEX.source,
    String.raw`\\([\\\x60*_{}\[\]()#+\-.!~>|=])`,
  ].join("|"),
  "gi",
);
// Outgoing: an already-tagged link or Markdown span (left alone) or a bare URL (wrapped).
const WRAP_REGEX = new RegExp(
  String.raw`(\[(url|img)(?:=[^\]]*)?\][\s\S]*?\[\/\2\]|!?\[[^\]\n]*\]\([^)\n]*\)|\x60[^\x60\n]*\x60|<https?:\/\/[^\s>]+>)|` +
    BARE_URL_REGEX.source,
  "gi",
);

interface Node {
  tag: string;
  arg?: string;
  children: (Node | string)[];
}

export interface RenderOptions {
  /** Load [img] / ![](...) inline. Off: they render as links, so no remote host sees the reader's IP. */
  images?: boolean;
}

function emphasis(s: string): string {
  return s
    .replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, "[b]$1[/b]")
    .replace(/~~(?=\S)([^\n]*?\S)~~/g, "[s]$1[/s]")
    .replace(/\+\+(?=\S)([^\n]*?\S)\+\+/g, "[u]$1[/u]")
    .replace(/(^|[^\w*[])\*(?=[^\s\]])([^*\n]*?\S)\*(?![\w*])/g, "$1[i]$2[/i]")
    .replace(/(^|[^\w_[])_(?=[^\s\]])([^_\n]*?\S)_(?![\w_])/g, "$1[i]$2[/i]");
}

function markdownInline(text: string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(MD_SPANS)) {
    out += emphasis(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[2] !== undefined) out += `[md-code][noparse]${m[2]}[/noparse][/md-code]`;
    else if (m[5] !== undefined) out += m[3] ? `[img]${m[5]}[/img]` : `[url=${m[5]}]${m[4] || m[5]}[/url]`;
    else if (m[6] !== undefined) out += m[6];
    else if (m[7] !== undefined) out += `[noparse]${m[7]}[/noparse]`;
    else out += m[0];
  }
  return out + emphasis(text.slice(last));
}

// Line-based Markdown blocks (TS6: one line is one paragraph): lists, quotes,
// headings and rules. Consecutive list/quote lines are grouped.
function markdownBlocks(text: string): string {
  const out: { block: boolean; s: string }[] = [];
  let group = null as { kind: string; items: string[] } | null;
  const flush = () => {
    if (!group) return;
    const s =
      group.kind === "quote"
        ? `[md-quote]${group.items.join("\n")}[/md-quote]`
        : `[list${group.kind === "ol" ? "=1" : ""}]${group.items.map((i) => `[*]${i}`).join("")}[/list]`;
    out.push({ block: true, s });
    group = null;
  };
  for (const line of text.split("\n")) {
    const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    const quote = /^>(?:\s(.*))?$/.exec(line);
    const kind = item ? (/\d/.test(item[1]) ? "ol" : "ul") : quote ? "quote" : null;
    if (kind) {
      if (group?.kind !== kind) flush();
      group ??= { kind, items: [] };
      group.items.push(item ? item[2] : (quote![1] ?? ""));
      continue;
    }
    flush();
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) out.push({ block: true, s: "[hr]" });
    else if (heading) out.push({ block: true, s: `[md-h=${heading[1].length}]${heading[2]}[/md-h]` });
    else out.push({ block: false, s: line });
  }
  flush();
  return out.map((e, i) => (i > 0 && !e.block && !out[i - 1].block ? "\n" : "") + e.s).join("");
}

function parse(text: string): Node {
  const root: Node = { tag: "", children: [] };
  const stack = [root];
  const re = new RegExp(TAG_REGEX.source, "gi");
  let last = 0;
  for (let m; (m = re.exec(text)); ) {
    const top = stack[stack.length - 1];
    if (m.index > last) top.children.push(text.slice(last, m.index));
    last = re.lastIndex;
    const tag = m[2].toLowerCase();
    if (m[1]) {
      const at = stack.findLastIndex((n) => n.tag === tag);
      if (at > 0) stack.length = at;
      else top.children.push(m[0]);
    } else if (tag === "noparse") {
      const end = text.toLowerCase().indexOf("[/noparse]", last);
      const stop = end < 0 ? text.length : end;
      top.children.push({ tag, children: [text.slice(last, stop)] });
      last = re.lastIndex = end < 0 ? stop : end + "[/noparse]".length;
    } else if (tag === "hr") {
      top.children.push({ tag, children: [] });
    } else if (tag === "*") {
      const at = stack.findLastIndex((n) => n.tag === "list");
      if (at > 0) {
        stack.length = at + 1;
        const li: Node = { tag, children: [] };
        stack[at].children.push(li);
        stack.push(li);
      } else top.children.push(m[0]);
    } else {
      const node: Node = { tag, arg: m[3], children: [] };
      top.children.push(node);
      stack.push(node);
    }
  }
  if (last < text.length) stack[stack.length - 1].children.push(text.slice(last));
  return root;
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

function textNode(text: string, key: number, linkUrls = true): ReactNode {
  const parts: ReactNode[] = [];
  text.split("\n").forEach((line, li) => {
    if (li > 0) parts.push(<br key={`br${li}`} />);
    let last = 0;
    if (linkUrls) {
      for (const m of line.matchAll(BARE_URL_REGEX)) {
        if (m.index > last) parts.push(line.slice(last, m.index));
        parts.push(link(m[0], m[0], li * 10000 + m.index));
        last = m.index + m[0].length;
      }
    }
    if (last < line.length) parts.push(line.slice(last));
  });
  return parts.length === 1 && typeof parts[0] === "string" ? parts[0] : <Fragment key={key}>{parts}</Fragment>;
}

function textOf(node: Node): string {
  return node.children.map((c) => (typeof c === "string" ? c : textOf(c))).join("");
}

function fontSize(arg: string | undefined): string | undefined {
  const rel = /^([+-])(\d)$/.exec(arg ?? "");
  if (rel) return `${Math.min(2, Math.max(0.6, 1 + (rel[1] === "+" ? 1 : -1) * Number(rel[2]) * 0.2))}em`;
  return /^\d{1,3}$/.test(arg ?? "") ? `${Math.min(28, Math.max(6, Number(arg)))}pt` : undefined;
}

function render(node: Node, key: number, opts: RenderOptions): ReactNode {
  const isBlock = (c: Node | string | undefined) => typeof c === "object" && BLOCK_TAGS.has(c.tag);
  const kids = () =>
    node.children.map((c, i, all) => {
      if (typeof c !== "string") return render(c, i, opts);
      // Line breaks around block elements are already breaks; drop them.
      let s = c;
      if (i === 0 ? isBlock(node) : isBlock(all[i - 1])) s = s.replace(/^\n/, "");
      if (i === all.length - 1 ? isBlock(node) : isBlock(all[i + 1])) s = s.replace(/\n$/, "");
      if (node.tag === "list" && !s.trim()) return null;
      return textNode(s, i);
    });
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
      return (
        <span key={key} style={node.arg && COLOR_REGEX.test(node.arg) ? { color: node.arg } : undefined}>
          {kids()}
        </span>
      );
    case "size":
      return (
        <span key={key} style={{ fontSize: fontSize(node.arg) }}>
          {kids()}
        </span>
      );
    case "left":
    case "center":
    case "right":
      return (
        <div key={key} style={{ textAlign: node.tag }}>
          {kids()}
        </div>
      );
    case "list": {
      const style = node.arg ? LIST_STYLES[node.arg] : undefined;
      return style ? (
        <ol key={key} className="ts-bb-list" style={{ listStyleType: style }}>
          {kids()}
        </ol>
      ) : (
        <ul key={key} className="ts-bb-list">
          {kids()}
        </ul>
      );
    }
    case "*":
      return <li key={key}>{kids()}</li>;
    case "hr":
      return <hr key={key} className="ts-bb-hr" />;
    case "noparse":
      return textNode(textOf(node), key, false);
    case "md-code":
      return <code key={key}>{kids()}</code>;
    case "md-quote":
      return (
        <blockquote key={key} className="ts-bb-quote">
          {kids()}
        </blockquote>
      );
    case "md-h":
      return (
        <div key={key} className={`ts-bb-h ts-bb-h${node.arg}`}>
          {kids()}
        </div>
      );
    case "url":
    case "img": {
      const href = safeHref(node.arg ?? textOf(node));
      // Plain-text label: a linkified URL or nested tag inside <a> would nest links.
      const label = textOf(node);
      if (!href) return <span key={key}>{label}</span>;
      if (node.tag === "img" && opts.images)
        return link(href, <img className="ts-bb-img" src={href} alt="" loading="lazy" referrerPolicy="no-referrer" />, key);
      return link(href, label, key);
    }
    default:
      return <Fragment key={key}>{kids()}</Fragment>;
  }
}

export function renderBbcode(text: string, opts: RenderOptions = {}): ReactNode {
  return render(parse(markdownInline(markdownBlocks(text.replace(/\r\n?/g, "\n")))), 0, opts);
}

// Outgoing: native clients send links as [URL]...[/URL] and only link those.
export function wrapUrls(text: string): string {
  return text.replace(WRAP_REGEX, (m, kept) => (kept ? m : `[URL]${m}[/URL]`));
}
