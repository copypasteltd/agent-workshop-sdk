import path from "node:path";
import type { RunConversationAttachment } from "@lingban/contracts";

const imageExtensionPattern = /\.(?:png|jpe?g|gif|webp|svg)(?:[?#].*)?$/i;
const remoteSourcePattern = /^(?:https?:|data:|blob:|\/\/|#)/i;

type ImageCandidate = {
  label: string | null;
  source: string;
};

function decodeImageSource(value: string) {
  const trimmed = value.trim().replace(/^<|>$/g, "");
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

function markdownDestination(value: string) {
  const trimmed = value.trim();
  if (trimmed.startsWith("<")) {
    const end = trimmed.indexOf(">");
    return end > 0 ? trimmed.slice(1, end) : trimmed;
  }

  const titleMatch = trimmed.match(/^(.+?)\s+(?:"[^"]*"|'[^']*')\s*$/);
  return titleMatch?.[1] ?? trimmed;
}

function collectMarkdownImages(text: string) {
  const candidates: ImageCandidate[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const start = text.indexOf("![", cursor);
    if (start < 0) break;
    const altEnd = text.indexOf("](", start + 2);
    if (altEnd < 0) break;

    let index = altEnd + 2;
    let depth = 1;
    let quote: string | null = null;
    let escaped = false;
    for (; index < text.length; index += 1) {
      const character = text[index]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (quote) {
        if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === "(") depth += 1;
      if (character === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }

    if (depth !== 0) {
      cursor = altEnd + 2;
      continue;
    }

    candidates.push({
      label: text.slice(start + 2, altEnd).trim() || null,
      source: markdownDestination(text.slice(altEnd + 2, index)),
    });
    cursor = index + 1;
  }

  return candidates;
}

function collectHtmlImages(text: string) {
  const candidates: ImageCandidate[] = [];
  const pattern = /<img\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/gi;
  for (const match of text.matchAll(pattern)) {
    candidates.push({ label: null, source: match[2] ?? "" });
  }
  return candidates;
}

function collectPathMentions(text: string) {
  const candidates: ImageCandidate[] = [];
  const pattern = /(?:^|[\s'"`(:])((?:\.\.\/|\.\/|\/workspace\/target\/|(?:[\w.-]+\/)+)?[\w.-]+\.(?:png|jpe?g|gif|webp|svg)(?:[?#][^\s<>"'`]*)?)/gim;
  for (const match of text.matchAll(pattern)) {
    candidates.push({ label: null, source: match[1] ?? "" });
  }
  return candidates;
}

export function resolveAgentImagePath(
  source: string,
  options: { targetPath: string; cwd?: string }
) {
  const decoded = decodeImageSource(source).replace(/\\/g, "/");
  if (!decoded || remoteSourcePattern.test(decoded) || !imageExtensionPattern.test(decoded)) {
    return null;
  }

  const withoutSuffix = decoded.replace(/[?#].*$/, "");
  const rootPath = path.resolve(options.targetPath);
  const requestedBase = path.resolve(options.cwd ?? rootPath);
  const baseRelative = path.relative(rootPath, requestedBase);
  const basePath =
    baseRelative.startsWith("..") || path.isAbsolute(baseRelative) ? rootPath : requestedBase;
  const absolutePath = path.resolve(basePath, withoutSuffix);
  const relativePath = path.relative(rootPath, absolutePath);

  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return null;
  }

  return relativePath.replace(/\\/g, "/");
}

export function extractAgentImageAttachments(
  text: string,
  options: { targetPath: string; cwd?: string }
): RunConversationAttachment[] {
  const result = new Map<string, RunConversationAttachment>();
  const candidates = [
    ...collectMarkdownImages(text),
    ...collectHtmlImages(text),
    ...collectPathMentions(text),
  ];

  for (const candidate of candidates) {
    const logicalPath = resolveAgentImagePath(candidate.source, options);
    if (!logicalPath || result.has(logicalPath)) continue;
    result.set(logicalPath, {
      path: logicalPath,
      label: candidate.label || path.posix.basename(logicalPath),
      slotKey: null,
    });
  }

  return [...result.values()];
}
