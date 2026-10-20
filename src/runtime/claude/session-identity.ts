/** Only an explicit UUID launch argument establishes a Claude transcript identity. */
export function parseClaudeLaunchSessionId(command: string): string | null {
  const matches = [...command.matchAll(/(?:^|[\s'"\\])--(?:session-id|resume)(?:[\s'"\\]+|=)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=$|[\s'"\\])/gi)];
  // Ambiguous launch commands must not pick one of several candidate identities.
  return matches.length === 1 ? matches[0]![1]!.toLowerCase() : null;
}
