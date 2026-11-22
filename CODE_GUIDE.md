# Mind Mapper: code guide for the team

## Where is everything?

| File | Runs where | What it does | Edit it when you want to... |
|---|---|---|---|
| `src/index.ts` | Joplin side | Creates the panel, toolbar button, menu item, shortcut. Answers the panel's messages (load, save, auto, outline, close). | add a Joplin feature (settings, text-to-speech, etc.) |
| `src/panelHtml.ts` | Panel (markup) | The buttons, color pickers and the drawing area. | add or remove a button |
| `src/webview/mindmap.js` | Panel (behaviour) | The editor: drawing, dragging, selecting many nodes, renaming, connecting, colors, undo, Sideways Tree Layout. | change how the editor behaves |
| `src/webview/mindmap.css` | Panel (looks) | Colors, borders, sizes, flexbox layout. | change how it looks |
| `src/algorithms.ts` | Joplin side | TF-IDF (words and phrases), Kruskal, building the auto map, outline parser. | change the auto mind map |

## How the two halves talk

The panel cannot read notes. The Joplin side (`index.ts`) can.
They send messages to each other:

    mindmap.js:  const reply = await webviewApi.postMessage({ name: 'save', ... });
    index.ts:    case 'save': ...  return { ok: true };

To add a feature that needs Joplin (for example text-to-speech reading the note):
1. In `index.ts`, add a `case 'yourMessageName':` in `handleMessage`.
2. In `mindmap.js`, call `askJoplin({ name: 'yourMessageName' })`.
3. In `panelHtml.ts`, add a button with `data-action="your-action"`.
4. In `mindmap.js`, add `'your-action': () => ...` to the `actions` list.

## The three algorithms

1. **TF-IDF** (`scoreWords`, `extractPhrases` in `algorithms.ts`): picks the key phrases (2-3 words).
   (`extractKeywords` gives single words and is only a backup for notes that have no phrases.)
2. **Kruskal** (`kruskal` in `algorithms.ts`): connects the keywords into a tree.
3. **Sideways Tree Layout** (`placeNode` and `relayoutTree` in `mindmap.js`, section 4): positions the nodes.
   One column per level, one row per end node, parents centered next to their children.

Pipeline when you press **Auto (TF-IDF)**:
`TF-IDF -> Kruskal -> tree -> Sideways Tree Layout -> boxes on screen`

There are only two ways to generate a map: **Auto (TF-IDF)** (phrases from the text) and
**From outline** (uses your headings and bullets, see `markdownToTree` in `algorithms.ts`).

(The old Radial Tree Layout and the Words/Phrases dropdown have been removed.)

## Controls

| Action | How |
|---|---|
| Select one node | click it |
| Select many nodes | click and hold on empty space, drag the blue rectangle over them |
| Add / remove one node from the selection | Shift or Ctrl + click |
| Select everything | Ctrl + A |
| Move selected nodes | drag any selected node (they all move together) |
| Move the whole map (pan) | hold **Spacebar** and drag (mouse wheel also works) |
| Rename | double-click a node (or Enter / F2) |
| Change colors | select node(s), then use **Fill**, **Text**, **Border** in the toolbar |

## How colors are stored

Every node has three colors: `fill`, `textColor` and `borderColor`.
`textColor: null` means "automatic" (black or white, whichever is readable on the fill).

Important rule: do NOT put `fill` or `stroke` colors in `mindmap.css` for `.mm-shape`.
CSS beats the colors set in `mindmap.js`, so the color pickers would silently stop working.
(The orange outline of a selected node is a separate shape, `.mm-halo`, for the same reason.)

Maps saved with the old single `color` are converted automatically (`normalizeGraph`).

## The golden rule of mindmap.js: state -> render

- The variables in section 2 ("STATE") describe everything on screen.
- `render()` draws the screen from them.
- Changes the user can undo go through `change(() => { ... })`.

## Formatting

- We use 2 spaces, single quotes and semicolons. The settings are in `.prettierrc.json` and `.editorconfig`.
- To format everything automatically: `npx prettier --write src`
- Keep a short comment above every function that says what it is for.

## Testing your changes

    npm run dist                (builds publish/*.jpl)
    Joplin -> Tools -> Options -> Plugins -> Install from file

or run Joplin in dev mode with the plugin folder in Settings -> Advanced.
