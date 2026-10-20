import { decodeHtmlEntities } from "../../../../../utils/html-entities";

export interface FeedElement {
  name: string;
  localName: string;
  namespace: string;
  namespaces: Record<string, string>;
  attributes: Record<string, string>;
  base: string;
  content: (FeedElement | string)[];
  innerStart: number;
  innerEnd: number;
}

export function resolveFeedUrl(value: string, base: string): string {
  if (!value.trim()) return "";
  try {
    return new URL(value.trim(), base).href;
  } catch {
    // Intentional ignore: malformed optional feed links are treated as absent.
    return "";
  }
}

// Read the structure of a syndication document without executing declarations or
// resolving entities. Descendant source/content metadata must not impersonate
// an entry's direct children. This is deliberately not a validating XML parser.
export function parseFeedXml(xml: string, base: string): FeedElement | null {
  const tokens = /<!DOCTYPE(?:[^<>"'\[]|"[^"]*"|'[^']*')*>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[A-Za-z_][\w.:-]*(?:[^<>"']|"[^"]*"|'[^']*')*>|[^<]+/g;
  const stack: FeedElement[] = [];
  let root: FeedElement | null = null;
  let offset = 0;
  for (const match of xml.matchAll(tokens)) {
    if (match.index !== offset) return null;
    const token = match[0];
    offset += token.length;
    if (token.startsWith("<!--") || token.startsWith("<?") || token.startsWith("<!DOCTYPE")) continue;
    if (token.startsWith("<![CDATA[")) {
      if (!stack.length) return null;
      stack.at(-1)!.content.push(token.slice(9, -3));
      continue;
    }
    if (!token.startsWith("<")) {
      if (stack.length) stack.at(-1)!.content.push(decodeHtmlEntities(token));
      else if (token.trim()) return null;
      continue;
    }
    if (token.startsWith("</")) {
      const node = stack.pop();
      if (!node || token.slice(2, -1).trim() !== node.name) return null;
      node.innerEnd = match.index;
      continue;
    }
    const opening = token.match(/^<([A-Za-z_][\w.:-]*)/)!;
    const name = opening[1]!;
    const selfClosing = token.endsWith("/>");
    const rawAttributes = token.slice(opening[0].length, selfClosing ? -2 : -1);
    const attributes: Record<string, string> = Object.create(null);
    const attributePattern = /\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gy;
    let cursor = 0;
    while (cursor < rawAttributes.length && rawAttributes.slice(cursor).trim()) {
      attributePattern.lastIndex = cursor;
      const attr = attributePattern.exec(rawAttributes);
      if (!attr || Object.hasOwn(attributes, attr[1]!)) return null;
      attributes[attr[1]!] = decodeHtmlEntities(attr[2] ?? attr[3]!);
      cursor = attributePattern.lastIndex;
    }
    const parent = stack.at(-1);
    const namespaces: Record<string, string> = { ...parent?.namespaces };
    for (const [key, value] of Object.entries(attributes)) {
      if (key === "xmlns") namespaces[""] = value;
      else if (key.startsWith("xmlns:")) namespaces[key.slice(6)] = value;
    }
    const colon = name.indexOf(":");
    const prefix = colon < 0 ? "" : name.slice(0, colon);
    if (prefix && !namespaces[prefix]) return null;
    const inheritedBase = parent?.base ?? base;
    const node: FeedElement = {
      name,
      localName: colon < 0 ? name : name.slice(colon + 1),
      namespace: namespaces[prefix] ?? "",
      namespaces,
      attributes,
      base: attributes["xml:base"] != null
        ? resolveFeedUrl(attributes["xml:base"], inheritedBase) || inheritedBase
        : inheritedBase,
      content: [],
      innerStart: offset,
      innerEnd: offset,
    };
    if (parent) parent.content.push(node);
    else if (root) return null;
    else root = node;
    if (!selfClosing) stack.push(node);
    if (stack.length > 128) return null;
  }
  return offset === xml.length && stack.length === 0 ? root : null;
}

export function feedChildren(node: FeedElement, name: string, namespace = node.namespace): FeedElement[] {
  return node.content.filter((child): child is FeedElement => typeof child !== "string"
    && child.localName === name && child.namespace === namespace);
}

export function feedText(node: FeedElement | undefined): string {
  const content = (element: FeedElement): string => element.content
    .map((part) => typeof part === "string" ? part : content(part)).join("");
  return node ? content(node).trim() : "";
}
