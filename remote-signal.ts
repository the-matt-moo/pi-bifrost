// Cross-extension signal queue for remote-pi prompts.
// remote-pi emits "remote-pi:user-prompt" with the text *before*
// calling sendUserMessage. Bifrost queues those texts here so the
// input handler can match them and skip the extension early-return.

export const REMOTE_QUEUE_CAP = 20;
export const pendingRemoteTexts: string[] = [];

/** Queue a remote prompt text, dropping the oldest past the cap. */
export function queueRemoteText(text: string): void {
  // ponytail: capped array, linear scan is fine for <=20 entries
  if (pendingRemoteTexts.length >= REMOTE_QUEUE_CAP) pendingRemoteTexts.shift();
  pendingRemoteTexts.push(text);
}

/** Remove and return true if `text` is in the pending queue. */
export function consumeRemoteText(text: string): boolean {
  const idx = pendingRemoteTexts.indexOf(text);
  if (idx === -1) return false;
  pendingRemoteTexts.splice(idx, 1);
  return true;
}
