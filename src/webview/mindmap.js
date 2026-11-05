/* =============================================================================
 * mindmap.js  -  the mind map editor. Runs INSIDE the Joplin panel.
 * -----------------------------------------------------------------------------
 * This code can draw on the screen, but it CANNOT touch Joplin's notes. When it
 * needs something from Joplin (load, save, auto-generate) it sends a message:
 *
 *      const reply = await webviewApi.postMessage({ name: 'save', ... });
 *
 * and index.ts (the Joplin side) answers. (This is why everything is in ONE file:
 * Joplin may load several scripts in a random order, one file is always safe.)
 *
 * HOW THE DATA LOOKS  (this is the "graph" saved with each note)
 *
 *   {
 *     rootId: 'n1',                                  <- the centre of the map
 *     nodes: [ { id, text, x, y, shape,
 *                fill, textColor, borderColor } ],   <- the boxes
 *     edges: [ { id, from, to } ]                    <- the lines between boxes
 *   }
 *
 * shape is 'rect' | 'round' | 'ellipse' | 'diamond'.
 * x and y are positions on an infinite canvas ("world" coordinates).
 * fill / textColor / borderColor are colors like '#dbe7ff'.
 * textColor can be null, which means "pick black or white automatically".
 *
 * THE BASIC IDEA  (state -> render)
 *   - The variables in section 2 describe everything on screen.
 *   - render() redraws the screen from those variables.
 *   - To change something: change the variables, then call render().
 *   - For edits the user may want to undo, use change(() => { ... }) (section 6).
 *
 * MOUSE CONTROLS
 *   - Click a node ............ select it
 *   - Click + hold on empty ... draw a blue box; every node it touches is selected
 *   - Shift/Ctrl + click ...... add a node to (or remove it from) the selection
 *   - Drag a selected node .... moves ALL selected nodes together
 *   - Hold SPACEBAR + drag .... moves the whole map around (pan)
 *
 * SECTIONS
 *   1. Settings            6. Editing actions
 *   2. State               7. Mouse and keyboard
 *   3. Small helpers       8. Talking to Joplin (load / save / auto)
 *   4. Sideways Tree Layout  9. Start-up
 *   5. Drawing (render)
 * ========================================================================== */

(function () {
  'use strict';

  /* ========================== 1. SETTINGS ================================== */
  /* Change these numbers to tweak the look and feel. */

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const LEVEL_GAP = 340; // sideways layout: distance between one column and the next
  const ROW_GAP = 80; // sideways layout: distance between one row and the next
  const NODE_HEIGHT = 44;
  const MIN_NODE_WIDTH = 110;
  const MAX_NODE_WIDTH = 260;
  const CHAR_WIDTH = 8; // rough width of one letter, used to size boxes
  const MIN_ZOOM = 0.2;
  const MAX_ZOOM = 3;
  const SAVE_DELAY_MS = 1000; // auto-save this long after the last change
  const MAX_UNDO_STEPS = 50;
  const ROOT_FILL = '#ffe9a8';
  const DEFAULT_FILL = '#dbe7ff';
  const DEFAULT_BORDER = '#4a6fa5';

  /* ============================ 2. STATE =================================== */

  let graph = { nodes: [], edges: [], rootId: null }; // the map itself
  let view = { x: 0, y: 0, zoom: 1 }; // where the camera is looking
  // What is selected? Many nodes can be selected at once (a Set of node ids),
  // OR one line (edgeId). Never both.
  let selection = { nodeIds: new Set(), edgeId: null };
  let connectMode = false; // is the Connect tool on?
  let connectSourceId = null; // first node clicked in Connect mode
  let drag = null; // info about the drag in progress (if any)
  let spaceDown = false; // is the Spacebar being held? (then dragging = pan)
  let colorEditing = false; // is a color picker being used right now?
  let lastClick = { time: 0, nodeId: null, x: 0, y: 0 }; // used to detect double-clicks
  let editInput = null; // the rename text box (if open)
  let currentNoteId = null; // which note this map belongs to
  let saveTimer = null; // pending auto-save
  let needsFit = false; // "fit the map on screen as soon as there is room"
  let idCounter = 0;
  const undoStack = []; // earlier versions of the graph (as text)
  const redoStack = [];

  // Page elements (they are defined in panelHtml.ts)
  const byId = (id) => document.getElementById(id);
  const appBox = byId('mm-app');
  const canvasBox = byId('mm-canvas');
  const svg = byId('mm-svg');
  const world = byId('mm-world');
  const edgeLayer = byId('mm-edges');
  const nodeLayer = byId('mm-nodes');
  const fillInput = byId('mm-fill');
  const textColorInput = byId('mm-text-color');
  const borderInput = byId('mm-border');
  const shapeSelect = byId('mm-shape');
  const connectButton = byId('mm-connect');
  const deleteButton = byId('mm-delete');
  const undoButton = byId('mm-undo');
  const redoButton = byId('mm-redo');
  const hintBox = byId('mm-hint');
  const statusBox = byId('mm-status');

  /* ========================= 3. SMALL HELPERS ============================== */

  function newId() {
    idCounter += 1;
    return 'n' + Date.now().toString(36) + idCounter;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function makeNode(text, x, y, shape, fill) {
    return {
      id: newId(),
      text: text,
      x: x,
      y: y,
      shape: shape || 'round',
      fill: fill || DEFAULT_FILL,
      textColor: null, // null = automatic (black or white, whichever is readable)
      borderColor: DEFAULT_BORDER,
    };
  }

  function makeEdge(fromId, toId) {
    return { id: newId(), from: fromId, to: toId };
  }

  function findNode(id) {
    return graph.nodes.find((node) => node.id === id);
  }

  /* ---- Selection helpers ---- */

  /** All the selected nodes, as a list. */
  function selectedNodes() {
    return graph.nodes.filter((node) => selection.nodeIds.has(node.id));
  }

  /** The selected node, but ONLY if exactly one node is selected (otherwise null). */
  function selectedNode() {
    const nodes = selectedNodes();
    return nodes.length === 1 ? nodes[0] : null;
  }

  function hasSelection() {
    return selection.nodeIds.size > 0 || selection.edgeId !== null;
  }

  function clearSelection() {
    selection = { nodeIds: new Set(), edgeId: null };
  }

  function selectOnlyNode(id) {
    selection = { nodeIds: new Set([id]), edgeId: null };
  }

  function selectEdge(id) {
    selection = { nodeIds: new Set(), edgeId: id };
  }

  /** Shift/Ctrl + click: add the node to the selection, or remove it if it is already in. */
  function toggleNodeInSelection(id) {
    const ids = new Set(selection.nodeIds);
    if (ids.has(id)) {
      ids.delete(id);
    } else {
      ids.add(id);
    }
    selection = { nodeIds: ids, edgeId: null };
  }

  function edgeExists(a, b) {
    return graph.edges.some((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a));
  }

  /** How big a node is. It grows with its text, and depends on its shape. */
  function getSize(node) {
    const base = clamp(24 + node.text.length * CHAR_WIDTH, MIN_NODE_WIDTH, MAX_NODE_WIDTH);
    if (node.shape === 'diamond') return { w: base * 1.4, h: NODE_HEIGHT * 1.6 };
    if (node.shape === 'ellipse') return { w: base * 1.15, h: NODE_HEIGHT * 1.2 };
    return { w: base, h: NODE_HEIGHT };
  }

  /** Dark text on light colors, white text on dark colors (readability). */
  function textColorFor(hex) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const brightness = 0.299 * r + 0.587 * g + 0.114 * b;
    return brightness > 150 ? '#1a1a1a' : '#ffffff';
  }

  /** Creates an SVG element, e.g. svgEl('rect', { width: 10 }). */
  function svgEl(tag, attributes) {
    const element = document.createElementNS(SVG_NS, tag);
    for (const name in attributes) {
      element.setAttribute(name, attributes[name]);
    }
    return element;
  }

  /** Mouse position on screen -> position on the canvas ("world"). */
  function toWorld(event) {
    const box = svg.getBoundingClientRect();
    return {
      x: (event.clientX - box.left - view.x) / view.zoom,
      y: (event.clientY - box.top - view.y) / view.zoom,
    };
  }

  /** The canvas point that is in the middle of the screen right now. */
  function viewCenterWorld() {
    const box = svg.getBoundingClientRect();
    return { x: (box.width / 2 - view.x) / view.zoom, y: (box.height / 2 - view.y) / view.zoom };
  }

  /** Which node is under this canvas point? (topmost first) */
  function findNodeAt(point) {
    for (let i = graph.nodes.length - 1; i >= 0; i--) {
      const node = graph.nodes[i];
      const size = getSize(node);
      if (Math.abs(point.x - node.x) <= size.w / 2 && Math.abs(point.y - node.y) <= size.h / 2) {
        return node;
      }
    }
    return null;
  }

  /** Which nodes touch this rectangle? box = { left, right, top, bottom } in canvas coordinates. */
  function findNodesInBox(box) {
    return graph.nodes.filter((node) => {
      const size = getSize(node);
      return (
        node.x + size.w / 2 >= box.left &&
        node.x - size.w / 2 <= box.right &&
        node.y + size.h / 2 >= box.top &&
        node.y - size.h / 2 <= box.bottom
      );
    });
  }

  /** Finds an empty spot near a point, so a new shape never lands on top of another one. */
  function findFreeSpot(near) {
    for (let attempt = 0; attempt < 60; attempt++) {
      // attempt 0 = the point itself, then a widening spiral around it
      const distance = attempt === 0 ? 0 : 100 * Math.sqrt(attempt);
      const spot = {
        x: near.x + distance * Math.cos(attempt * 2.4),
        y: near.y + distance * Math.sin(attempt * 2.4),
      };
      const isFree = graph.nodes.every((node) => {
        const size = getSize(node);
        return (
          Math.abs(spot.x - node.x) > size.w / 2 + 70 || Math.abs(spot.y - node.y) > size.h / 2 + 35
        );
      });
      if (isFree) return spot;
    }
    return near;
  }

  /** Is this mouse-down the second half of a double-click? (Remembers the last click.)
      We do this by hand because redrawing removes the clicked element, and the
      browser's own "dblclick" event is not sent when that happens. */
  function isDoubleClick(event, nodeId) {
    const closeInTime = Date.now() - lastClick.time < 350;
    const closeInSpace =
      Math.abs(event.clientX - lastClick.x) < 8 && Math.abs(event.clientY - lastClick.y) < 8;
    const isDouble = closeInTime && closeInSpace && lastClick.nodeId === nodeId;
    lastClick = isDouble
      ? { time: 0, nodeId: null, x: 0, y: 0 }
      : { time: Date.now(), nodeId: nodeId, x: event.clientX, y: event.clientY };
    return isDouble;
  }

  function setStatus(text) {
    statusBox.textContent = text;
  }

  function setHint(text) {
    hintBox.textContent = text;
  }

  function defaultHint() {
    setHint('Drag empty space: select many · Space + drag: move map · Double-click: rename');
  }

  /** Makes older saved maps work with the newest code.
      Old nodes had ONE "color" (the fill). New nodes have fill, textColor and borderColor. */
  function normalizeGraph(g) {
    g.nodes.forEach((node) => {
      if (node.fill === undefined) node.fill = node.color || DEFAULT_FILL;
      if (node.textColor === undefined) node.textColor = null;
      if (node.borderColor === undefined) node.borderColor = DEFAULT_BORDER;
      delete node.color;
    });
    return g;
  }

  /* ==================== 4. SIDEWAYS TREE LAYOUT ============================ */
  /* The root is on the LEFT and the branches grow to the RIGHT, like an
     outline turned on its side. Two simple rules:
       1. Column (x): every level of the tree gets its own column.
          depth 0 = root, depth 1 = its children, depth 2 = their children, ...
       2. Row (y): every "end" node (a node with no children) gets its own row,
          one below the other. A parent is placed in the MIDDLE of its children.
     That is all it takes to keep the map tidy: nothing overlaps. */

  let nextRow = 0; // the next free row for an "end" node

  /** Places a node, and (before it) all of its children. */
  function placeNode(node, depth) {
    node.x = depth * LEVEL_GAP; // rule 1: the column

    if (node.children.length === 0) {
      // An end node takes the next free row.
      node.y = nextRow * ROW_GAP;
      nextRow += 1;
    } else {
      // Place all the children first, then sit in the middle of them.
      node.children.forEach((child) => placeNode(child, depth + 1));
      const firstChild = node.children[0];
      const lastChild = node.children[node.children.length - 1];
      node.y = (firstChild.y + lastChild.y) / 2;
    }
  }

  /** Turns the graph (boxes + lines) into a tree, starting from the root. */
  function graphToTree(g) {
    const rootId = g.nodes.some((n) => n.id === g.rootId) ? g.rootId : g.nodes[0].id;

    // who is connected to whom? (lines work in both directions)
    const neighbours = {};
    g.nodes.forEach((n) => (neighbours[n.id] = []));
    g.edges.forEach((e) => {
      if (neighbours[e.from] && neighbours[e.to]) {
        neighbours[e.from].push(e.to);
        neighbours[e.to].push(e.from);
      }
    });

    const rootTree = { id: rootId, children: [] };
    const visited = new Set([rootId]);
    const queue = [rootTree];
    while (queue.length > 0) {
      const current = queue.shift();
      for (const neighbourId of neighbours[current.id]) {
        if (!visited.has(neighbourId)) {
          visited.add(neighbourId);
          const child = { id: neighbourId, children: [] };
          current.children.push(child);
          queue.push(child);
        }
      }
    }
    return rootTree;
  }

  /** Moves every node that is connected to the root into its sideways-tree position.
      Nodes that are not connected to anything are left where they are. */
  function relayoutTree(g) {
    if (g.nodes.length === 0) return;
    const tree = graphToTree(g);
    nextRow = 0;
    placeNode(tree, 0);

    // Copy the positions into the real nodes. We subtract tree.y so the root
    // ends up at y = 0 (the middle of the map) instead of somewhere below it.
    (function copyPositions(treeNode) {
      const graphNode = g.nodes.find((n) => n.id === treeNode.id);
      graphNode.x = treeNode.x;
      graphNode.y = treeNode.y - tree.y;
      treeNode.children.forEach(copyPositions);
    })(tree);
  }

  /** Converts a generated tree ({ text, children }) into a graph, then lays it out. */
  function treeToGraph(tree) {
    const g = { nodes: [], edges: [], rootId: null };

    function addNode(treeNode, parentId) {
      const isRoot = parentId === null;
      const node = makeNode(
        treeNode.text,
        0,
        0,
        isRoot ? 'ellipse' : 'round',
        isRoot ? ROOT_FILL : DEFAULT_FILL
      );
      g.nodes.push(node);
      if (!isRoot) g.edges.push(makeEdge(parentId, node.id));
      treeNode.children.forEach((child) => addNode(child, node.id));
    }

    addNode(tree, null);
    g.rootId = g.nodes[0].id;
    relayoutTree(g);
    return g;
  }

  /** A brand-new map: just one centre node with the note's title. */
  function newMap(title) {
    const root = makeNode(title || 'Main idea', 0, 0, 'ellipse', ROOT_FILL);
    return { nodes: [root], edges: [], rootId: root.id };
  }

  /* ======================= 5. DRAWING (render) ============================= */

  /** Redraws everything from the state variables. Call it after any change. */
  function render() {
    world.setAttribute(
      'transform',
      'translate(' + view.x + ' ' + view.y + ') scale(' + view.zoom + ')'
    );
    edgeLayer.textContent = '';
    nodeLayer.textContent = '';

    // Lines first, so boxes are drawn on top of them.
    for (const edge of graph.edges) {
      const a = findNode(edge.from);
      const b = findNode(edge.to);
      if (!a || !b) continue;
      const coordinates = { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
      const isSelected = selection.edgeId === edge.id;

      const line = svgEl('line', coordinates);
      line.setAttribute('class', 'mm-edge' + (isSelected ? ' selected' : ''));
      edgeLayer.appendChild(line);

      const hitArea = svgEl('line', coordinates);
      hitArea.setAttribute('class', 'mm-edge-hit');
      hitArea.setAttribute('data-edge-id', edge.id);
      edgeLayer.appendChild(hitArea);
    }

    for (const node of graph.nodes) {
      nodeLayer.appendChild(drawNode(node));
    }

    updateToolbar();
  }

  /** Builds just the outline shape of a node (w = width, h = height). */
  function buildShape(node, w, h) {
    if (node.shape === 'ellipse') {
      return svgEl('ellipse', { cx: 0, cy: 0, rx: w / 2, ry: h / 2 });
    }
    if (node.shape === 'diamond') {
      return svgEl('polygon', {
        points: '0,' + -h / 2 + ' ' + w / 2 + ',0 0,' + h / 2 + ' ' + -w / 2 + ',0',
      });
    }
    const corner = node.shape === 'round' ? h / 2 : 4;
    return svgEl('rect', { x: -w / 2, y: -h / 2, width: w, height: h, rx: corner });
  }

  /** Builds the SVG for one node: (optional selection outline) + shape + text. */
  function drawNode(node) {
    const size = getSize(node);
    const w = size.w;
    const h = size.h;

    const group = svgEl('g', { transform: 'translate(' + node.x + ' ' + node.y + ')' });
    const isSelected = selection.nodeIds.has(node.id);
    const isConnectSource = connectSourceId === node.id;
    group.setAttribute('class', 'mm-node' + (isSelected ? ' selected' : ''));

    // The orange outline around selected nodes. It is a SEPARATE, slightly bigger
    // shape, so it never hides the node's own border color.
    if (isSelected || isConnectSource) {
      const halo = buildShape(node, w + 12, h + 12);
      halo.setAttribute('class', 'mm-halo' + (isConnectSource ? ' connect-source' : ''));
      group.appendChild(halo);
    }

    // The node itself. fill = inside color, stroke = border color.
    const shape = buildShape(node, w, h);
    shape.setAttribute('class', 'mm-shape');
    shape.setAttribute('fill', node.fill);
    shape.setAttribute('stroke', node.borderColor);
    group.appendChild(shape);

    // Cut very long text so it stays inside the shape (the full text is kept).
    const usableWidth = node.shape === 'diamond' ? w * 0.6 : w - 24;
    const maxChars = Math.floor(usableWidth / CHAR_WIDTH);
    const shown = node.text.length > maxChars ? node.text.slice(0, maxChars - 1) + '…' : node.text;

    // Text color: the one the user picked, or black/white if they never picked one.
    const label = svgEl('text', { x: 0, y: 0, fill: node.textColor || textColorFor(node.fill) });
    label.setAttribute('class', 'mm-text');
    label.textContent = shown; // textContent (not innerHTML) keeps note text from running as code
    group.appendChild(label);

    return group;
  }

  /** Puts a color into a color picker (unless the user is using that picker right now). */
  function showColor(input, color) {
    if (document.activeElement !== input) input.value = color;
  }

  /** Keeps the buttons in sync: greyed out when they cannot be used. */
  function updateToolbar() {
    const nodes = selectedNodes();
    const first = nodes[0];

    // With several nodes selected, the pickers show the colors of the first one.
    if (first) {
      showColor(fillInput, first.fill);
      showColor(textColorInput, first.textColor || textColorFor(first.fill));
      showColor(borderInput, first.borderColor);
      shapeSelect.value = first.shape;
    }
    const noNodes = nodes.length === 0;
    fillInput.disabled = noNodes;
    textColorInput.disabled = noNodes;
    borderInput.disabled = noNodes;
    shapeSelect.disabled = noNodes;
    deleteButton.disabled = !hasSelection();
    undoButton.disabled = undoStack.length === 0;
    redoButton.disabled = redoStack.length === 0;
    connectButton.classList.toggle('active', connectMode);
    canvasBox.classList.toggle('connecting', connectMode);
  }

  /** If a node is off-screen (or cut off at the edge), slide the camera just enough to show all of it. */
  function ensureVisible(node) {
    const box = svg.getBoundingClientRect();
    const size = getSize(node);
    const marginX = (size.w / 2) * view.zoom + 20; // half the node + a little space
    const marginY = (size.h / 2) * view.zoom + 20;
    const screenX = node.x * view.zoom + view.x;
    const screenY = node.y * view.zoom + view.y;
    if (screenX < marginX) view.x += marginX - screenX;
    else if (screenX > box.width - marginX) view.x -= screenX - (box.width - marginX);
    if (screenY < marginY) view.y += marginY - screenY;
    else if (screenY > box.height - marginY) view.y -= screenY - (box.height - marginY);
  }

  /** Zooms and moves the camera so the whole map is visible. */
  function fitView() {
    const box = svg.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) {
      needsFit = true; // the panel is not visible yet; try again when it is
      return;
    }
    needsFit = false;

    if (graph.nodes.length === 0) {
      view = { x: box.width / 2, y: box.height / 2, zoom: 1 };
      render();
      return;
    }

    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    for (const node of graph.nodes) {
      const size = getSize(node);
      left = Math.min(left, node.x - size.w / 2);
      right = Math.max(right, node.x + size.w / 2);
      top = Math.min(top, node.y - size.h / 2);
      bottom = Math.max(bottom, node.y + size.h / 2);
    }

    const margin = 40;
    const zoom = clamp(
      Math.min(box.width / (right - left + margin * 2), box.height / (bottom - top + margin * 2)),
      MIN_ZOOM,
      1 // never zoom in past 100% just to fit a small map
    );
    view = {
      zoom: zoom,
      x: box.width / 2 - ((left + right) / 2) * zoom,
      y: box.height / 2 - ((top + bottom) / 2) * zoom,
    };
    render();
  }

  /** Zoom by a factor, keeping the point (screenX, screenY) still. */
  function zoomAt(screenX, screenY, factor) {
    const newZoom = clamp(view.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const worldX = (screenX - view.x) / view.zoom;
    const worldY = (screenY - view.y) / view.zoom;
    view.zoom = newZoom;
    view.x = screenX - worldX * newZoom;
    view.y = screenY - worldY * newZoom;
    render();
  }

  /* ======================= 6. EDITING ACTIONS ============================== */

  /* Every edit goes through change(). It saves an undo step first, runs your
     edit, redraws, and schedules an auto-save. Example:
         change(() => { node.text = 'Hello'; });                                    */
  function change(edit) {
    pushUndo();
    edit();
    render();
    scheduleSave();
  }

  function pushUndo() {
    undoStack.push(JSON.stringify(graph));
    if (undoStack.length > MAX_UNDO_STEPS) undoStack.shift();
    redoStack.length = 0;
  }

  function undo() {
    if (undoStack.length === 0) return;
    redoStack.push(JSON.stringify(graph));
    restoreGraph(undoStack.pop());
  }

  function redo() {
    if (redoStack.length === 0) return;
    undoStack.push(JSON.stringify(graph));
    restoreGraph(redoStack.pop());
  }

  function restoreGraph(json) {
    graph = JSON.parse(json);
    clearSelection();
    connectSourceId = null;
    render();
    scheduleSave();
  }

  /** Inserts a new, unconnected shape and lets the user type its text. */
  function addShape(shape, position) {
    const at = position || findFreeSpot(viewCenterWorld());
    const node = makeNode('New idea', at.x, at.y, shape);
    change(() => {
      graph.nodes.push(node);
      if (!graph.rootId) graph.rootId = node.id;
    });
    selectOnlyNode(node.id);
    ensureVisible(node);
    render();
    startEditing(node.id);
  }

  /** Adds a node connected to the selected one, placed to its RIGHT (like the sideways tree). */
  function addChild() {
    const parent = selectedNode();
    if (!parent) {
      setStatus('Select ONE node first, then press + Child.');
      return;
    }
    const siblings = graph.edges.filter((e) => e.from === parent.id).length;

    // Start to the right of the parent, a bit lower for every child it already has.
    // findFreeSpot then nudges the new node if something is already there.
    const spot = findFreeSpot({ x: parent.x + LEVEL_GAP * 0.7, y: parent.y + siblings * ROW_GAP });
    const child = makeNode('New idea', spot.x, spot.y);
    change(() => {
      graph.nodes.push(child);
      graph.edges.push(makeEdge(parent.id, child.id));
    });
    selectOnlyNode(child.id);
    ensureVisible(child);
    render();
    startEditing(child.id);
  }

  /** Deletes ALL selected nodes (and the lines attached to them), or the selected line. */
  function deleteSelected() {
    if (selection.nodeIds.size > 0) {
      const ids = selection.nodeIds;
      change(() => {
        graph.nodes = graph.nodes.filter((n) => !ids.has(n.id));
        graph.edges = graph.edges.filter((e) => !ids.has(e.from) && !ids.has(e.to));
        if (!graph.nodes.some((n) => n.id === graph.rootId)) {
          graph.rootId = graph.nodes.length > 0 ? graph.nodes[0].id : null;
        }
      });
    } else if (selection.edgeId !== null) {
      const id = selection.edgeId;
      change(() => {
        graph.edges = graph.edges.filter((e) => e.id !== id);
      });
    }
    clearSelection();
    render();
  }

  /** Used by the three color pickers. property is 'fill', 'textColor' or 'borderColor'.
      It colors ALL selected nodes. A whole color-picking session counts as ONE undo step. */
  function applyColor(input, property) {
    const nodes = selectedNodes();
    if (nodes.length === 0) return;
    if (!colorEditing) {
      pushUndo();
      colorEditing = true;
    }
    nodes.forEach((node) => {
      node[property] = input.value;
    });
    render();
    scheduleSave();
  }

  function toggleConnectMode() {
    connectMode = !connectMode;
    connectSourceId = null;
    setHint(
      connectMode ? 'Connect: click the first box, then the box to join it to. Esc to stop.' : ''
    );
    if (!connectMode) defaultHint();
    render();
  }

  /** Called when a node is clicked while Connect mode is on. */
  function handleConnectClick(nodeId) {
    if (connectSourceId === null) {
      connectSourceId = nodeId;
      setHint('Now click the box to connect it to. (Click it again to cancel.)');
    } else if (connectSourceId === nodeId) {
      connectSourceId = null;
      setHint('Connect: click the first box, then the box to join it to. Esc to stop.');
    } else {
      const fromId = connectSourceId;
      connectSourceId = null;
      if (!edgeExists(fromId, nodeId)) {
        change(() => graph.edges.push(makeEdge(fromId, nodeId)));
      }
      setHint('Connected! Pick another pair, or press Esc to stop.');
    }
    render();
  }

  function rearrange() {
    change(() => relayoutTree(graph));
    fitView();
  }

  /** Shows a text box over a node so the user can rename it. */
  function startEditing(nodeId) {
    const node = findNode(nodeId);
    if (!node) return;
    if (editInput) editInput.blur();

    const size = getSize(node);
    const boxWidth = Math.max(size.w, 140) * view.zoom;
    const boxHeight = 32 * view.zoom;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'mm-edit';
    input.value = node.text;
    input.setAttribute('aria-label', 'Node text');
    input.style.width = boxWidth + 'px';
    input.style.height = boxHeight + 'px';
    input.style.left = node.x * view.zoom + view.x - boxWidth / 2 + 'px';
    input.style.top = node.y * view.zoom + view.y - boxHeight / 2 + 'px';
    input.style.fontSize = 14 * view.zoom + 'px';
    canvasBox.appendChild(input);
    editInput = input;

    let finished = false;
    function finish(saveText) {
      if (finished) return;
      finished = true;
      const text = input.value.trim();
      input.remove();
      editInput = null;
      if (saveText && text !== '' && text !== node.text) {
        change(() => {
          node.text = text;
        });
      }
      canvasBox.focus();
    }

    input.addEventListener('keydown', (event) => {
      event.stopPropagation(); // do not trigger shortcuts like Delete while typing
      if (event.key === 'Enter') finish(true);
      if (event.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));

    input.focus();
    input.select();
  }

  /* ===================== 7. MOUSE AND KEYBOARD ============================= */

  /* ---- Toolbar buttons: each <button data-action="..."> runs the matching line. ---- */
  const actions = {
    'add-shape': (button) => addShape(button.dataset.shape),
    'add-child': () => addChild(),
    'toggle-connect': () => toggleConnectMode(),
    delete: () => deleteSelected(),
    auto: () => generateFromNote('auto'),
    outline: () => generateFromNote('outline'),
    relayout: () => rearrange(),
    undo: () => undo(),
    redo: () => redo(),
    'zoom-in': () => zoomAt(svg.clientWidth / 2, svg.clientHeight / 2, 1.25),
    'zoom-out': () => zoomAt(svg.clientWidth / 2, svg.clientHeight / 2, 0.8),
    fit: () => fitView(),
    close: () => closePanel(),
  };

  appBox.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (button && actions[button.dataset.action]) {
      // Move the keyboard focus back to the canvas first, so that pressing the
      // Spacebar later does not "click" this button again.
      canvasBox.focus();
      actions[button.dataset.action](button);
    }
  });

  /* ---- The three color pickers ----
     "input" happens while you drag around in the picker (live preview).
     "change" happens when you close the picker. We handle both so it works everywhere. */
  function connectColorPicker(input, property) {
    input.addEventListener('input', () => applyColor(input, property));
    input.addEventListener('change', () => {
      applyColor(input, property);
      colorEditing = false; // the picking session is over
    });
  }
  connectColorPicker(fillInput, 'fill');
  connectColorPicker(textColorInput, 'textColor');
  connectColorPicker(borderInput, 'borderColor');

  shapeSelect.addEventListener('change', () => {
    const nodes = selectedNodes();
    if (nodes.length > 0) {
      change(() => nodes.forEach((node) => (node.shape = shapeSelect.value)));
    }
  });

  /* ---- Mouse on the canvas ---- */

  /** Starts moving the camera. */
  function startPan(event) {
    drag = {
      kind: 'pan',
      startClientX: event.clientX,
      startClientY: event.clientY,
      startViewX: view.x,
      startViewY: view.y,
    };
  }

  /** Starts moving ALL the selected nodes together. */
  function startNodeDrag(point, collapseTo) {
    drag = {
      kind: 'node',
      startPoint: point,
      // remember where every selected node started
      items: selectedNodes().map((node) => ({ node: node, startX: node.x, startY: node.y })),
      collapseTo: collapseTo, // if you only CLICK (no move), select just this node
      moved: false,
      before: JSON.stringify(graph), // for undo
    };
  }

  /** Starts the blue selection rectangle. keepOld = Shift/Ctrl held, keep what is selected. */
  function startBoxSelect(point, keepOld) {
    const baseIds = keepOld ? new Set(selection.nodeIds) : new Set();
    if (!keepOld) clearSelection();
    const marquee = svgEl('rect', { class: 'mm-marquee', x: point.x, y: point.y, width: 0, height: 0 });
    world.appendChild(marquee); // render() does not clear this, so it stays while we drag
    drag = { kind: 'box', startPoint: point, baseIds: baseIds, marquee: marquee };
  }

  /** While dragging the blue rectangle: resize it and select every node it touches. */
  function updateBoxSelect(point) {
    const start = drag.startPoint;
    const box = {
      left: Math.min(start.x, point.x),
      right: Math.max(start.x, point.x),
      top: Math.min(start.y, point.y),
      bottom: Math.max(start.y, point.y),
    };
    drag.marquee.setAttribute('x', box.left);
    drag.marquee.setAttribute('y', box.top);
    drag.marquee.setAttribute('width', box.right - box.left);
    drag.marquee.setAttribute('height', box.bottom - box.top);

    const picked = new Set(drag.baseIds);
    findNodesInBox(box).forEach((node) => picked.add(node.id));
    selection = { nodeIds: picked, edgeId: null };
    render();
  }

  svg.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return; // left button only
    canvasBox.focus();
    svg.setPointerCapture(event.pointerId); // keep receiving moves even outside the panel

    // Spacebar held = move the camera, no matter what is under the mouse.
    if (spaceDown) {
      startPan(event);
      return;
    }

    const point = toWorld(event);
    const node = findNodeAt(point);
    const edgeElement = event.target.closest('[data-edge-id]');
    const addToSelection = event.shiftKey || event.ctrlKey || event.metaKey;
    // (Connect mode uses plain clicks, so double-click detection is off while it is on.)
    const doubleClick = connectMode ? false : isDoubleClick(event, node ? node.id : null);

    if (node) {
      if (connectMode) {
        handleConnectClick(node.id);
        return;
      }
      if (doubleClick) {
        // Double-click a node = rename it. (setTimeout: let the browser finish its own
        // mouse-down focus handling first, otherwise it would close the text box at once.)
        selectOnlyNode(node.id);
        render();
        setTimeout(() => startEditing(node.id), 0);
        return;
      }
      if (addToSelection) {
        toggleNodeInSelection(node.id);
        render();
        return;
      }
      // Plain click on a node:
      //  - not selected yet     -> select only this node
      //  - already in a group   -> keep the group, so the whole group can be dragged
      let collapseTo = null;
      if (!selection.nodeIds.has(node.id)) {
        selectOnlyNode(node.id);
      } else if (selection.nodeIds.size > 1) {
        collapseTo = node.id;
      }
      startNodeDrag(point, collapseTo);
    } else if (edgeElement) {
      selectEdge(edgeElement.getAttribute('data-edge-id'));
    } else if (doubleClick) {
      // Double-click empty space = new box right there.
      setTimeout(() => addShape('round', point), 0);
      return;
    } else {
      // Click and hold on empty space = start the selection rectangle.
      startBoxSelect(point, addToSelection);
    }
    render();
  });

  svg.addEventListener('pointermove', (event) => {
    if (!drag) return;
    if (drag.kind === 'pan') {
      view.x = drag.startViewX + (event.clientX - drag.startClientX);
      view.y = drag.startViewY + (event.clientY - drag.startClientY);
      render();
    } else if (drag.kind === 'node') {
      const point = toWorld(event);
      const dx = point.x - drag.startPoint.x;
      const dy = point.y - drag.startPoint.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return; // ignore tiny hand shakes
      drag.items.forEach((item) => {
        item.node.x = item.startX + dx;
        item.node.y = item.startY + dy;
      });
      drag.moved = true;
      render();
    } else if (drag.kind === 'box') {
      updateBoxSelect(toWorld(event));
    }
  });

  /** The mouse button was released (or the drag was cancelled). */
  function endDrag() {
    if (drag && drag.kind === 'node') {
      if (drag.moved) {
        undoStack.push(drag.before); // now the move can be undone
        if (undoStack.length > MAX_UNDO_STEPS) undoStack.shift();
        redoStack.length = 0;
        scheduleSave();
        render();
      } else if (drag.collapseTo) {
        // It was just a click on a node inside a group: select only that node.
        selectOnlyNode(drag.collapseTo);
        render();
      }
    }
    if (drag && drag.kind === 'box') {
      drag.marquee.remove(); // hide the blue rectangle
    }
    drag = null;
  }

  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);

  /* Scroll = pan. Ctrl + scroll (or trackpad pinch) = zoom. */
  svg.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const box = svg.getBoundingClientRect();
        zoomAt(event.clientX - box.left, event.clientY - box.top, event.deltaY < 0 ? 1.1 : 1 / 1.1);
      } else {
        view.x -= event.deltaX;
        view.y -= event.deltaY;
        render();
      }
    },
    { passive: false }
  );

  /* ---- Keyboard ---- */

  /** Remembers whether the Spacebar is held, and shows a "hand" cursor while it is. */
  function setSpaceDown(isDown) {
    spaceDown = isDown;
    canvasBox.classList.toggle('pan-ready', isDown);
  }

  document.addEventListener('keydown', (event) => {
    const tag = event.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT') return; // the user is typing or choosing something
    const ctrl = event.ctrlKey || event.metaKey;

    if (event.key === ' ') {
      event.preventDefault(); // stop the page from scrolling
      setSpaceDown(true);
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      deleteSelected();
    } else if (event.key === 'Enter' || event.key === 'F2') {
      const node = selectedNode();
      if (node) startEditing(node.id);
    } else if (event.key === 'Tab') {
      event.preventDefault();
      addChild();
    } else if (event.key === 'Escape') {
      if (connectMode) toggleConnectMode();
      clearSelection();
      render();
    } else if (ctrl && event.key.toLowerCase() === 'a') {
      event.preventDefault(); // Ctrl+A = select every node
      selection = { nodeIds: new Set(graph.nodes.map((n) => n.id)), edgeId: null };
      render();
    } else if (ctrl && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? redo() : undo();
    } else if (ctrl && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      redo();
    }
  });

  // Releasing the Spacebar (or clicking away from the panel) ends "move the map" mode.
  document.addEventListener('keyup', (event) => {
    if (event.key === ' ') setSpaceDown(false);
  });
  window.addEventListener('blur', () => setSpaceDown(false));

  /* ================== 8. TALKING TO JOPLIN (load / save) =================== */

  /** Sends a message to index.ts and returns its answer. Never throws. */
  async function askJoplin(message) {
    try {
      return (await webviewApi.postMessage(message)) || {};
    } catch (error) {
      return { error: String(error) };
    }
  }

  function scheduleSave() {
    setStatus('Unsaved changes…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, SAVE_DELAY_MS);
  }

  async function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!currentNoteId) return;
    const reply = await askJoplin({ name: 'save', noteId: currentNoteId, graph: graph });
    setStatus(reply.error ? 'Could not save: ' + reply.error : 'Saved ✓');
  }

  /** Loads the saved map of the note that is open (or makes a new one). */
  async function loadCurrentNote() {
    if (saveTimer) await saveNow(); // finish saving the PREVIOUS note first

    const reply = await askJoplin({ name: 'load' });
    undoStack.length = 0;
    redoStack.length = 0;
    clearSelection();
    connectSourceId = null;

    if (reply.error) {
      currentNoteId = null;
      graph = { nodes: [], edges: [], rootId: null };
      setStatus(reply.error);
    } else {
      currentNoteId = reply.noteId;
      graph = readSavedData(reply.data, reply.title);
      setStatus('');
    }
    needsFit = true;
    fitView();
  }

  /** Accepts the current save format, an older "tree" format, or nothing (new map). */
  function readSavedData(data, title) {
    if (data && Array.isArray(data.nodes)) return normalizeGraph(data);
    if (data && typeof data.text === 'string') return treeToGraph(data);
    return newMap(title);
  }

  /** "Auto" and "From outline": ask Joplin for a tree, then lay it out sideways. */
  async function generateFromNote(kind) {
    if (!currentNoteId) {
      setStatus('Open a note first.');
      return;
    }
    setStatus('Working…');
    const reply = await askJoplin({ name: kind, noteId: currentNoteId });
    if (reply.error) {
      setStatus('Error: ' + reply.error);
      return;
    }
    if (!reply.tree || reply.tree.children.length === 0) {
      setStatus('Not enough text (or headings/bullets) in this note to build a map.');
      return;
    }
    change(() => {
      graph = treeToGraph(reply.tree);
      clearSelection();
    });
    fitView();
    setStatus('Map created. Press Ctrl+Z to undo.');
  }

  async function closePanel() {
    if (saveTimer) await saveNow();
    await askJoplin({ name: 'close' });
  }

  /* ============================ 9. START-UP ================================ */

  webviewApi.onMessage((event) => {
    if (event.message.name === 'noteChanged') loadCurrentNote();
  });

  // When the panel gets a size (first time it is shown, or when it is resized):
  new ResizeObserver(() => {
    if (needsFit) fitView();
    else render();
  }).observe(canvasBox);

  defaultHint();
  render();
  loadCurrentNote();

  // This lets us unit-test the layout code in Node. Joplin ignores it.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { placeNode, graphToTree, relayoutTree, treeToGraph, newMap, normalizeGraph };
  }
})();
