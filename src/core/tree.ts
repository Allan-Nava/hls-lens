// Filtering a tree, without knowing what the tree is made of.
//
// The tree in the view is built from vscode.TreeItem, which cannot exist here — so
// this works through a reader function instead. What is worth testing is not the
// TreeItem plumbing but the two rules that make a filtered tree usable at all:
//
//   * a row survives if it matches, or if anything under it matches — otherwise
//     filtering for a segment URI hides the section that contains it, and the result
//     is an empty view for a query that has an answer;
//   * a row that matches by itself keeps all of its children — filtering for
//     "variants" should show the variants, not an empty section header.
//
// The description is searched as well as the label, because the description is where
// the numbers are, and the numbers are what someone is looking for.
//
// rowForLine is the other direction. Clicking a row reveals its line and nothing did
// the reverse, which is how a finding on line 4000 of a live playlist stays lost.
import { Playlist } from './playlist';

/** What this needs to know about a node: its text, and what is under it. */
export interface TreeShape<T> {
  label: string;
  description?: string;
  children: T[];
}

/** subtreeMatches reports whether a node, or anything below it, matches the query. */
export function subtreeMatches<T>(node: T, query: string, read: (node: T) => TreeShape<T>): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  const shape = read(node);
  if (`${shape.label} ${shape.description ?? ''}`.toLowerCase().includes(needle)) return true;
  return shape.children.some((child) => subtreeMatches(child, query, read));
}

/**
 * filterNodes rebuilds a tree with only the branches that survive the query. The
 * caller supplies both how to read a node and how to make one, so the same logic
 * serves whatever the view is actually built from.
 */
export function filterNodes<T>(
  nodes: T[],
  query: string,
  read: (node: T) => TreeShape<T>,
  rebuild: (node: T, children: T[]) => T,
): T[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return nodes;

  const kept: T[] = [];
  for (const node of nodes) {
    const shape = read(node);
    const itself = `${shape.label} ${shape.description ?? ''}`.toLowerCase().includes(needle);
    // A row that matches on its own keeps everything under it: a section header with
    // its contents removed is a worse answer than no answer.
    if (itself) {
      kept.push(node);
      continue;
    }
    const children = filterNodes(shape.children, query, read, rebuild);
    if (children.length > 0) kept.push(rebuild(node, children));
  }
  return kept;
}

/** Which row of the tree owns a line of the manifest. */
export interface TreeAddress {
  section: 'variants' | 'renditions' | 'segments' | 'maps' | 'keys' | 'parts';
  index: number;
}

/**
 * rowForLine answers "which row is this line part of", so the tree can follow the
 * cursor instead of only leading it.
 *
 * A tag and the URI line under it are one row, because they are one thing: a segment
 * is its EXTINF and its URI, and landing on the second should reveal the same row as
 * landing on the first.
 */
export function rowForLine(pl: Playlist, line: number): TreeAddress | undefined {
  for (const [index, variant] of pl.variants.entries()) {
    if (line === variant.line || line === variant.uriLine) return { section: 'variants', index };
  }
  for (const [index, rendition] of pl.renditions.entries()) {
    if (line === rendition.line) return { section: 'renditions', index };
  }
  for (const [index, segment] of pl.segments.entries()) {
    if (line === segment.extinfLine || line === segment.uriLine || line === segment.programDateTimeLine) {
      return { section: 'segments', index };
    }
  }
  for (const [index, part] of pl.parts.entries()) {
    if (line === part.line) return { section: 'parts', index };
  }
  for (const [index, map] of pl.maps.entries()) {
    if (line === map.line) return { section: 'maps', index };
  }
  for (const [index, key] of pl.keys.entries()) {
    if (line === key.line) return { section: 'keys', index };
  }
  return undefined;
}
