/**
 * Repository-name parsing.
 *
 * Kept free of any dependency on configuration so it stays trivially
 * unit-testable - importing config would require live credentials just to
 * assert on string handling.
 */

const FULL_NAME = /^[\w.-]+\/[\w.-]+$/;

/**
 * Accept whatever a developer is likely to paste: `owner/name`, a browser URL,
 * or a clone URL. Rejecting a pasted GitHub URL is a pointless papercut.
 */
export function normaliseRepoName(input: string): string {
  const trimmed = input.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const fromUrl = trimmed.match(/github\.com[/:]([\w.-]+\/[\w.-]+)/i);
  const name = fromUrl ? fromUrl[1]! : trimmed;
  if (!FULL_NAME.test(name)) {
    throw new Error(
      `Could not read "${input}" as a repository. Use owner/name, ` +
        'or paste the GitHub URL.',
    );
  }
  return name;
}
