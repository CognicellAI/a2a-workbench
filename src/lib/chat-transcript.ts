const SHORT_FRAGMENT_MAX_LENGTH = 80;
const STREAM_CONTEXT_MAX_LENGTH = 320;
const LONG_FINAL_MIN_LENGTH = 120;
const COMPACT_TAIL_LENGTH = 120;
const NO_SPACE_BEFORE = /^[,.;:!?%)}\]>]/;
const NO_SPACE_AFTER = /[(\[{<]$/;

export function mergeAssistantTranscriptText(current: string, incoming: string): string {
  const next = incoming.trim();
  if (!next) {
    return current;
  }

  if (!current) {
    return next;
  }

  if (shouldKeepCurrent(current, next)) {
    return current;
  }

  if (shouldReplaceWithIncoming(current, next)) {
    return next;
  }

  return joinTextDelta(current, next);
}

function shouldKeepCurrent(current: string, incoming: string): boolean {
  const compactCurrent = compactText(current);
  const compactIncoming = compactText(incoming);

  return compactCurrent === compactIncoming || compactCurrent.includes(compactIncoming);
}

function shouldReplaceWithIncoming(current: string, incoming: string): boolean {
  const compactCurrent = compactText(current);
  const compactIncoming = compactText(incoming);
  const currentTail = compactCurrent.slice(-COMPACT_TAIL_LENGTH);

  if (compactIncoming.includes(compactCurrent)) {
    return true;
  }

  if (currentTail.length >= 12 && compactIncoming.includes(currentTail)) {
    return true;
  }

  if (current.length <= SHORT_FRAGMENT_MAX_LENGTH && incoming.length >= SHORT_FRAGMENT_MAX_LENGTH) {
    return true;
  }

  return current.length <= STREAM_CONTEXT_MAX_LENGTH && incoming.length >= LONG_FINAL_MIN_LENGTH && looksLikeFullAnswer(incoming);
}

function looksLikeFullAnswer(value: string): boolean {
  return /(^|\n)\s*[-*]\s+\S/.test(value) || /\|.+\|/.test(value) || /\n\n/.test(value) || /```/.test(value);
}

function joinTextDelta(current: string, incoming: string): string {
  if (current.endsWith("\n") || incoming.startsWith("\n") || current.endsWith(" ") || incoming.startsWith(" ")) {
    return `${current}${incoming}`;
  }

  if (NO_SPACE_BEFORE.test(incoming) || NO_SPACE_AFTER.test(current)) {
    return `${current}${incoming}`;
  }

  return `${current} ${incoming}`;
}

function compactText(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}
