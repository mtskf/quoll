/** A frontmatter fence line: exactly `---`, optional trailing spaces/tabs and CR.
 * Shared by line-native frontmatter detection and Markdown segmentation. */
export const FENCE_LINE = /^---[ \t]*\r?$/;
