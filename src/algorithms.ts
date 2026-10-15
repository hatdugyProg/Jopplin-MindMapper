/**
 * algorithms.ts
 * -----------------------------------------------------------------------------
 * The "brains" of the Automatic Mind Map. This file has NO Joplin code in it,
 * so it can be tested with plain Node.
 *
 *   TF-IDF   -> decides WHICH words become nodes
 *   Kruskal  -> decides WHICH words connect to which (builds the tree)
 *   (Radial Tree Layout -> decides WHERE the nodes go. It lives in
 *    webview/mindmap.js because that is where the nodes get drawn.)
 *
 * Sections in this file:
 *   1. Types
 *   2. Reading text (stop words + tokenizer)
 *   3. TF-IDF
 *   4. Kruskal
 *   5. buildMindMap  (glues 3 + 4 together)
 *   6. markdownToTree (alternative: build a map from headings and bullets)
 */

/* ============================== 1. TYPES ================================== */

/** A node in a simple tree. The auto-generators return one of these. */
export interface MMNode {
  text: string;
  children: MMNode[];
}

/** The little bit of a Joplin note that we need. */
export interface NoteLike {
  id?: string;
  title: string;
  body: string;
}

/** A connection between two keywords. u and v are positions in a list. */
export interface Edge {
  u: number;
  v: number;
  w: number; // weight = distance (smaller = more closely related)
}

/* ====================== 2. READING TEXT (TOKENIZER) ======================= */

// Very common words that say nothing about the topic. Add your own here.
const STOP_WORDS = new Set(
  (
    'the a an and or but if then else of to in on at by for with from as is are was were be been ' +
    'being it its this that these those i you he she we they me him her us them my your his our ' +
    'their not no yes so do does did done have has had will would can could should may might ' +
    'must about into over under than also just very more most some any each other such only own ' +
    'same too ' +
    // A few common Filipino words, because notes may be Taglish:
    'ang ng sa na at ay mga ko mo ka siya sila kami tayo ito iyon yung para pero kung may ' +
    'mayroon ba din rin lang naman'
  ).split(/\s+/)
);

/** Splits text into lowercase words and ignores Markdown symbols. */
export function tokenize(text: string): string[] {
  const clean = text
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, ' ') // remove code blocks
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // [label](link) -> label
    .replace(/[#*_>`~|]/g, ' '); // remove Markdown symbols

  // We use new RegExp(...) instead of a /.../ literal so older TypeScript
  // targets do not complain about \p{L} (= "any letter in any language").
  const wordPattern = new RegExp("\\p{L}[\\p{L}\\p{N}'-]*", 'gu');
  const words = clean.match(wordPattern) || [];
  return words.map((w) => w.replace(/^['-]+|['-]+$/g, ''));
}

/** A word is a keyword candidate if it is not too short and not a stop word. */
function isCandidate(word: string): boolean {
  return word.length >= 3 && !STOP_WORDS.has(word);
}

/* ============================== 3. TF-IDF ================================= */

/**
 * TF-IDF from the proposal:
 *   TF    = (times the word appears in this note) / (total words in this note)
 *   IDF   = log(total notes / notes containing the word)
 *   Score = TF x IDF
 *
 * A word scores high when it is frequent in THIS note but rare in your OTHER
 * notes, which makes it a good "topic" word.
 *
 * Difference from the proposal's pseudocode: we count how many notes contain
 * each word ONCE up front, instead of re-reading every note for every word.
 * The scores are identical; it is just faster.
 */
export function extractKeywords(
  currentNote: NoteLike,
  allNotes: NoteLike[],
  topN: number
): { word: string; score: number }[] {
  const words = tokenize(currentNote.body).filter(isCandidate);
  const totalWords = words.length;
  if (totalWords === 0) return [];

  // The "documents" for IDF. The current note is always counted exactly once,
  // so notesWithWord is never 0 (which would be a divide-by-zero).
  const documents: Set<string>[] = [new Set(tokenize(currentNote.title + ' ' + currentNote.body))];
  for (const note of allNotes) {
    if (note.id === undefined || note.id !== currentNote.id) {
      documents.push(new Set(tokenize(note.title + ' ' + note.body)));
    }
  }
  const totalNotes = documents.length;

  // How many times does each word appear in the current note?
  const counts = new Map<string, number>();
  for (const word of words) {
    counts.set(word, (counts.get(word) || 0) + 1);
  }

  // Score every unique word.
  let scores: { word: string; score: number }[] = [];
  counts.forEach((count, word) => {
    const tf = count / totalWords;
    let notesWithWord = 0;
    for (const doc of documents) {
      if (doc.has(word)) notesWithWord++;
    }
    const idf = Math.log(totalNotes / notesWithWord);
    scores.push({ word, score: tf * idf });
  });

  // If you only have one note, every IDF is log(1) = 0, so every score is 0.
  // In that case we fall back to plain TF so you still get keywords.
  const bestScore = Math.max(...scores.map((s) => s.score));
  if (bestScore === 0) {
    scores = scores.map((s) => ({
      word: s.word,
      score: (counts.get(s.word) as number) / totalWords,
    }));
  }

  // Highest score first. Ties are sorted alphabetically so results are stable.
  scores.sort((a, b) => b.score - a.score || a.word.localeCompare(b.word));
  return scores.slice(0, topN);
}

/* ============================= 4. KRUSKAL ================================= */

/**
 * Kruskal's algorithm: given vertices 0..vertexCount-1 and weighted edges,
 * return the cheapest set of edges that connects everything without loops
 * (a "minimum spanning tree").
 *
 * It uses "union-find" to remember which vertices are already connected:
 *   find(x)   -> which group is x in?
 *   union(a,b)-> merge two groups
 */
export function kruskal(vertexCount: number, edges: Edge[]): Edge[] {
  const parent: number[] = [];
  const rank: number[] = [];
  for (let i = 0; i < vertexCount; i++) {
    parent.push(i); // MAKE-SET: every vertex starts in its own group
    rank.push(0);
  }

  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]; // shortcut to keep lookups fast
      x = parent[x];
    }
    return x;
  }

  function union(a: number, b: number): void {
    if (rank[a] < rank[b]) [a, b] = [b, a];
    parent[b] = a;
    if (rank[a] === rank[b]) rank[a]++;
  }

  const chosen: Edge[] = [];
  const sortedEdges = [...edges].sort((a, b) => a.w - b.w); // smallest weight first

  for (const edge of sortedEdges) {
    const groupU = find(edge.u);
    const groupV = find(edge.v);
    if (groupU !== groupV) {
      // not connected yet, so keeping this edge cannot make a loop
      chosen.push(edge);
      union(groupU, groupV);
      if (chosen.length === vertexCount - 1) break; // a tree is complete
    }
  }
  return chosen;
}

/* ============================ 5. buildMindMap ============================= */

/** Straight-line (Euclidean) distance between two number lists. */
function euclideanDistance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += (a[i] - b[i]) ** 2;
  }
  return Math.sqrt(sum);
}

/**
 * TF-IDF -> graph -> Kruskal -> tree.
 *
 * How "distance" works: notes do not have x/y coordinates, so we give every
 * keyword a list of 0s and 1s: "does this word appear in sentence 1? 2? 3?...".
 * Words that are used in the same sentences get similar lists = small distance.
 * The note title gets all 1s, so words used all over the note end up near it.
 */
export function buildMindMap(note: NoteLike, allNotes: NoteLike[], topN = 12): MMNode {
  const root: MMNode = { text: note.title || 'Untitled', children: [] };

  const keywords = extractKeywords(note, allNotes, topN).map((k) => k.word);
  if (keywords.length === 0) return root;

  // Split the note into sentences/lines and list the words in each one.
  const sentences = note.body.split(/[\n.!?;]+/).map((s) => new Set(tokenize(s)));

  // vectors[0] is the root (title). vectors[1..] are the keywords.
  const vectors: number[][] = [sentences.map(() => 1)];
  for (const keyword of keywords) {
    vectors.push(sentences.map((s) => (s.has(keyword) ? 1 : 0)));
  }

  // Connect EVERY pair of vertices, with the distance as the edge weight.
  const edges: Edge[] = [];
  for (let u = 0; u < vectors.length; u++) {
    for (let v = u + 1; v < vectors.length; v++) {
      edges.push({ u, v, w: euclideanDistance(vectors[u], vectors[v]) });
    }
  }

  // Kruskal keeps only the cheapest edges that join everything into a tree.
  const treeEdges = kruskal(vectors.length, edges);

  // Kruskal gives edges with no direction. Starting from the root, walk the
  // tree so each node knows who its parent is.
  const nodes: MMNode[] = [root];
  for (const keyword of keywords) {
    nodes.push({ text: keyword, children: [] });
  }
  const neighbours: number[][] = nodes.map(() => []);
  for (const edge of treeEdges) {
    neighbours[edge.u].push(edge.v);
    neighbours[edge.v].push(edge.u);
  }

  const visited = new Set<number>([0]);
  const toVisit = [0];
  while (toVisit.length > 0) {
    const current = toVisit.pop() as number;
    for (const next of neighbours[current]) {
      if (!visited.has(next)) {
        visited.add(next);
        nodes[current].children.push(nodes[next]);
        toVisit.push(next);
      }
    }
  }
  return root;
}

/* ========================== 6. markdownToTree ============================= */

/**
 * Alternative generator: uses YOUR structure. "# Heading" and "- bullet" lines
 * become nodes, and indentation decides who is whose child.
 */
export function markdownToTree(title: string, body: string): MMNode {
  const root: MMNode = { text: title || 'Untitled', children: [] };

  // "stack" remembers the chain of parents for the line we are reading.
  const stack: { level: number; node: MMNode }[] = [{ level: 0, node: root }];

  for (const line of body.split('\n')) {
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);

    let level: number;
    let text: string;
    if (heading) {
      level = heading[1].length; // "##" -> level 2
      text = heading[2];
    } else if (bullet) {
      const indent = bullet[1].replace(/\t/g, '  ').length;
      level = 7 + Math.floor(indent / 2); // bullets always sit below headings
      text = bullet[2];
    } else {
      continue; // plain text lines are ignored
    }

    const node: MMNode = { text: text.trim(), children: [] };
    while (stack[stack.length - 1].level >= level) {
      stack.pop(); // go back up until we find this line's parent
    }
    stack[stack.length - 1].node.children.push(node);
    stack.push({ level, node });
  }
  return root;
}
