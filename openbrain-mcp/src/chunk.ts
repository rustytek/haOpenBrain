// Markdown-aware chunking with contextual breadcrumbs.
//
// Fixes over v1: paragraphs are re-merged up to maxLen instead of embedded
// one-by-one, oversized paragraphs are hard-split, the minimum-length filter
// applies on every path, and each chunk carries a heading breadcrumb that is
// prepended for embedding (contextual retrieval) without polluting the stored
// content.

export interface Chunk {
  text: string; // stored content
  context: string; // heading breadcrumb, "" for single-chunk captures
}

const MIN_LEN = 40;

function hardSplit(text: string, maxLen: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > maxLen) {
    // Prefer a sentence or line boundary in the back half of the window.
    const window = rest.slice(0, maxLen);
    let cut = Math.max(
      window.lastIndexOf(". ", maxLen - 1),
      window.lastIndexOf("\n", maxLen - 1),
    );
    if (cut < maxLen / 2) cut = maxLen;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1);
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}

function splitParagraphs(text: string, maxLen: number): string[] {
  const paras = text.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let buf = "";
  for (const p of paras) {
    const pieces = p.length > maxLen ? hardSplit(p, maxLen) : [p];
    for (const piece of pieces) {
      if (buf && buf.length + piece.length + 2 > maxLen) {
        out.push(buf);
        buf = piece;
      } else {
        buf = buf ? `${buf}\n\n${piece}` : piece;
      }
    }
  }
  if (buf) out.push(buf);
  return out;
}

export function chunkMarkdown(text: string, maxLen = 1800): Chunk[] {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) {
    return trimmed.length >= 1 ? [{ text: trimmed, context: "" }] : [];
  }

  // Document title = first H1/H2 if present.
  const titleMatch = trimmed.match(/^#{1,2} (.+)$/m);
  const docTitle = titleMatch ? titleMatch[1].trim() : "";

  const sections = trimmed.split(/(?=^#{1,3} )/m).filter((s) => s.trim());
  const chunks: Chunk[] = [];

  for (const section of sections) {
    const headingMatch = section.match(/^#{1,3} (.+)$/m);
    const heading = headingMatch ? headingMatch[1].trim() : "";
    const crumb = [...new Set([docTitle, heading].filter(Boolean))].join(" > ");

    const parts = section.length <= maxLen ? [section.trim()] : splitParagraphs(section, maxLen);
    for (const part of parts) {
      if (part.length < MIN_LEN) continue;
      chunks.push({ text: part, context: crumb });
    }
  }

  // Degenerate case: everything filtered out — keep the head of the document.
  if (chunks.length === 0) chunks.push({ text: trimmed.slice(0, maxLen), context: "" });
  return chunks;
}

// Text sent to the embedding model: breadcrumb situates the chunk in its doc.
export function embedText(c: Chunk): string {
  return c.context ? `[${c.context}]\n\n${c.text}` : c.text;
}
