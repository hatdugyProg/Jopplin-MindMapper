/**
 * algorithms.ts
 * -----------------------------------------------------------------------------
 * The "brains" of the Automatic Mind Map. This file has NO Joplin code in it,
 * so it can be tested with plain Node.
 *
 * The Auto button runs this pipeline:
 *
 *   note text
 *     -> 2. NLP preprocessing   (clean, split sentences, tokenize, remove stop
 *                                 words, stem)
 *     -> 3. TF-IDF              (how important is each word?)
 *     -> 4. Key phrases         (2-3 word phrases built from important words)
 *     -> 5. Kruskal             (which phrase is the PARENT of which?)
 *     -> 6. buildMindMap        (main topics -> sub topics -> tree)
 *     -> (Sideways Tree Layout, in webview/mindmap.js, decides WHERE nodes go)
 *
 * Sections in this file:
 *   1. Types and settings
 *   2. NLP preprocessing
 *   3. TF-IDF
 *   4. Key phrase extraction
 *   5. Kruskal
 *   6. buildMindMap  (glues it all together)
 *   7. markdownToTree (the "From outline" button)
 */

/* ======================== 1. TYPES AND SETTINGS =========================== */

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

/** A connection between two vertices. u and v are positions in a list. */
export interface Edge {
  u: number;
  v: number;
  w: number; // weight = distance (smaller = more closely related)
}

/** One word of the note after preprocessing. */
export interface Token {
  word: string; // the word as written, lowercase: "models"
  stem: string; // its root, so "model" and "models" match: "model"
  keep: boolean; // false for stop words ("the", "and", ...), common verbs and very short words
}

/** A sentence is a list of clauses (pieces between commas). A clause is a list of tokens. */
export type Sentence = Token[][];

/** An important phrase found in the note. */
export interface KeyPhrase {
  text: string; // what we show: "machine learning"
  key: string; // the stems joined together, used to compare phrases: "machine learn"
  stems: string[];
  score: number; // importance (higher = more important)
  sentenceIds: Set<number>; // which sentences of the note contain it
}

// --- Settings you can tweak ---
const MAX_PHRASE_WORDS = 3; // the longest key phrase, in words
const MAIN_TOPICS = 4; // how many phrases sit directly under the note title
const MIN_NODES = 5; // if a note has very few phrases, add single words until we have this many

/* ======================== 2. NLP PREPROCESSING ============================ */

// Very common words that say nothing about the topic. Add your own here.
const STOP_WORDS = new Set(
  (
    'the a an and or but if then else of to in on at by for with from as is are was were be been ' +
    'being it its this that these those i you he she we they me him her us them my your his our ' +
    'their not no yes so do does did done have has had will would can could should may might ' +
    'must about into over under than also just very more most some any each other such only own ' +
    'same too which what who whom whose when where why how there here because while during ' +
    'between through after before again further once both all few many much one two three via ' +
    'per etc using use used uses get gets got make makes made like likes need needs able ' +
    'often usually every still even ever never always however therefore thus since until ' +
    // A few common Filipino words, because notes may be Taglish:
    'ang ng sa na at ay mga ko mo ka siya sila kami tayo ito iyon yung para pero kung may ' +
    'mayroon ba din rin lang naman'
  ).split(/\s+/)
);

// Common VERBS that are rarely nouns. A phrase should be a noun phrase
// ("neural networks"), not "helps reduce overfitting". Like a stop word, a verb
// ends a phrase. We only list the base form; verbForms() adds helps/helped/...
// We never list "-ing" forms, because those are often nouns ("machine learning").
const VERB_BASES = (
  'help produce enter affect absorb happen occur depend require allow provide create include ' +
  'contain involve enable ensure improve reduce avoid prevent apply perform remain become ' +
  'represent describe explain define determine suggest indicate give take keep find memorize ' +
  'convert transform generate build learn train turn regulate maintain develop achieve ' +
  'support combine connect compare calculate measure select choose'
).split(/\s+/);

// A few forms that the simple rule in verbForms() cannot make.
const EXTRA_VERBS = 'gave given took taken kept found built became controls matters happens';

/** helps -> help, helps, helped. studies -> study, studies, studied. */
function verbForms(base: string): string[] {
  const forms = [base, base + 's', base + 'es', base + 'ed'];
  if (base.endsWith('e')) forms.push(base + 'd');
  if (base.endsWith('y')) forms.push(base.slice(0, -1) + 'ies', base.slice(0, -1) + 'ied');
  return forms;
}

const COMMON_VERBS = new Set<string>(EXTRA_VERBS.split(' '));
VERB_BASES.forEach((base) => verbForms(base).forEach((form) => COMMON_VERBS.add(form)));

// Endings we cut off to find a word's root. Longest first, so "ations" wins over "s".
const SUFFIXES = [
  'ization', 'isation', 'ations', 'ation', 'ments', 'ment', 'ingly', 'edly',
  'ings', 'ing', 'ies', 'ied', 'ers', 'er', 'es', 'ed', 'ly', 's',
];

/**
 * A very small "stemmer": cuts a common ending off a word so that different
 * forms of the same word look the same.
 *   models -> model     learning -> learn     studies -> study
 * It is not perfect English (nobody's is), but it only has to make
 * "network" and "networks" match. We NEVER show stems to the user.
 */
export function stem(word: string): string {
  for (const suffix of SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      // "class" and "analysis" end with s but are not plurals
      if (suffix === 's' && /(ss|us|is)$/.test(word)) continue;
      let root = word.slice(0, word.length - suffix.length);
      if (suffix === 'ies' || suffix === 'ied') root += 'y'; // studies -> study
      return root;
    }
  }
  return word;
}

/** Step 1 of preprocessing: lowercase the text and remove everything that is not real writing. */
function cleanText(text: string): string {
  return text
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, ' ') // remove code blocks
    .replace(/https?:\/\/\S+/g, ' ') // remove web addresses
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // [label](link) -> label
    .replace(/[#*_>`~|]/g, ' '); // remove Markdown symbols
}

/** Step 3: cuts a piece of text into Token objects (word, stem, keep). */
function tokenizeClause(text: string): Token[] {
  // We use new RegExp(...) instead of a /.../ literal so older TypeScript
  // targets do not complain about \p{L} (= "any letter in any language").
  const wordPattern = new RegExp("\\p{L}[\\p{L}\\p{N}'-]*", 'gu');
  const found = text.match(wordPattern) || [];

  return found.map((raw) => {
    // trim stray ' and - at the edges, and turn "model's" into "model"
    const word = raw.replace(/^['-]+|['-]+$/g, '').replace(/'s$/, '');
    const keep =
      word.length >= 3 &&
      !STOP_WORDS.has(word) &&
      !COMMON_VERBS.has(word) &&
      word.indexOf("'") === -1;
    return { word: word, stem: stem(word), keep: keep };
  });
}

/**
 * NLP preprocessing, the first stage of the pipeline:
 *   1. clean the text (lowercase, remove Markdown, code, links)
 *   2. split it into sentences (at . ! ? ; and new lines)
 *   3. split each sentence into clauses (at commas, colons, brackets)
 *      and each clause into words (tokenization)
 *   4. mark stop words ("the", "and", ...) and common verbs, so they are not keywords
 *      and so they end a phrase
 *   5. find the stem of every word
 * Result example for "Neural networks learn patterns, quickly.":
 *   [ [ [neural, networks, learn, patterns], [quickly] ] ]   (shown as plain words)
 */
export function preprocess(text: string): Sentence[] {
  const sentences: Sentence[] = [];
  for (const rawSentence of cleanText(text).split(/[\n.!?;]+/)) {
    const clauses: Token[][] = [];
    for (const rawClause of rawSentence.split(/[,:()\u2013\u2014]+/)) {
      const tokens = tokenizeClause(rawClause);
      if (tokens.length > 0) clauses.push(tokens);
    }
    if (clauses.length > 0) sentences.push(clauses);
  }
  return sentences;
}

/** All the keyword stems that appear in a preprocessed text (used for IDF). */
function collectStems(sentences: Sentence[]): Set<string> {
  const stems = new Set<string>();
  for (const sentence of sentences) {
    for (const clause of sentence) {
      for (const token of clause) {
        if (token.keep) stems.add(token.stem);
      }
    }
  }
  return stems;
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
 * We score STEMS, not raw words, so "network" and "networks" count as one word.
 * The result is a Map: stem -> score.
 *
 * Difference from the proposal's pseudocode: we count how many notes contain
 * each word ONCE up front, instead of re-reading every note for every word.
 * The scores are identical; it is just faster.
 */
function scoreStems(
  currentSentences: Sentence[],
  currentNote: NoteLike,
  allNotes: NoteLike[]
): Map<string, number> {
  const scores = new Map<string, number>();

  // How many times does each stem appear in the current note?
  const counts = new Map<string, number>();
  let totalWords = 0;
  for (const sentence of currentSentences) {
    for (const clause of sentence) {
      for (const token of clause) {
        if (!token.keep) continue;
        counts.set(token.stem, (counts.get(token.stem) || 0) + 1);
        totalWords++;
      }
    }
  }
  if (totalWords === 0) return scores;

  // The "documents" for IDF. The current note is always counted exactly once,
  // so notesWithWord is never 0 (which would be a divide-by-zero).
  const documents: Set<string>[] = [
    collectStems(preprocess(currentNote.title + '\n' + currentNote.body)),
  ];
  for (const note of allNotes) {
    if (note.id === undefined || note.id !== currentNote.id) {
      documents.push(collectStems(preprocess(note.title + '\n' + note.body)));
    }
  }
  const totalNotes = documents.length;

  let bestScore = 0;
  counts.forEach((count, stemText) => {
    const tf = count / totalWords;
    let notesWithWord = 0;
    for (const doc of documents) {
      if (doc.has(stemText)) notesWithWord++;
    }
    const idf = Math.log(totalNotes / notesWithWord);
    scores.set(stemText, tf * idf);
    bestScore = Math.max(bestScore, tf * idf);
  });

  // If you only have one note, every IDF is log(1) = 0, so every score is 0.
  // In that case we fall back to plain TF so you still get keywords.
  if (bestScore === 0) {
    counts.forEach((count, stemText) => {
      scores.set(stemText, count / totalWords);
    });
  }
  return scores;
}

/* ====================== 4. KEY PHRASE EXTRACTION ========================== */

/** Everything we learn about one phrase while reading the note. */
interface PhraseInfo {
  stems: string[];
  count: number; // how many times it appears
  sentenceIds: Set<number>; // in which sentences
  forms: Map<string, number>; // the different ways it was written ("neural network", "neural networks")
}

/**
 * Takes one "run" of neighbouring keywords, e.g. [machine, learning, model],
 * and records every 1-, 2- and 3-word piece of it:
 *   "machine", ..., "machine learning", "learning model", "machine learning model"
 * (A stop word or a comma ends a run, so a phrase never jumps across them.)
 */
function addRun(run: Token[], sentenceId: number, found: Map<string, PhraseInfo>): void {
  for (let size = 1; size <= MAX_PHRASE_WORDS; size++) {
    for (let start = 0; start + size <= run.length; start++) {
      const pieces = run.slice(start, start + size);
      const stems = pieces.map((t) => t.stem);

      // Skip phrases that repeat a word, like "learning models learn".
      if (new Set(stems).size < stems.length) continue;

      const key = stems.join(' ');
      let info = found.get(key);
      if (!info) {
        info = { stems: stems, count: 0, sentenceIds: new Set<number>(), forms: new Map() };
        found.set(key, info);
      }
      info.count++;
      info.sentenceIds.add(sentenceId);
      const written = pieces.map((t) => t.word).join(' ');
      info.forms.set(written, (info.forms.get(written) || 0) + 1);
    }
  }
}

/** Of all the ways a phrase was written, pick the most common one to show. */
function bestForm(info: PhraseInfo): string {
  let best = '';
  let bestCount = 0;
  info.forms.forEach((count, written) => {
    if (count > bestCount || (count === bestCount && written < best)) {
      best = written;
      bestCount = count;
    }
  });
  return best;
}

/** Highest score first. Ties are sorted alphabetically so results are stable. */
function byScore(a: KeyPhrase, b: KeyPhrase): number {
  return b.score - a.score || a.key.localeCompare(b.key);
}

/**
 * Finds the topN most important key phrases of a note, best first.
 *
 *   1. Preprocess the note (section 2) and score every word with TF-IDF (section 3).
 *   2. List every 1-3 word phrase made of neighbouring keywords.
 *   3. Phrase score = (sum of the TF-IDF scores of its words) x (times it appears).
 *      So phrases made of important words that are repeated win.
 *   4. Take the best 2-3 word phrases, skipping any phrase that is just a piece of
 *      (or contains) one we already took ("machine learning" vs "machine learning model").
 *   5. If the note gave us too few phrases, add its best single words.
 */
export function extractKeyPhrases(
  note: NoteLike,
  allNotes: NoteLike[],
  topN: number
): KeyPhrase[] {
  const sentences = preprocess(note.body);
  const wordScores = scoreStems(sentences, note, allNotes);

  // Step 2: collect every 1-3 word phrase.
  const found = new Map<string, PhraseInfo>();
  sentences.forEach((sentence, sentenceId) => {
    for (const clause of sentence) {
      let run: Token[] = [];
      for (const token of clause) {
        if (token.keep) {
          run.push(token);
        } else {
          addRun(run, sentenceId, found); // a stop word ends the run
          run = [];
        }
      }
      addRun(run, sentenceId, found);
    }
  });

  // Step 3: score them. Phrases (2+ words) and single words are kept apart.
  const phrases: KeyPhrase[] = [];
  const singles: KeyPhrase[] = [];
  found.forEach((info, key) => {
    let total = 0;
    for (const stemText of info.stems) {
      total += wordScores.get(stemText) || 0;
    }
    const item: KeyPhrase = {
      text: bestForm(info),
      key: key,
      stems: info.stems,
      score: total * info.count,
      sentenceIds: info.sentenceIds,
    };
    (info.stems.length >= 2 ? phrases : singles).push(item);
  });
  phrases.sort(byScore);
  singles.sort(byScore);

  // Step 4: take the best phrases, skipping overlaps. The spaces around each key
  // make sure we compare whole words ("art" is not found inside "smart").
  const chosen: KeyPhrase[] = [];
  for (const candidate of phrases) {
    if (chosen.length === topN) break;
    const text = ' ' + candidate.key + ' ';
    const overlaps = chosen.some((other) => {
      const otherText = ' ' + other.key + ' ';
      return otherText.includes(text) || text.includes(otherText);
    });
    if (!overlaps) chosen.push(candidate);
  }

  // Step 5: too few phrases? Add single words (but not ones already inside a chosen phrase).
  const wanted = chosen.length === 0 ? topN : Math.min(topN, MIN_NODES);
  for (const single of singles) {
    if (chosen.length >= wanted) break;
    const alreadyUsed = chosen.some((other) => other.stems.indexOf(single.stems[0]) !== -1);
    if (!alreadyUsed) chosen.push(single);
  }
  return chosen;
}

/* ============================= 5. KRUSKAL ================================= */

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

/* ============================ 6. buildMindMap ============================= */

/**
 * How related are two phrases? A number from 0 (nothing in common) to 1 (same thing).
 *   - 60%: do they share words?    "machine learning" and "learning model" share "learn"
 *   - 40%: do they appear in the same sentences?
 */
function relatedness(a: KeyPhrase, b: KeyPhrase): number {
  // Shared words, compared by stem. Divided by the SHORTER phrase, so that
  // "neural network" is fully related to "neural network training".
  let sharedWords = 0;
  for (const stemText of a.stems) {
    if (b.stems.indexOf(stemText) !== -1) sharedWords++;
  }
  const wordOverlap = sharedWords / Math.min(a.stems.length, b.stems.length);

  // Shared sentences: (sentences with both) / (sentences with either).
  let both = 0;
  a.sentenceIds.forEach((id) => {
    if (b.sentenceIds.has(id)) both++;
  });
  const either = a.sentenceIds.size + b.sentenceIds.size - both;
  const sentenceOverlap = either === 0 ? 0 : both / either;

  return 0.6 * wordOverlap + 0.4 * sentenceOverlap;
}

/** "machine learning" -> "Machine learning" */
function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Builds a STRUCTURED mind map, like the "From outline" one:
 *
 *   Note title
 *   ├─ Main topic 1      <- the most important phrases (importance = TF-IDF)
 *   │   ├─ Sub topic     <- a phrase closely related to its parent
 *   │   └─ Sub topic
 *   ├─ Main topic 2
 *   └─ ...
 *
 * Steps:
 *   1. extractKeyPhrases gives the important phrases, best first (sections 2-4).
 *   2. MAIN TOPICS: walk down the list and take the best phrases that do not
 *      share a word with a main topic we already took (so the main topics are
 *      about DIFFERENT things). They connect straight to the title.
 *   3. Every other phrase must find its PARENT. We give every pair of phrases a
 *      distance (1 - relatedness) and let Kruskal keep the cheapest links.
 *      The title can only connect to main topics, so every other phrase hangs
 *      below the phrase it is most related to.
 *   4. Starting from the title, walk the tree so each node knows its children.
 *      Children are listed best phrase first.
 */
export function buildMindMap(note: NoteLike, allNotes: NoteLike[], topN = 12): MMNode {
  const root: MMNode = { text: note.title || 'Untitled', children: [] };

  // Step 1: the important phrases. Vertex 0 is the title, vertex i+1 is phrases[i].
  const phrases = extractKeyPhrases(note, allNotes, topN);
  if (phrases.length === 0) return root;

  // Step 2: pick the main topics.
  const isMain: boolean[] = [];
  const mainWords = new Set<string>(); // the words used by main topics so far
  let mainCount = 0;
  for (const phrase of phrases) {
    const sharesWord = phrase.stems.some((w) => mainWords.has(w));
    if (!sharesWord && mainCount < MAIN_TOPICS) {
      isMain.push(true);
      phrase.stems.forEach((w) => mainWords.add(w));
      mainCount++;
    } else {
      isMain.push(false);
    }
  }

  // Step 3: build the links. The title connects ONLY to main topics (distance 0,
  // so Kruskal takes those first). Every pair of phrases is also linked, with
  // distance = 1 - relatedness. The tiny (i + j) * 0.0001 breaks ties in favour
  // of more important phrases, so the result is always the same.
  const edges: Edge[] = [];
  phrases.forEach((phrase, i) => {
    if (isMain[i]) edges.push({ u: 0, v: i + 1, w: 0 });
  });
  for (let i = 0; i < phrases.length; i++) {
    for (let j = i + 1; j < phrases.length; j++) {
      const distance = 1 - relatedness(phrases[i], phrases[j]) + (i + j) * 0.0001;
      edges.push({ u: i + 1, v: j + 1, w: distance });
    }
  }
  const treeEdges = kruskal(phrases.length + 1, edges);

  // Step 4: Kruskal gives links with no direction. Starting from the title,
  // walk the tree so each node knows who its parent is.
  const nodes: MMNode[] = [root];
  for (const phrase of phrases) {
    nodes.push({ text: capitalize(phrase.text), children: [] });
  }
  const neighbours: number[][] = nodes.map(() => []);
  for (const edge of treeEdges) {
    neighbours[edge.u].push(edge.v);
    neighbours[edge.v].push(edge.u);
  }
  neighbours.forEach((list) => list.sort((a, b) => a - b)); // best phrase first

  const visited = new Set<number>([0]);
  const queue = [0];
  while (queue.length > 0) {
    const current = queue.shift() as number;
    for (const next of neighbours[current]) {
      if (!visited.has(next)) {
        visited.add(next);
        nodes[current].children.push(nodes[next]);
        queue.push(next);
      }
    }
  }
  return root;
}

/* ========================== 7. markdownToTree ============================= */

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
