/** Linked `###` headings from a Steam or Epic card's text, in order. */
function headingTitles(blob: string): string[] {
  return [...blob.matchAll(/^###\s+[^[\n]*?\[([^\]]+)\]\(/gm)].map((m) => m[1]!.trim());
}

/** Numbered titles from a Steam digest's text, in order. */
export function extractSteamDigestTitles(blob: string): string[] {
  return [...blob.matchAll(/^\*\*\d+\.\s+\[([^\]]+)\]\(/gm)].map((m) => m[1]!.trim());
}

/** Free and upcoming titles from an Epic card's text, in order. */
export function extractEpicTitles(blob: string): string[] {
  return headingTitles(blob);
}

/** Flatten Components V2 + embeds to plain text for duplicate detection. */
export function collectMessageTextContent(message: {
  content?: string | null;
  embeds?: {
    author?: { name?: string | null } | null;
    title?: string | null;
    description?: string | null;
    fields?: { name: string; value?: string }[];
    footer?: { text?: string | null } | null;
  }[];
  components?: readonly unknown[];
}): string {
  const chunks: string[] = [];
  if (message.content) chunks.push(message.content);

  for (const embed of message.embeds ?? []) {
    if (embed.author?.name) chunks.push(embed.author.name);
    if (embed.title) chunks.push(embed.title);
    if (embed.description) chunks.push(embed.description);
    for (const f of embed.fields ?? []) {
      chunks.push(f.name);
      if (f.value) chunks.push(f.value);
    }
    if (embed.footer?.text) chunks.push(embed.footer.text);
  }

  const walk = (node: unknown, depth = 0): void => {
    if (!node || typeof node !== 'object' || depth > 12) return;
    const obj = node as Record<string, unknown>;
    // Builders and received components carry the same text in `data`, getters,
    // and their JSON. Reading only the JSON keeps each line once, so a digest
    // reads back exactly the titles it shows.
    if (typeof obj.toJSON === 'function') {
      try {
        walk(obj.toJSON(), depth + 1);
      } catch {
        /* ignore */
      }
      return;
    }
    if (typeof obj.content === 'string') chunks.push(obj.content);
    if (Array.isArray(obj.components)) {
      for (const child of obj.components) walk(child, depth + 1);
    }
    if (obj.accessory) walk(obj.accessory, depth + 1);
  };

  for (const top of message.components ?? []) walk(top);
  return chunks.join('\n');
}

export function looksLikeSteamDigest(blob: string): boolean {
  return /steam daily deals|steam sales/i.test(blob);
}

export function looksLikeEpicDigest(blob: string): boolean {
  return /epic free games|epic games store/i.test(blob);
}
