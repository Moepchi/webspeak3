/** TeamSpeak / TeaSpeak / GreenTeaSpeak channel spacer helpers.
 *
 * Mirrors GreenTeaSpeak `ChannelTreeBuilder.parseChannelName` / oldclient
 * `ChannelNameParser`: only root channels, tag must contain "spacer", alignment
 * prefix l/c/r/* (empty → left), unique id after "spacer" may be any string
 * (e.g. `[*spacer01]`, `[cspacerabc]`).
 */

export type SpacerAlignment = "left" | "center" | "right" | "repetitive";

export type ParsedChannelName = {
  /** Label shown in the tree (tag stripped for spacers). */
  name: string;
  alignment: SpacerAlignment | null;
};

/** Pure line fillers that look better as a CSS rule than raw `---` / `***`. */
const LINE_FILLER_RE = /^[\-\u2013\u2014\u2500\u2501\u2550=\*\.·_\s]+$/;

/** Corners / verticals of box-frame spacers (not pure horizontal fills). */
const BOX_FRAME_RE = /[╔╗╚╝╒╓╕╖╘╙╛╜┌┐└┘├┤┬┴┼║│╟╢╤╧╪╫╬╒╓╕╖╘╙╛╜]/;

export function parseChannelName(name: string, isRoot: boolean): ParsedChannelName {
  if (!isRoot || name.length < 3 || name.charAt(0) !== "[") {
    return { name, alignment: null };
  }

  const end = name.indexOf("]");
  if (end === -1) return { name, alignment: null };

  let options = name.substring(1, end);
  const spacerIndex = options.indexOf("spacer");
  if (spacerIndex === -1) return { name, alignment: null };

  options = options.substring(0, spacerIndex);
  if (options.length === 0) {
    options = "l";
  } else if (options.length > 1) {
    options = options.charAt(0);
  }

  const alignmentByPrefix: Record<string, SpacerAlignment> = {
    l: "left",
    c: "center",
    r: "right",
    "*": "repetitive",
  };
  const alignment = alignmentByPrefix[options];
  if (!alignment) return { name, alignment: null };

  return {
    name: name.substring(end + 1),
    alignment,
  };
}

/** Same as oldclient `ChannelName`: repeat filler until it fills the tree row. */
export function expandRepetitiveSpacerName(name: string): string {
  if (!name.length) return name;
  let expanded = name;
  while (expanded.length < 8000) {
    expanded += expanded;
  }
  return expanded;
}

export function isLineSpacerFiller(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && LINE_FILLER_RE.test(trimmed);
}

export function hasBoxArtChars(text: string): boolean {
  return BOX_FRAME_RE.test(text);
}

export function spacerDisplayName(rawName: string, isRoot: boolean): {
  label: string;
  alignment: SpacerAlignment | null;
  isSpacer: boolean;
  /** Repetitive `---` / `***` / `═══` → render as CSS line, not character soup. */
  isLine: boolean;
  /** Box-frame spacers (╔╗ / ═) need monospace for GTS look. */
  isBoxArt: boolean;
} {
  const parsed = parseChannelName(rawName, isRoot);
  if (!parsed.alignment) {
    return {
      label: rawName,
      alignment: null,
      isSpacer: false,
      isLine: false,
      isBoxArt: false,
    };
  }

  const isBoxArt = hasBoxArtChars(parsed.name);
  const isLine =
    !isBoxArt &&
    isLineSpacerFiller(parsed.name) &&
    (parsed.alignment === "repetitive" || parsed.alignment === "center");

  let label = parsed.name;
  if (parsed.alignment === "repetitive" && !isLine) {
    label = expandRepetitiveSpacerName(parsed.name);
  }

  return {
    label,
    alignment: parsed.alignment,
    isSpacer: true,
    isLine,
    isBoxArt,
  };
}
