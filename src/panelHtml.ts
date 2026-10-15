/**
 * panelHtml.ts
 * -----------------------------------------------------------------------------
 * The HTML (buttons, canvas) of the mind map panel. It is only markup.
 * The behaviour of each button lives in webview/mindmap.js, which finds
 * the buttons by their  data-action="..."  or  id="..."  attributes.
 * Styling lives in webview/mindmap.css.
 */
export const PANEL_HTML = `
<div id="mm-app">

  <div id="mm-header">
    <strong>Mind Map</strong>
    <button data-action="close" aria-label="Close mind map" title="Close (Ctrl+Alt+M)">✕</button>
  </div>

  <div id="mm-toolbar">

    <div class="mm-group" aria-label="Insert a shape">
      <button data-action="add-shape" data-shape="rect" title="Insert a box">▭ Box</button>
      <button data-action="add-shape" data-shape="round" title="Insert a rounded box">▢ Rounded</button>
      <button data-action="add-shape" data-shape="ellipse" title="Insert an oval">⬭ Oval</button>
      <button data-action="add-shape" data-shape="diamond" title="Insert a diamond">◇ Diamond</button>
    </div>

    <div class="mm-group">
      <button data-action="add-child" title="Add a connected child to the selected node (Tab)">＋ Child</button>
      <button id="mm-connect" data-action="toggle-connect" title="Click two nodes to draw a line between them">⤳ Connect</button>
      <button id="mm-delete" data-action="delete" title="Delete the selected node or line (Delete key)">🗑 Delete</button>
    </div>

    <div class="mm-group">
      <label>Color <input type="color" id="mm-color" value="#dbe7ff"></label>
      <label>Shape
        <select id="mm-shape">
          <option value="rect">Box</option>
          <option value="round">Rounded</option>
          <option value="ellipse">Oval</option>
          <option value="diamond">Diamond</option>
        </select>
      </label>
    </div>

    <div class="mm-group">
      <button data-action="auto" title="Build a map from this note's keywords (TF-IDF + Kruskal + radial layout)">✨ Auto (TF-IDF)</button>
      <button data-action="outline" title="Build a map from this note's headings and bullet points">📄 From outline</button>
      <button data-action="relayout" title="Re-arrange all connected nodes in a radial layout">◎ Re-arrange</button>
    </div>

    <div class="mm-group">
      <button id="mm-undo" data-action="undo" aria-label="Undo" title="Undo (Ctrl+Z)">↶</button>
      <button id="mm-redo" data-action="redo" aria-label="Redo" title="Redo (Ctrl+Y)">↷</button>
      <button data-action="zoom-out" aria-label="Zoom out" title="Zoom out (Ctrl + scroll)">−</button>
      <button data-action="zoom-in" aria-label="Zoom in" title="Zoom in (Ctrl + scroll)">＋</button>
      <button data-action="fit" title="Fit the whole map on screen">⤢ Fit</button>
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

</div>
`;
