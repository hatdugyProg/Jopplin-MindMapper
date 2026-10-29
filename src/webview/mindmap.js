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
 *     nodes: [ { id, text, x, y, shape, color,       <- the boxes
 *                textColor, borderColor } ],
 *     edges: [ { id, from, to } ]                    <- the lines between boxes
 *   }
 *
 * shape is 'rect' | 'round' | 'ellipse' | 'diamond'.
 * color is the FILL (inside) color. textColor and borderColor are optional:
 * old saved maps do not have them, so we use default colors when they are missing.
 * x and y are positions on an infinite canvas ("world" coordinates).
 *
 * THE BASIC IDEA  (state -> render)
 *   - The variables in section 2 describe everything on screen.
 *   - render() redraws the screen from those variables.
 *   - To change something: change the variables, then call render().
 *   - For edits the user may want to undo, use change(() => { ... }) (section 6).
 *
 * SECTIONS
 *   1. Settings            6. Editing actions
 *   2. State               7. Mouse and keyboard
 *   3. Small helpers       8. Talking to Joplin (load / save / auto)
 *   4. Layouts             9. Start-up
 *   5. Drawing (render)
 *
 * CHANGED after the ethnographic study:
 *   - Fill, Text and Border colors are now three separate things (fixes the
 *     "fill color changes the border and text" bug).
 *   - New sideways tree layout (default). The radial layout is still available.
 *   - Connect mode turns itself off after one line is drawn.
 *   - "Nodes: Words / Phrases" choice is sent along with the Auto request.
 * ========================================================================== */

(function () {
  'use strict';

  /* ========================== 1. SETTINGS ================================== */
  /* Change these numbers to tweak the look and feel. */

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const RING_GAP = 200; // radial layout: distance between circles
  const COLUMN_GAP = 300; // sideways tree: distance between levels (left to right)
  const ROW_GAP = 70; // sideways tree: distance between neighbours (top to bottom)
  const NODE_HEIGHT = 44;
  const MIN_NODE_WIDTH = 110;
  const MAX_NODE_WIDTH = 260;
  const CHAR_WIDTH = 8; // rough width of one letter, used to size boxes
  const MIN_ZOOM = 0.2;
  const MAX_ZOOM = 3;
  const SAVE_DELAY_MS = 1000; // auto-save this long after the last change
  const MAX_UNDO_STEPS = 50;
  const ROOT_COLOR = '#ffe9a8'; // fill of the centre node
  const DEFAULT_COLOR = '#dbe7ff'; // fill of every other node
  const DEFAULT_TEXT_COLOR = '#1a1a1a'; // text of every node (dark, so it reads on light fills)
  const DEFAULT_BORDER_COLOR = '#4a6fa5'; // outline of every node

  /* ============================ 2. STATE =================================== */

  let graph = { nodes: [], edges: [], rootId: null }; // the map itself
  let view = { x: 0, y: 0, zoom: 1 }; // where the camera is looking
  let selection = { type: null, id: null }; // type: 'node' | 'edge' | null
  let connectMode = false; // is the Connect tool on?
  let connectSourceId = null; // first node clicked in Connect mode
  let layoutMode = 'tree'; // 'tree' (sideways) or 'radial'
  let drag = null; // info about the drag in progress (if any)
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
  const colorInput = byId('mm-color'); // FILL color
  const textColorInput = byId('mm-text-color');
  const borderColorInput = byId('mm-border-color');
  const shapeSelect = byId('mm-shape');
  const termModeSelect = byId('mm-term-mode'); // 'words' or 'phrases'
  const layoutSelect = byId('mm-layout'); // 'tree' or 'radial'
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

  function makeNode(text, x, y, shape, color) {
    return {
      id: newId(),
      text: text,
      x: x,
      y: y,
      shape: shape || 'round',
      color: color || DEFAULT_COLOR, // fill
      textColor: DEFAULT_TEXT_COLOR,
      borderColor: DEFAULT_BORDER_COLOR,
    };
  }

  function makeEdge(fromId, toId) {
    return { id: newId(), from: fromId, to: toId };
  }

  function findNode(id) {
    return graph.nodes.find((node) => node.id === id);
  }

  function selectedNode() {
    return selection.type === 'node' ? findNode(selection.id) : null;
  }

  function edgeExists(a, b) {
    return graph.edges.some((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a));
  }

  /** The text color of a node. Old saved maps have no textColor, so use the default. */
  function getTextColor(node) {
    return node.textColor || DEFAULT_TEXT_COLOR;
  }

  /** The border color of a node. Old saved maps have no borderColor, so use the default. */
  function getBorderColor(node) {
    return node.borderColor || DEFAULT_BORDER_COLOR;
  }

  /** How big a node is. It grows with its text, and depends on its shape. */
  function getSize(node) {
    const base = clamp(24 + node.text.length * CHAR_WIDTH, MIN_NODE_WIDTH, MAX_NODE_WIDTH);
    if (node.shape === 'diamond') return { w: base * 1.4, h: NODE_HEIGHT * 1.6 };
    if (node.shape === 'ellipse') return { w: base * 1.15, h: NODE_HEIGHT * 1.2 };
    return { w: base, h: NODE_HEIGHT };
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
    setHint('Double-click to rename · drag to move · scroll to pan · Ctrl+scroll to zoom');
  }

  /* ============================ 4. LAYOUTS ================================= */
  /* A layout decides WHERE every node goes. There are two:
       - Sideways tree (default): the centre node is on the left, and each level
         is a column to the right of the one before. Easy to read top to bottom.
       - Radial tree: the centre node is in the middle, levels are circles.
     Both start from the same thing: graphToTree() turns the boxes and lines
     into a tree, then a "place" function gives every tree node an x and y. */

  const CENTER_X = 0;
  const CENTER_Y = 0;

  /** How many "end" nodes (nodes without children) are below this node? */
  function countLeaves(node) {
    if (node.children.length === 0) {
      return 1;
    }
    let total = 0;
    for (const child of node.children) {
      total += countLeaves(child);
    }
    return total;
  }

  /* ---- Radial layout ---- */

  /** Places a node in the middle of its slice, then splits the slice among its children. */
  function placeNode(node, startAngle, endAngle, depth) {
    const middleAngle = (startAngle + endAngle) / 2;
    const radius = depth * RING_GAP; // the root has depth 0, so it sits in the centre
    node.x = CENTER_X + radius * Math.cos(middleAngle);
    node.y = CENTER_Y + radius * Math.sin(middleAngle);

    if (node.children.length > 0) {
      const leavesInNode = countLeaves(node);
      let currentAngle = startAngle;
      for (const child of node.children) {
        const share = countLeaves(child) / leavesInNode;
        const childEnd = currentAngle + (endAngle - startAngle) * share;
        placeNode(child, currentAngle, childEnd, depth + 1);
        currentAngle = childEnd;
      }
    }
  }

  /* ---- Sideways tree layout ---- */

  /** Places a node in its column (x = depth), and in its row (y).
      - An "end" node (no children) takes the next free row.
      - A node with children sits in the middle of its first and last child.
      `rows` is an object { next: 0 } that counts the rows already used. */
  function placeTreeNode(node, depth, rows) {
    node.x = CENTER_X + depth * COLUMN_GAP;

    if (node.children.length === 0) {
      node.y = CENTER_Y + rows.next * ROW_GAP;
      rows.next += 1;
      return;
    }

    for (const child of node.children) {
      placeTreeNode(child, depth + 1, rows);
    }
    const firstChild = node.children[0];
    const lastChild = node.children[node.children.length - 1];
    node.y = (firstChild.y + lastChild.y) / 2;
  }

  /* ---- Shared helpers ---- */

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

  /** Moves every node that is connected to the root into its place, using the
      layout the user picked (layoutMode). Nodes that are not connected to
      anything are left where they are. */
  function relayout(g) {
    if (g.nodes.length === 0) return;
    const tree = graphToTree(g);

    if (layoutMode === 'radial') {
      placeNode(tree, 0, 2 * Math.PI, 0);
    } else {
      placeTreeNode(tree, 0, { next: 0 });
      // The tree's rows start at y = 0 and go down. Shift everything up by half
      // the height so the map is centred around y = 0 like the radial one.
      const shift = (countLeaves(tree) - 1) * ROW_GAP * 0.5;
      (function moveUp(treeNode) {
        treeNode.y -= shift;
        treeNode.children.forEach(moveUp);
      })(tree);
    }

    (function copyPositions(treeNode) {
      const graphNode = g.nodes.find((n) => n.id === treeNode.id);
      graphNode.x = treeNode.x;
      graphNode.y = treeNode.y;
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
        isRoot ? ROOT_COLOR : DEFAULT_COLOR
      );
      g.nodes.push(node);
      if (!isRoot) g.edges.push(makeEdge(parentId, node.id));
      treeNode.children.forEach((child) => addNode(child, node.id));
    }

    addNode(tree, null);
    g.rootId = g.nodes[0].id;
    relayout(g);
    return g;
  }

  /** A brand-new map: just one centre node with the note's title. */
  function newMap(title) {
    const root = makeNode(title || 'Main idea', 0, 0, 'ellipse', ROOT_COLOR);
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
      const isSelected = selection.type === 'edge' && selection.id === edge.id;

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

  /** Builds the SVG for one node: a shape plus its text. */
  function drawNode(node) {
    const size = getSize(node);
    const w = size.w;
    const h = size.h;

    const group = svgEl('g', { transform: 'translate(' + node.x + ' ' + node.y + ')' });
    let className = 'mm-node';
    if (selection.type === 'node' && selection.id === node.id) className += ' selected';
    if (connectSourceId === node.id) className += ' connect-source';
    group.setAttribute('class', className);

    let shape;
    if (node.shape === 'ellipse') {
      shape = svgEl('ellipse', { cx: 0, cy: 0, rx: w / 2, ry: h / 2 });
    } else if (node.shape === 'diamond') {
      shape = svgEl('polygon', {
        points: '0,' + -h / 2 + ' ' + w / 2 + ',0 0,' + h / 2 + ' ' + -w / 2 + ',0',
      });
    } else {
      const corner = node.shape === 'round' ? h / 2 : 4;
      shape = svgEl('rect', { x: -w / 2, y: -h / 2, width: w, height: h, rx: corner });
    }
    shape.setAttribute('class', 'mm-shape');
    shape.setAttribute('fill', node.color); // FILL = inside the shape
    shape.setAttribute('stroke', getBorderColor(node)); // BORDER = the outline
    group.appendChild(shape);

    // Cut very long text so it stays inside the shape (the full text is kept).
    const usableWidth = node.shape === 'diamond' ? w * 0.6 : w - 24;
    const maxChars = Math.floor(usableWidth / CHAR_WIDTH);
    const shown = node.text.length > maxChars ? node.text.slice(0, maxChars - 1) + '…' : node.text;

    const label = svgEl('text', { x: 0, y: 0, fill: getTextColor(node) }); // TEXT color
    label.setAttribute('class', 'mm-text');
    label.textContent = shown; // textContent (not innerHTML) keeps note text from running as code
    group.appendChild(label);

    return group;
  }

  /** Keeps the buttons in sync: greyed out when they cannot be used. */
  function updateToolbar() {
    const node = selectedNode();
    if (node) {
      colorInput.value = node.color;
      textColorInput.value = getTextColor(node);
      borderColorInput.value = getBorderColor(node);
      shapeSelect.value = node.shape;
    }
    colorInput.disabled = !node;
    textColorInput.disabled = !node;
    borderColorInput.disabled = !node;
    shapeSelect.disabled = !node;
    deleteButton.disabled = selection.type === null;
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
    selection = { type: null, id: null };
    connectSourceId = null;
    render();
    scheduleSave();
  }

  function select(type, id) {
    selection = { type: type, id: id };
  }

  /** Inserts a new, unconnected shape and lets the user type its text. */
  function addShape(shape, position) {
    const at = position || findFreeSpot(viewCenterWorld());
    const node = makeNode('New idea', at.x, at.y, shape);
    change(() => {
      graph.nodes.push(node);
      if (!graph.rootId) graph.rootId = node.id;
    });
    select('node', node.id);
    ensureVisible(node);
    render();
    startEditing(node.id);
  }

  /** Adds a node connected to the selected one.
      Sideways tree: the child goes to the right of its parent, below its siblings.
      Radial: the child goes on the side facing away from the centre. */
  function addChild() {
    const parent = selectedNode();
    if (!parent) {
      setStatus('Select a node first, then press + Child.');
      return;
    }
    const siblings = graph.edges.filter((e) => e.from === parent.id).length;

    let childX;
    let childY;
    if (layoutMode === 'tree') {
      childX = parent.x + COLUMN_GAP;
      childY = parent.y + siblings * ROW_GAP;
    } else {
      const root = findNode(graph.rootId) || parent;
      let angle;
      if (parent === root) {
        angle = siblings * 0.9; // spread the root's children around it
      } else {
        const awayFromRoot = Math.atan2(parent.y - root.y, parent.x - root.x);
        const fan = (siblings % 2 === 1 ? 1 : -1) * Math.ceil(siblings / 2) * 0.5;
        angle = awayFromRoot + fan;
      }
      childX = parent.x + 220 * Math.cos(angle);
      childY = parent.y + 220 * Math.sin(angle);
    }

    const child = makeNode('New idea', childX, childY);
    change(() => {
      graph.nodes.push(child);
      graph.edges.push(makeEdge(parent.id, child.id));
    });
    select('node', child.id);
    ensureVisible(child);
    render();
    startEditing(child.id);
  }

  function deleteSelected() {
    if (selection.type === 'node') {
      const id = selection.id;
      change(() => {
        graph.nodes = graph.nodes.filter((n) => n.id !== id);
        graph.edges = graph.edges.filter((e) => e.from !== id && e.to !== id);
        if (graph.rootId === id) graph.rootId = graph.nodes.length > 0 ? graph.nodes[0].id : null;
      });
    } else if (selection.type === 'edge') {
      const id = selection.id;
      change(() => {
        graph.edges = graph.edges.filter((e) => e.id !== id);
      });
    }
    selection = { type: null, id: null };
    render();
  }

  function toggleConnectMode() {
    connectMode = !connectMode;
    connectSourceId = null;
    if (connectMode) {
      setHint('Connect: click the first box, then the box to join it to. Esc to cancel.');
    } else {
      defaultHint();
    }
    render();
  }

  /** Called when a node is clicked while Connect mode is on. */
  function handleConnectClick(nodeId) {
    if (connectSourceId === null) {
      connectSourceId = nodeId;
      setHint('Now click the box to connect it to. (Click it again to cancel.)');
    } else if (connectSourceId === nodeId) {
      connectSourceId = null;
      setHint('Connect: click the first box, then the box to join it to. Esc to cancel.');
    } else {
      const fromId = connectSourceId;
      connectSourceId = null;
      if (!edgeExists(fromId, nodeId)) {
        change(() => graph.edges.push(makeEdge(fromId, nodeId)));
      }
      // CHANGED: Connect mode now turns itself off after ONE line, so users
      // are not left wondering why it is still on.
      connectMode = false;
      setStatus('Connected ✓ (press Connect again to draw another line)');
      defaultHint();
    }
    render();
  }

  /** Re-arranges the map with the chosen layout, then fits it on screen. */
  function rearrange() {
    change(() => relayout(graph));
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
      actions[button.dataset.action](button);
    }
  });

  /* ---- The three color pickers. Each one changes ONLY its own property. ---- */

  // Fill = the color inside the shape.
  colorInput.addEventListener('change', () => {
    const node = selectedNode();
    if (node) change(() => (node.color = colorInput.value));
  });

  // Text = the color of the letters.
  textColorInput.addEventListener('change', () => {
    const node = selectedNode();
    if (node) change(() => (node.textColor = textColorInput.value));
  });

  // Border = the color of the outline.
  borderColorInput.addEventListener('change', () => {
    const node = selectedNode();
    if (node) change(() => (node.borderColor = borderColorInput.value));
  });

  shapeSelect.addEventListener('change', () => {
    const node = selectedNode();
    if (node) change(() => (node.shape = shapeSelect.value));
  });

  // Changing the layout choice re-arranges the map right away.
  layoutSelect.addEventListener('change', () => {
    layoutMode = layoutSelect.value;
    rearrange();
  });

  /* ---- Mouse on the canvas ---- */

  svg.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return; // left button only
    canvasBox.focus();
    svg.setPointerCapture(event.pointerId); // keep receiving moves even outside the panel

    const point = toWorld(event);
    const node = findNodeAt(point);
    const edgeElement = event.target.closest('[data-edge-id]');
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
        select('node', node.id);
        render();
        setTimeout(() => startEditing(node.id), 0);
        return;
      }
      select('node', node.id);
      drag = {
        kind: 'node',
        id: node.id,
        startPoint: point,
        startX: node.x,
        startY: node.y,
        moved: false,
        before: JSON.stringify(graph), // for undo
      };
    } else if (edgeElement) {
      select('edge', edgeElement.getAttribute('data-edge-id'));
    } else if (doubleClick) {
      // Double-click empty space = new box right there.
      setTimeout(() => addShape('round', point), 0);
      return;
    } else {
      select(null, null);
      drag = {
        kind: 'pan',
        startClientX: event.clientX,
        startClientY: event.clientY,
        startViewX: view.x,
        startViewY: view.y,
      };
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
      const node = findNode(drag.id);
      node.x = drag.startX + (point.x - drag.startPoint.x);
      node.y = drag.startY + (point.y - drag.startPoint.y);
      drag.moved = true;
      render();
    }
  });

  svg.addEventListener('pointerup', () => {
    if (drag && drag.kind === 'node' && drag.moved) {
      undoStack.push(drag.before); // now the move can be undone
      if (undoStack.length > MAX_UNDO_STEPS) undoStack.shift();
      redoStack.length = 0;
      scheduleSave();
      render();
    }
    drag = null;
  });

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

  document.addEventListener('keydown', (event) => {
    const tag = event.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT') return; // the user is typing or choosing something
    const ctrl = event.ctrlKey || event.metaKey;

    if (event.key === 'Delete' || event.key === 'Backspace') {
      deleteSelected();
    } else if (event.key === 'Enter' || event.key === 'F2') {
      if (selectedNode()) startEditing(selection.id);
    } else if (event.key === 'Tab') {
      event.preventDefault();
      addChild();
    } else if (event.key === 'Escape') {
      if (connectMode) toggleConnectMode();
      select(null, null);
      render();
    } else if (ctrl && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? redo() : undo();
    } else if (ctrl && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      redo();
    }
  });

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
    selection = { type: null, id: null };
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
    if (data && Array.isArray(data.nodes)) return data;
    if (data && typeof data.text === 'string') return treeToGraph(data);
    return newMap(title);
  }

  /** "Auto" and "From outline": ask Joplin for a tree, then lay it out with the chosen layout.
      For "Auto" we also send the Nodes choice ('words' or 'phrases'). */
  async function generateFromNote(kind) {
    if (!currentNoteId) {
      setStatus('Open a note first.');
      return;
    }
    setStatus('Working…');
    const reply = await askJoplin({
      name: kind,
      noteId: currentNoteId,
      mode: termModeSelect.value, // only 'auto' uses this; 'outline' ignores it
    });
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
      selection = { type: null, id: null };
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

  layoutSelect.value = layoutMode; // make the dropdown match the starting layout
  defaultHint();
  render();
  loadCurrentNote();

  // This lets us unit-test the layout code in Node. Joplin ignores it.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      countLeaves,
      placeNode,
      placeTreeNode,
      graphToTree,
      relayout,
      treeToGraph,
      newMap,
    };
  }
})();
