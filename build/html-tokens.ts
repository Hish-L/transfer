import type { Plugin } from "vite";

/**
 * Fill `%TOKEN%` placeholders in the HTML from the TypeScript constants that
 * actually enforce them, so a picker label or a line of copy can't drift from
 * the limit that rejects your file. A miss throws: an unsubstituted
 * `%MAX_FILE_LABEL%` shipping to production is worse than a failed build.
 */
export function htmlTokens(tokens: Record<string, string>): Plugin {
  return {
    name: "html-tokens",
    enforce: "pre",
    transformIndexHtml(html) {
      for (const [token, value] of Object.entries(tokens)) {
        html = html.replaceAll(`%${token}%`, value);
      }
      const leftover = /%[A-Z][A-Z0-9_]*%/.exec(html);
      if (leftover) throw new Error(`unsubstituted HTML token ${leftover[0]}`);
      return html;
    },
  };
}
