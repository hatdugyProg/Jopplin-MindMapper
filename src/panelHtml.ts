/**
 * panelHtml.ts
 * -----------------------------------------------------------------------------
 * The HTML (buttons, canvas) of the mind map panel. It is only markup.
 * The behaviour of each button lives in webview/mindmap.js, which finds
 * the buttons by their  data-action="..."  or  id="..."  attributes.
 * Styling lives in webview/mindmap.css.
 *
 * The panel has these rows, top to bottom (like Canva):
 *
 *   header    - title + close button (colored band = the "edge" of the popup)
 *   toolbar   - things you ADD or DO: shapes, connect, auto map, layout, zoom
 *   format    - things that change the SELECTED node: font, size, colors
 *   canvas    - the drawing area
 *   footer    - hints and the save status
 *
 * Every button looks like this:
 *     <button data-action="..."><span class="mm-icon">icon</span><span class="mm-label">Text</span></button>
 * When the panel is narrow, mindmap.js adds the class "compact" and the CSS
 * hides every .mm-label, so only the icons are left.
 *
 * The font list and the node-size list are NOT written here. They are filled
 * in by mindmap.js (see FONT_CHOICES and SIZE_CHOICES), so there is one place to edit.
 */
export const PANEL_HTML = `
<div id="mm-app">

  <div id="mm-header">
    <strong>Mind Map</strong>
    <button data-action="close" aria-label="Close mind map" title="Close (Ctrl+Alt+M)">✕</button>
  </div>

  <!-- ROW 1: add things and run tools -->
  <div id="mm-toolbar" class="mm-bar">

    <div class="mm-group" aria-label="Insert a shape">
      <button data-action="add-shape" data-shape="rect" aria-label="Box" title="Insert a box"><span class="mm-icon">▭</span><span class="mm-label">Box</span></button>
      <button data-action="add-shape" data-shape="round" aria-label="Rounded" title="Insert a rounded box"><span class="mm-icon">▢</span><span class="mm-label">Rounded</span></button>
      <button data-action="add-shape" data-shape="ellipse" aria-label="Oval" title="Insert an oval"><span class="mm-icon">⬭</span><span class="mm-label">Oval</span></button>
      <button data-action="add-shape" data-shape="diamond" aria-label="Diamond" title="Insert a diamond"><span class="mm-icon">◇</span><span class="mm-label">Diamond</span></button>
    </div>

    <div class="mm-group">
      <button data-action="add-child" aria-label="Add child" title="Add a connected child to the selected node (Tab)"><span class="mm-icon">＋</span><span class="mm-label">Child</span></button>
      <button id="mm-connect" data-action="toggle-connect" aria-label="Connect" title="Click two nodes to draw a line between them"><span class="mm-icon">⤳</span><span class="mm-label">Connect</span></button>
      <button id="mm-delete" data-action="delete" aria-label="Delete" title="Delete the selected node or line (Delete key)"><span class="mm-icon">🗑</span><span class="mm-label">Delete</span></button>
    </div>

    <div class="mm-group">
      <button data-action="auto" aria-label="Auto map" title="Build a map from this note's keywords (TF-IDF + Kruskal)"><span class="mm-icon">✨</span><span class="mm-label">Auto (TF-IDF)</span></button>
      <button data-action="outline" aria-label="From outline" title="Build a map from this note's headings and bullet points"><span class="mm-icon">📄</span><span class="mm-label">From outline</span></button>
    </div>

    <div class="mm-group">
      <select id="mm-layout" aria-label="Map layout" title="How the map is arranged">
        <option value="horizontal">Sideways tree</option>
        <option value="radial">Radial</option>
      </select>
      <button data-action="relayout" aria-label="Re-arrange" title="Re-arrange all connected nodes using the chosen layout"><span class="mm-icon">◎</span><span class="mm-label">Re-arrange</span></button>
    </div>

    <div class="mm-group">
      <button id="mm-undo" data-action="undo" aria-label="Undo" title="Undo (Ctrl+Z)">↶</button>
      <button id="mm-redo" data-action="redo" aria-label="Redo" title="Redo (Ctrl+Y)">↷</button>
      <button data-action="zoom-out" aria-label="Zoom out" title="Zoom out (Ctrl + scroll)">−</button>
      <button data-action="zoom-in" aria-label="Zoom in" title="Zoom in (Ctrl + scroll)">＋</button>
      <button data-action="fit" aria-label="Fit" title="Fit the whole map on screen"><span class="mm-icon">⤢</span><span class="mm-label">Fit</span></button>
    </div>

  </div>

  <!-- ROW 2: format the selected node (greyed out until a node is selected) -->
  <div id="mm-format" class="mm-bar" aria-label="Format the selected node">

    <div class="mm-group">
      <select id="mm-font" aria-label="Font" title="Font"></select>
    </div>

    <div class="mm-group">
      <button data-action="font-smaller" aria-label="Smaller text" title="Smaller text">−</button>
      <input type="number" id="mm-font-size" min="8" max="48" step="1" aria-label="Font size" title="Font size">
      <button data-action="font-bigger" aria-label="Bigger text" title="Bigger text">＋</button>
    </div>

    <div class="mm-group">
      <button id="mm-bold" data-action="toggle-bold" aria-label="Bold" title="Bold"><strong>B</strong></button>
      <button id="mm-italic" data-action="toggle-italic" aria-label="Italic" title="Italic"><em>I</em></button>
      <button data-action="open-palette" data-target="text" aria-label="Text color" title="Text color"><span class="mm-icon mm-text-icon">A</span><span class="mm-colorbar" id="mm-text-bar"></span></button>
      <button data-action="open-palette" data-target="fill" aria-label="Fill color" title="Fill color"><span class="mm-fill-preview" id="mm-fill-preview"></span></button>
    </div>

    <div class="mm-group">
      <select id="mm-shape" aria-label="Shape" title="Shape">
        <option value="rect">Box</option>
        <option value="round">Rounded</option>
        <option value="ellipse">Oval</option>
        <option value="diamond">Diamond</option>
      </select>
      <select id="mm-scale" aria-label="Node size" title="Node size"></select>
    </div>

  </div>

  <div id="mm-canvas" tabindex="0">
    <svg id="mm-svg" xmlns="http://www.w3.org/2000/svg">
      <g id="mm-world">
        <g id="mm-edges"></g>
        <g id="mm-nodes"></g>
      </g>
    </svg>
  </div>

  <div id="mm-footer">
    <span id="mm-hint"></span>
    <span id="mm-status"></span>
  </div>

  <!-- Color picker popup. It replaces the browser's own color box, which does not
       open reliably inside Joplin. Swatches are added by mindmap.js. -->
  <div id="mm-palette" hidden>
    <div id="mm-palette-title"></div>
    <div id="mm-swatches"></div>
    <button id="mm-text-auto" data-action="auto-text-color" hidden>Automatic</button>
    <label>Custom <input type="text" id="mm-hex" maxlength="7" placeholder="#1c7ed6" aria-label="Custom color (hex)"></label>
  </div>

</div>
`;
