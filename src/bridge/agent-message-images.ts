import path from "node:path";
import type { RunConversationAttachment } from "@lingban/contracts";

const imageExtensionPattern = /\.(?:png|jpe?g|gif|webp|svg)(?:[?#].*)?$/i;
const videoExtensionPattern = /\.(?:mp4|webm|mov|m4v|ogv|ogg)(?:[?#].*)?$/i;
const mediaExtensionPattern = /\.(?:png|jpe?g|gif|webp|svg|mp4|webm|mov|m4v|ogv|ogg)(?:[?#].*)?$/i;
const remoteSourcePattern = /^(?:https?:|data:|blob:|\/\/|#)/i;

type ImageCandidate = {
  label: string | null;
  source: string;
  index: number;
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
      index: start,
    });
    cursor = index + 1;
  }

  return candidates;
}

function collectMarkdownVideoLinks(text: string) {
  const candidates: ImageCandidate[] = [];
  const pattern = /(^|[^!])\[([^\]]*)\]\(([^)\n]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const source = markdownDestination(match[3] ?? "");
    if (!videoExtensionPattern.test(source)) continue;
    candidates.push({
      label: match[2]?.trim() || null,
      source,
      index: match.index + (match[1]?.length ?? 0),
    });
  }
  return candidates;
}

function collectHtmlImages(text: string) {
  const candidates: ImageCandidate[] = [];
  const pattern = /<img\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/gi;
  for (const match of text.matchAll(pattern)) {
    candidates.push({ label: null, source: match[2] ?? "", index: match.index });
  }
  return candidates;
}

function collectHtmlVideos(text: string) {
  const candidates: ImageCandidate[] = [];
  const pattern = /<(?:video|source)\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    candidates.push({ label: null, source: match[2] ?? "", index: match.index });
  }
  return candidates;
}

function collectPathMentions(text: string) {
  const candidates: ImageCandidate[] = [];
  const pattern = /(?:^|[\s'"`(:])((?:\.\.\/|\.\/|\/workspace\/target\/|(?:[\w.-]+\/)+)?[\w.-]+\.(?:png|jpe?g|gif|webp|svg|mp4|webm|mov|m4v|ogv|ogg)(?:[?#][^\s<>"'`]*)?)/gim;
  for (const match of text.matchAll(pattern)) {
    candidates.push({ label: null, source: match[1] ?? "", index: match.index });
  }
  return candidates;
}

export function resolveAgentMediaPath(
  source: string,
  options: { targetPath: string; cwd?: string }
) {
  const decoded = decodeImageSource(source).replace(/\\/g, "/");
  if (!decoded || remoteSourcePattern.test(decoded) || !mediaExtensionPattern.test(decoded)) {
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

export function resolveAgentImagePath(
  source: string,
  options: { targetPath: string; cwd?: string }
) {
  return imageExtensionPattern.test(source) ? resolveAgentMediaPath(source, options) : null;
}

export function extractAgentMediaAttachments(
  text: string,
  options: { targetPath: string; cwd?: string }
): RunConversationAttachment[] {
  const result = new Map<string, RunConversationAttachment>();
  const candidates = [
    ...collectMarkdownImages(text),
    ...collectMarkdownVideoLinks(text),
    ...collectHtmlImages(text),
    ...collectHtmlVideos(text),
    ...collectPathMentions(text),
  ].sort((left, right) => left.index - right.index);

  for (const candidate of candidates) {
    const logicalPath = resolveAgentMediaPath(candidate.source, options);
    if (!logicalPath || result.has(logicalPath)) continue;
    result.set(logicalPath, {
      path: logicalPath,
      label: candidate.label || path.posix.basename(logicalPath),
      slotKey: null,
    });
  }

  return [...result.values()];
}

export function extractAgentImageAttachments(
  text: string,
  options: { targetPath: string; cwd?: string }
) {
  return extractAgentMediaAttachments(text, options).filter((attachment) =>
    imageExtensionPattern.test(attachment.path)
  );
}
