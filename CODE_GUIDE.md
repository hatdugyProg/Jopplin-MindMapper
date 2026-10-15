# Mind Mapper: code guide for the team

## Where is everything?

| File | Runs where | What it does | Edit it when you want to... |
|---|---|---|---|
| `src/index.ts` | Joplin side | Creates the panel, toolbar button, menu item, shortcut. Answers the panel's messages (load, save, auto, outline, close). | add a Joplin feature (settings, text-to-speech, etc.) |
| `src/panelHtml.ts` | Panel (markup) | The buttons and the drawing area. | add or remove a button |
| `src/webview/mindmap.js` | Panel (behaviour) | The editor: drawing, dragging, renaming, connecting, undo, Radial Tree Layout. | change how the editor behaves |
| `src/webview/mindmap.css` | Panel (looks) | Colors, sizes, flexbox layout. | change how it looks |
| `src/algorithms.ts` | Joplin side | TF-IDF, Kruskal, building the auto map, outline parser. | change the auto mind map |

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

1. **TF-IDF** (`extractKeywords` in `algorithms.ts`): picks the keywords.
2. **Kruskal** (`kruskal` in `algorithms.ts`): connects the keywords into a tree.
3. **Radial Tree Layout** (`countLeaves` and `placeNode` in `mindmap.js`, section 4): positions the nodes.

Pipeline when you press **Auto (TF-IDF)**:
`TF-IDF -> Kruskal -> tree -> Radial Tree Layout -> boxes on screen`

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
