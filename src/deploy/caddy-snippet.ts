/**
 * Reading and trimming a hosting Caddy snippet (`<state>/hosting/sites/<env>.caddy`).
 *
 * The daemon writes these files itself in one fixed shape, but a file on a host
 * may have been edited by hand, so the reader is strict about what it
 * understands and says so when it does not: a top-level line it cannot place is
 * reported, and the caller then refuses to change a file that might hold a name
 * it is looking for. Nothing here ever deletes a construct it did not
 * recognize.
 *
 * What is understood at the top level: blank lines and `#` comments; `import`
 * lines; a global options block (`{`); a snippet definition (`(name) {`); and
 * site blocks, `address[, address…] {` with an optional `# comment` after the
 * brace. Addresses may be quoted, carry a scheme and a port. A block ends where
 * its braces balance. Anything else at the top level (a brace on the next
 * line, an address list continued after a trailing comma, a line with no
 * brace) is "uninterpretable".
 */

/** One top-level piece of a snippet; its `lines` are verbatim, so joining them all gives the file back. */
export type SnippetItem =
  | {
    kind: "site";
    /** The address tokens as written, quotes removed. */
    addresses: string[];
    lines: string[];
  }
  | {
    kind: "other";
    /** Blank lines and comments carry no meaning; an import, global or snippet definition does. */
    meaningful: boolean;
    lines: string[];
  };

export type ParsedSnippet = {
  items: SnippetItem[];
  /** A top-level line was seen that this reader cannot place. */
  uninterpretable: boolean;
};

/** An address as compared: lowercase, without a scheme, port and path kept as written. */
export function addressKey(token: string): string {
  return token.toLowerCase().replace(/^https?:\/\//, "");
}

/**
 * The text before a `#` comment: a `#` starts one at the beginning of a line or
 * after whitespace, outside quotes.
 */
function withoutComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote !== null) {
      if (ch === "\\" && quote !== "`") i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]!))) {
      return line.slice(0, i);
    }
  }
  return line;
}

/** Braces opened minus closed on one line, outside quotes and comments. */
function braceBalance(line: string): number {
  const text = withoutComment(line);
  let quote: string | null = null;
  let balance = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote !== null) {
      if (ch === "\\" && quote !== "`") i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch === "{") {
      balance += 1;
    } else if (ch === "}") {
      balance -= 1;
    }
  }
  return balance;
}

/** Split an address list on commas and whitespace outside quotes; `null` if a quote is left open. */
function addressTokens(head: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  const flush = () => {
    if (current.length > 0) tokens.push(current);
    current = "";
  };
  for (const ch of head) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "," || /\s/.test(ch)) {
      flush();
    } else {
      current += ch;
    }
  }
  if (quote !== null) return null;
  flush();
  return tokens;
}

type TopLevel =
  | { kind: "import" }
  | { kind: "block"; site: string[] | null }
  | { kind: "unknown" };

/** What a column-0 line is. A site line yields its address tokens; a global or snippet block yields `site: null`. */
function classifyTopLevel(line: string): TopLevel {
  const text = withoutComment(line).trimEnd();
  if (/^import(\s|$)/.test(text)) return { kind: "import" };
  if (!text.endsWith("{")) return { kind: "unknown" };
  const head = text.slice(0, -1);
  if (head.trim().length === 0) return { kind: "block", site: null };
  // A brace glued to the last address (`a.com{`) is not how Caddy reads it.
  if (!/\s$/.test(head)) return { kind: "unknown" };
  const trimmed = head.trim();
  if (/^\([^()\s]+\)$/.test(trimmed)) return { kind: "block", site: null };
  if (trimmed.endsWith(",")) return { kind: "unknown" };
  const tokens = addressTokens(trimmed);
  if (tokens === null || tokens.length === 0) return { kind: "unknown" };
  return { kind: "block", site: tokens };
}

function isNeutral(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length === 0 || trimmed.startsWith("#");
}

/** Take lines from `start` until the braces opened on the first one balance; `closed` is false at the end of the file. */
function takeBlock(
  lines: readonly string[],
  start: number,
): { taken: string[]; closed: boolean } {
  let depth = 0;
  const taken: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    taken.push(lines[i]!);
    depth += braceBalance(lines[i]!);
    if (depth <= 0) return { taken, closed: true };
  }
  return { taken, closed: false };
}

export function parseSnippet(contents: string): ParsedSnippet {
  const lines = contents.split("\n");
  const items: SnippetItem[] = [];
  let uninterpretable = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isNeutral(line)) {
      items.push({ kind: "other", meaningful: false, lines: [line] });
      i += 1;
      continue;
    }
    const top = line.startsWith(" ") || line.startsWith("\t")
      ? ({ kind: "unknown" } as const)
      : classifyTopLevel(line);
    if (top.kind === "block") {
      const { taken, closed } = takeBlock(lines, i);
      if (!closed) uninterpretable = true;
      i += taken.length;
      items.push(
        top.site === null
          ? { kind: "other", meaningful: true, lines: taken }
          : { kind: "site", addresses: top.site, lines: taken },
      );
      continue;
    }
    if (top.kind === "unknown") uninterpretable = true;
    items.push({ kind: "other", meaningful: true, lines: [line] });
    i += 1;
  }
  return { items, uninterpretable };
}

/** The address keys of every site block, as compared (see {@link addressKey}). */
export function snippetSiteAddresses(contents: string): string[] {
  return parseSnippet(contents).items.flatMap((item) =>
    item.kind === "site" ? item.addresses.map(addressKey) : []
  );
}

export type TrimmedSnippet = {
  contents: string;
  /** The named addresses that were taken out. */
  removed: string[];
  /** Site blocks that remain. */
  sitesLeft: number;
  /** An import, global block, snippet definition or unplaceable line remains. */
  otherLeft: boolean;
  uninterpretable: boolean;
};

/**
 * `contents` without the named addresses (matched with {@link addressKey}, so
 * `*.a.com` only ever matches `*.a.com`). A block with other addresses keeps
 * them and its body; a block left with none goes whole. The blank line after a
 * removed block goes with it. Everything that is not a site block is kept.
 */
export function trimSnippetSites(
  contents: string,
  names: ReadonlySet<string>,
): TrimmedSnippet {
  const parsed = parseSnippet(contents);
  const removed = new Set<string>();
  const out: string[] = [];
  let sitesLeft = 0;
  let otherLeft = false;
  let afterDropped = false;
  for (const item of parsed.items) {
    if (item.kind === "other") {
      if (afterDropped && !item.meaningful && item.lines[0]!.trim() === "") {
        afterDropped = false;
        continue;
      }
      afterDropped = false;
      if (item.meaningful) otherLeft = true;
      out.push(...item.lines);
      continue;
    }
    afterDropped = false;
    const remaining = item.addresses.filter((token) => {
      if (!names.has(addressKey(token))) return true;
      removed.add(addressKey(token));
      return false;
    });
    if (remaining.length === 0) {
      afterDropped = true;
      continue;
    }
    sitesLeft += 1;
    if (remaining.length < item.addresses.length) {
      out.push(
        `${remaining.join(", ")} {`,
        ...item.lines.slice(1),
      );
    } else {
      out.push(...item.lines);
    }
  }
  return {
    contents: out.join("\n"),
    removed: [...removed].sort((a, b) => a.localeCompare(b)),
    sitesLeft,
    otherLeft,
    uninterpretable: parsed.uninterpretable,
  };
}
