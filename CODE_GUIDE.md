# Mind Mapper: code guide for the team

## Where is everything?

| File | Runs where | What it does | Edit it when you want to... |
|---|---|---|---|
| `src/index.ts` | Joplin side | Creates the panel, toolbar button, menu item, shortcut. Answers the panel's messages (load, save, auto, outline, close). | add a Joplin feature (settings, text-to-speech, etc.) |
| `src/panelHtml.ts` | Panel (markup) | The header, the two toolbar rows (tools + format bar), the drawing area, the color popup. | add or remove a button |
| `src/webview/mindmap.js` | Panel (behaviour) | The editor: drawing, dragging, renaming, connecting, undo, layouts, format bar, color popup. | change how the editor behaves |
| `src/webview/mindmap.css` | Panel (looks) | Colors, border, sizes, flexbox layout, compact mode. | change how it looks |
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
3. **Tree layout** (`mindmap.js`, section 4): positions the nodes. There are two layouts:
   - **Sideways tree** (`layoutHorizontal`, the default): root on the left, one column per level.
   - **Radial Tree Layout** (`countLeaves` and `placeNode`): root in the centre, branches in circles.

   `relayout(graph)` picks the right one using `graph.layout` (`'horizontal'` or `'radial'`).

Pipeline when you press **Auto (TF-IDF)**:
`TF-IDF -> Kruskal -> tree -> layout (sideways or radial) -> boxes on screen`

## The golden rule of mindmap.js: state -> render

- The variables in section 2 ("STATE") describe everything on screen.
- `render()` draws the screen from them.
- Changes the user can undo go through `change(() => { ... })`.
- To change one property of the selected node (font, color, size...) use `setNodeProp('property', value)`. It does the undo and the save for you.

## Common small edits

- **Add a font:** add one line to `FONT_CHOICES` at the top of `mindmap.js`.
- **Add a node size:** add one line to `SIZE_CHOICES`.
- **Change the color swatches:** edit `FILL_COLORS` and `TEXT_COLORS`.
- **Change the popup's border/header color:** edit `--mm-accent` at the top of `mindmap.css`.
- **Change when the toolbar switches to icons only:** edit `COMPACT_BELOW_PX` in `mindmap.js`.

## Formatting

- We use 2 spaces, single quotes and semicolons. The settings are in `.prettierrc.json` and `.editorconfig`.
- To format everything automatically: `npx prettier --write src`
- Keep a short comment above every function that says what it is for.

## Testing your changes

    npm run dist                (builds publish/*.jpl)
    Joplin -> Tools -> Options -> Plugins -> Install from file

or run Joplin in dev mode with the plugin folder in Settings -> Advanced.
