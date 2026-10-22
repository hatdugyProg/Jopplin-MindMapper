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
 *     layout: 'horizontal',                          <- 'horizontal' (sideways tree) or 'radial'
 *     nodes: [ { id, text, x, y, shape, color,       <- the boxes
 *                fontFamily, fontSize, bold, italic, <- (optional) text look
 *                textColor, scale } ],               <- (optional) text color, node size
 *     edges: [ { id, from, to } ]                    <- the lines between boxes
 *   }
 *
 * shape is 'rect' | 'round' | 'ellipse' | 'diamond'.
 * x and y are positions on an infinite canvas ("world" coordinates).
 * The optional node fields can be missing (old saved maps): the small
 * "...Of(node)" helpers in section 3 fill in the default.
 *
 * THE BASIC IDEA  (state -> render)
 *   - The variables in section 2 describe everything on screen.
 *   - render() redraws the screen from those variables.
 *   - To change something: change the variables, then call render().
 *   - For edits the user may want to undo, use change(() => { ... }) (section 6).
 *
 * SECTIONS
 *   1. Settings            6. Editing actions (and the format bar)
 *   2. State               7. Mouse and keyboard
 *   3. Small helpers       8. Talking to Joplin (load / save / auto)
 *   4. Layouts             9. Start-up
 *   5. Drawing (render)
 * ========================================================================== */

(function () {
  'use strict';

  /* ========================== 1. SETTINGS ================================== */
  /* Change these numbers to tweak the look and feel. */

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const RING_GAP = 200; // radial layout: distance between circles
  const H_GAP = 90; // sideways layout: empty space between two columns
  const V_GAP = 18; // sideways layout: empty space between two rows
  const NODE_HEIGHT = 44;
  const MIN_NODE_WIDTH = 110;
  const MAX_NODE_WIDTH = 260;
  const CHAR_WIDTH_RATIO = 0.58; // one letter is about this x the font size wide (sizes the boxes)
  const MIN_ZOOM = 0.2;
  const MAX_ZOOM = 3;
  const SAVE_DELAY_MS = 1000; // auto-save this long after the last change
  const MAX_UNDO_STEPS = 50;
  const ROOT_COLOR = '#ffe9a8';
  const DEFAULT_COLOR = '#dbe7ff';

  const DEFAULT_LAYOUT = 'horizontal'; // what new maps use
  const DEFAULT_FONT_SIZE = 14;
  const MIN_FONT_SIZE = 8;
  const MAX_FONT_SIZE = 48;
  const FONT_STEP = 2; // how much the A- / A+ buttons change the size
  const COMPACT_BELOW_PX = 720; // panels narrower than this show icons only

  /* The font menu. To add a font: add one line. "css" is the normal CSS font-family list;
     the first font the computer has is used, the rest are backups. */
  const FONT_CHOICES = [
    { value: 'sans', label: 'Sans-serif', css: '"Segoe UI", Arial, sans-serif' },
    { value: 'serif', label: 'Serif', css: 'Georgia, "Times New Roman", serif' },
    { value: 'mono', label: 'Monospace', css: 'Consolas, "Courier New", monospace' },
    { value: 'easy', label: 'Easy-read', css: 'Verdana, Tahoma, sans-serif' },
    { value: 'hand', label: 'Handwritten', css: '"Comic Sans MS", "Segoe Print", cursive' },
  ];

  /* The node-size menu. "value" is how many times bigger than normal the node is. */
  const SIZE_CHOICES = [
    { value: '0.8', label: 'Small' },
    { value: '1', label: 'Medium' },
    { value: '1.3', label: 'Large' },
    { value: '1.7', label: 'Extra large' },
  ];

  /* The colors shown in the color popup. */
  const FILL_COLORS = [
    '#ffe9a8', '#dbe7ff', '#ffd6d6', '#d3f9d8', '#e5dbff', '#ffe8cc',
    '#c5f6fa', '#fcc2d7', '#ffffff', '#ced4da', '#4a6fa5', '#2b2b2b',
  ];
  const TEXT_COLORS = [
    '#1a1a1a', '#ffffff', '#c92a2a', '#1864ab', '#2b8a3e', '#e67700',
    '#862e9c', '#495057',
  ];

  /* ============================ 2. STATE =================================== */

  let graph = { nodes: [], edges: [], rootId: null, layout: DEFAULT_LAYOUT }; // the map itself
  let view = { x: 0, y: 0, zoom: 1 }; // where the camera is looking
  let selection = { type: null, id: null }; // type: 'node' | 'edge' | null
  let connectMode = false; // is the Connect tool on?
  let connectSourceId = null; // first node clicked in Connect mode
  let drag = null; // info about the drag in progress (if any)
  let lastClick = { time: 0, nodeId: null, x: 0, y: 0 }; // used to detect double-clicks
  let editInput = null; // the rename text box (if open)
  let paletteTarget = null; // which color the popup is changing: 'fill' | 'text' | null (closed)
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
  const connectButton = byId('mm-connect');
  const deleteButton = byId('mm-delete');
  const undoButton = byId('mm-undo');
  const redoButton = byId('mm-redo');
  const layoutSelect = byId('mm-layout');
  const hintBox = byId('mm-hint');
  const statusBox = byId('mm-status');
  // The format bar (second toolbar row)
  const fontSelect = byId('mm-font');
  const fontSizeInput = byId('mm-font-size');
  const boldButton = byId('mm-bold');
  const italicButton = byId('mm-italic');
  const shapeSelect = byId('mm-shape');
  const scaleSelect = byId('mm-scale');
  const fillPreview = byId('mm-fill-preview');
  const textBar = byId('mm-text-bar');
  // Every control in the format bar: they are all greyed out when no node is selected.
  const formatControls = appBox.querySelectorAll('#mm-format button, #mm-format select, #mm-format input');
  // The color popup
  const palette = byId('mm-palette');
  const paletteTitle = byId('mm-palette-title');
  const swatchBox = byId('mm-swatches');
  const hexInput = byId('mm-hex');
  const autoTextButton = byId('mm-text-auto');

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
      color: color || DEFAULT_COLOR,
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

  /* ---- Text look of a node. Old maps do not have these fields, so each helper
          returns a default when the field is missing. ---- */

  /** The font choice (an item of FONT_CHOICES) this node uses. */
  function fontChoiceOf(node) {
    return FONT_CHOICES.find((font) => font.value === node.fontFamily) || FONT_CHOICES[0];
  }

  function fontSizeOf(node) {
    return node.fontSize || DEFAULT_FONT_SIZE;
  }

  /** How many times bigger than normal the node is (1 = normal). */
  function scaleOf(node) {
    return node.scale || 1;
  }

  /** The text color: the one the user picked, or automatic (dark on light, white on dark). */
  function textColorOf(node) {
    return node.textColor || textColorFor(node.color);
  }

  /** Rough width of one letter of this node's text, in pixels. */
  function charWidthOf(node) {
    return fontSizeOf(node) * CHAR_WIDTH_RATIO * (node.bold ? 1.1 : 1);
  }

  /** How big a node is. It grows with its text, its font size and its size setting,
      and depends on its shape. */
  function getSize(node) {
    const fontSize = fontSizeOf(node);
    const scale = scaleOf(node);
    // A bigger font is allowed to make the box wider before the text gets cut with "..."
    const widestAllowed = MAX_NODE_WIDTH * Math.max(1, fontSize / DEFAULT_FONT_SIZE);
    const width = clamp(24 + node.text.length * charWidthOf(node), MIN_NODE_WIDTH, widestAllowed) * scale;
    const height = Math.max(NODE_HEIGHT, fontSize * 2.4) * scale;

    if (node.shape === 'diamond') return { w: width * 1.4, h: height * 1.6 };
    if (node.shape === 'ellipse') return { w: width * 1.15, h: height * 1.2 };
    return { w: width, h: height };
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

  /** The curved line between two nodes, as SVG path text.
      If the nodes are further apart sideways, the curve leaves sideways (S-shape);
      if they are further apart up/down, it leaves up/down. */
  function edgePath(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (Math.abs(dx) >= Math.abs(dy)) {
      const midX = a.x + dx / 2;
      return 'M ' + a.x + ' ' + a.y + ' C ' + midX + ' ' + a.y + ', ' + midX + ' ' + b.y + ', ' + b.x + ' ' + b.y;
    }
    const midY = a.y + dy / 2;
    return 'M ' + a.x + ' ' + a.y + ' C ' + a.x + ' ' + midY + ', ' + b.x + ' ' + midY + ', ' + b.x + ' ' + b.y;
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
  /* A "layout" decides where every node goes. There are two:
       - Sideways tree (horizontal): the root is on the left, its children in the next
         column, and so on. Like a folder tree turned on its side. Easy to read.
       - Radial: the root is in the centre and branches spread around it in circles. */

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

  /** Arranges the map as a sideways tree. Nodes that are not connected to the root stay where they are.
      Steps:
        1. Find how wide each column (depth) needs to be.
        2. Work out the x position of every column.
        3. Give every leaf (node without children) its own row, top to bottom.
        4. Put each parent in the middle of its children. */
  function layoutHorizontal(g) {
    const tree = graphToTree(g);
    const nodeById = {};
    g.nodes.forEach((n) => (nodeById[n.id] = n));

    // 1. The widest node in each column.
    const columnWidth = [];
    (function measure(treeNode, depth) {
      const width = getSize(nodeById[treeNode.id]).w;
      columnWidth[depth] = Math.max(columnWidth[depth] || 0, width);
      treeNode.children.forEach((child) => measure(child, depth + 1));
    })(tree, 0);

    // 2. The x of the CENTRE of each column (columns line up on their left side).
    const columnX = [];
    let left = 0;
    columnWidth.forEach((width, depth) => {
      columnX[depth] = left + width / 2;
      left += width + H_GAP;
    });

    // 3 + 4. Rows. "nextY" is where the next leaf goes.
    let nextY = 0;
    (function place(treeNode, depth) {
      const node = nodeById[treeNode.id];
      node.x = columnX[depth];

      if (treeNode.children.length === 0) {
        const height = getSize(node).h;
        node.y = nextY + height / 2;
        nextY += height + V_GAP;
      } else {
        treeNode.children.forEach((child) => place(child, depth + 1));
        const firstChild = nodeById[treeNode.children[0].id];
        const lastChild = nodeById[treeNode.children[treeNode.children.length - 1].id];
        node.y = (firstChild.y + lastChild.y) / 2; // halfway between the first and last child
      }
    })(tree, 0);
  }

  /* ---- Radial layout. Every node gets a slice of a circle; the more leaves a
          node has below it, the bigger its slice. Depth = distance from the centre. ---- */

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

  /** Moves every node that is connected to the root into its radial position.
      Nodes that are not connected to anything are left where they are. */
  function layoutRadial(g) {
    const tree = graphToTree(g);
    placeNode(tree, 0, 2 * Math.PI, 0);

    (function copyPositions(treeNode) {
      const graphNode = g.nodes.find((n) => n.id === treeNode.id);
      graphNode.x = treeNode.x;
      graphNode.y = treeNode.y;
      treeNode.children.forEach(copyPositions);
    })(tree);
  }

  /** Arranges the whole graph with the layout it uses (g.layout). */
  function relayout(g) {
    if (g.nodes.length === 0) return;
    if (g.layout === 'radial') {
      layoutRadial(g);
    } else {
      layoutHorizontal(g);
    }
  }

  /** Converts a generated tree ({ text, children }) into a graph, then lays it out. */
  function treeToGraph(tree, layout) {
    const g = { nodes: [], edges: [], rootId: null, layout: layout || DEFAULT_LAYOUT };

    function addNode(treeNode, parentId) {
      const isRoot = parentId === null;
      const node = makeNode(
        treeNode.text,
        0,
        0,
        isRoot ? 'ellipse' : 'round',
        isRoot ? ROOT_COLOR : DEFAULT_COLOR
      );
      if (isRoot) {
        node.fontSize = 18; // the main idea stands out
        node.bold = true;
      }
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
    return { nodes: [root], edges: [], rootId: root.id, layout: DEFAULT_LAYOUT };
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
      const path = { d: edgePath(a, b) };
      const isSelected = selection.type === 'edge' && selection.id === edge.id;

      const line = svgEl('path', path);
      line.setAttribute('class', 'mm-edge' + (isSelected ? ' selected' : ''));
      edgeLayer.appendChild(line);

      const hitArea = svgEl('path', path);
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
    shape.setAttribute('fill', node.color);
    group.appendChild(shape);

    // Cut very long text so it stays inside the shape (the full text is kept).
    const usableWidth = node.shape === 'diamond' ? w * 0.6 : w - 24;
    const maxChars = Math.floor(usableWidth / charWidthOf(node));
    const shown = node.text.length > maxChars ? node.text.slice(0, maxChars - 1) + '…' : node.text;

    const label = svgEl('text', {
      x: 0,
      y: 0,
      fill: textColorOf(node),
      'font-family': fontChoiceOf(node).css,
      'font-size': fontSizeOf(node),
      'font-weight': node.bold ? 'bold' : 'normal',
      'font-style': node.italic ? 'italic' : 'normal',
    });
    label.setAttribute('class', 'mm-text');
    label.textContent = shown; // textContent (not innerHTML) keeps note text from running as code
    group.appendChild(label);

    return group;
  }

  /** Keeps the toolbars in sync with the selection: greyed out when they cannot be
      used, and showing the selected node's font, size, colors and so on. */
  function updateToolbar() {
    const node = selectedNode();

    // The whole format bar only works while a node is selected.
    formatControls.forEach((control) => (control.disabled = !node));

    if (node) {
      shapeSelect.value = node.shape;
      fontSelect.value = fontChoiceOf(node).value;
      fontSizeInput.value = fontSizeOf(node);
      scaleSelect.value = String(scaleOf(node));
      fillPreview.style.background = node.color;
      textBar.style.background = textColorOf(node);
      boldButton.classList.toggle('active', !!node.bold);
      italicButton.classList.toggle('active', !!node.italic);
    } else {
      closePalette();
    }

    layoutSelect.value = graph.layout || DEFAULT_LAYOUT;
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

  /* ---- The format bar: change one property of the selected node ---- */

  /** Sets one property (like 'fontSize' or 'color') of the selected node. Can be undone. */
  function setNodeProp(property, value) {
    const node = selectedNode();
    if (!node || node[property] === value) return;
    change(() => {
      node[property] = value;
    });
  }

  /** Sets the font size of the selected node, keeping it between the minimum and maximum. */
  function setFontSize(size) {
    const number = parseInt(size, 10);
    if (isNaN(number)) {
      render(); // not a number: put the old size back in the box
      return;
    }
    setNodeProp('fontSize', clamp(number, MIN_FONT_SIZE, MAX_FONT_SIZE));
  }

  function changeFontSizeBy(amount) {
    const node = selectedNode();
    if (node) setFontSize(fontSizeOf(node) + amount);
  }

  function toggleNodeProp(property) {
    const node = selectedNode();
    if (node) setNodeProp(property, !node[property]);
  }

  /* ---- The color popup ---- */

  /** Opens the color popup under a button. "target" is 'fill' or 'text'.
      Clicking the same button again closes it. */
  function openPalette(target, button) {
    const node = selectedNode();
    if (!node) return;
    if (paletteTarget === target) {
      closePalette();
      return;
    }
    paletteTarget = target;

    const isFill = target === 'fill';
    const colors = isFill ? FILL_COLORS : TEXT_COLORS;
    const current = (isFill ? node.color : textColorOf(node)).toLowerCase();

    paletteTitle.textContent = isFill ? 'Fill color' : 'Text color';
    autoTextButton.hidden = isFill; // "Automatic" only makes sense for text
    hexInput.value = current;

    // One round button per color.
    swatchBox.textContent = '';
    for (const color of colors) {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'mm-swatch' + (color === current ? ' current' : '');
      swatch.style.background = color;
      swatch.setAttribute('data-action', 'pick-color');
      swatch.setAttribute('data-color', color);
      swatch.setAttribute('aria-label', 'Use color ' + color);
      swatch.title = color;
      swatchBox.appendChild(swatch);
    }

    // Put the popup just under the button, and keep it inside the panel.
    // (The popup is positioned relative to the inside of the panel border, hence clientLeft/clientTop.)
    const appRect = appBox.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    palette.hidden = false;
    const farthestLeft = Math.max(4, appRect.width - palette.offsetWidth - 8);
    const left = buttonRect.left - appRect.left - appBox.clientLeft;
    palette.style.left = clamp(left, 4, farthestLeft) + 'px';
    palette.style.top = buttonRect.bottom - appRect.top - appBox.clientTop + 4 + 'px';
  }

  function closePalette() {
    paletteTarget = null;
    palette.hidden = true;
  }

  /** Applies a color (like '#1c7ed6') to whatever the popup is changing, then closes it. */
  function applyColor(text) {
    let color = text.trim().toLowerCase();
    if (color.charAt(0) !== '#') color = '#' + color; // allow typing without the #
    if (!/^#[0-9a-f]{6}$/.test(color)) {
      setStatus('Type a color like #1c7ed6 (a # and 6 letters or numbers).');
      return;
    }
    setNodeProp(paletteTarget === 'fill' ? 'color' : 'textColor', color);
    closePalette();
  }

  /* ---- Adding and removing things ---- */

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

  /** Where a new child of "parent" should appear.
      Sideways layout: to the right of the parent, below its other children.
      Radial layout: on the side facing away from the centre. */
  function childSpot(parent) {
    if (graph.layout !== 'radial') {
      const siblings = graph.edges
        .filter((e) => e.from === parent.id)
        .map((e) => findNode(e.to))
        .filter((node) => node);
      let y = parent.y;
      if (siblings.length > 0) {
        const lowestEdge = Math.max(...siblings.map((s) => s.y + getSize(s).h / 2));
        y = lowestEdge + V_GAP + NODE_HEIGHT / 2; // just under the last sibling
      }
      const x = parent.x + getSize(parent).w / 2 + H_GAP + MIN_NODE_WIDTH / 2;
      return findFreeSpot({ x: x, y: y });
    }

    const root = findNode(graph.rootId) || parent;
    const siblingCount = graph.edges.filter((e) => e.from === parent.id).length;
    let angle;
    if (parent === root) {
      angle = siblingCount * 0.9; // spread the root's children around it
    } else {
      const awayFromRoot = Math.atan2(parent.y - root.y, parent.x - root.x);
      const fan = (siblingCount % 2 === 1 ? 1 : -1) * Math.ceil(siblingCount / 2) * 0.5;
      angle = awayFromRoot + fan;
    }
    return { x: parent.x + 220 * Math.cos(angle), y: parent.y + 220 * Math.sin(angle) };
  }

  /** Adds a node connected to the selected one. */
  function addChild() {
    const parent = selectedNode();
    if (!parent) {
      setStatus('Select a node first, then press + Child.');
      return;
    }
    const spot = childSpot(parent);
    const child = makeNode('New idea', spot.x, spot.y);
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

  /** "Re-arrange" button: put every connected node back in its place using the chosen layout. */
  function rearrange() {
    change(() => relayout(graph));
    fitView();
  }

  /** The layout menu changed: remember the choice in the map, then re-arrange. */
  function changeLayout(layout) {
    change(() => {
      graph.layout = layout;
      relayout(graph);
    });
    fitView();
  }

  /** Shows a text box over a node so the user can rename it. */
  function startEditing(nodeId) {
    const node = findNode(nodeId);
    if (!node) return;
    if (editInput) editInput.blur();

    const size = getSize(node);
    const boxWidth = Math.max(size.w, 140) * view.zoom;
    const boxHeight = Math.max(32, fontSizeOf(node) * 2) * view.zoom;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'mm-edit';
    input.value = node.text;
    input.setAttribute('aria-label', 'Node text');
    input.style.width = boxWidth + 'px';
    input.style.height = boxHeight + 'px';
    input.style.left = node.x * view.zoom + view.x - boxWidth / 2 + 'px';
    input.style.top = node.y * view.zoom + view.y - boxHeight / 2 + 'px';
    input.style.fontSize = fontSizeOf(node) * view.zoom + 'px'; // same look as the node text
    input.style.fontFamily = fontChoiceOf(node).css;
    input.style.fontWeight = node.bold ? 'bold' : 'normal';
    input.style.fontStyle = node.italic ? 'italic' : 'normal';
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
    // format bar
    'font-smaller': () => changeFontSizeBy(-FONT_STEP),
    'font-bigger': () => changeFontSizeBy(FONT_STEP),
    'toggle-bold': () => toggleNodeProp('bold'),
    'toggle-italic': () => toggleNodeProp('italic'),
    // color popup
    'open-palette': (button) => openPalette(button.dataset.target, button),
    'pick-color': (button) => applyColor(button.dataset.color),
    'auto-text-color': () => {
      setNodeProp('textColor', null); // null = automatic (dark or white, whichever is readable)
      closePalette();
    },
  };

  appBox.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (button && actions[button.dataset.action]) {
      // Any button closes the color popup, except the ones that open/use it.
      if (button.dataset.action !== 'open-palette') closePalette();
      actions[button.dataset.action](button);
    } else if (!event.target.closest('#mm-palette')) {
      closePalette(); // clicked somewhere else
    }
  });

  /* ---- The menus and boxes of the format bar ---- */

  fontSelect.addEventListener('change', () => setNodeProp('fontFamily', fontSelect.value));
  fontSizeInput.addEventListener('change', () => setFontSize(fontSizeInput.value));
  shapeSelect.addEventListener('change', () => setNodeProp('shape', shapeSelect.value));
  scaleSelect.addEventListener('change', () => setNodeProp('scale', parseFloat(scaleSelect.value)));
  layoutSelect.addEventListener('change', () => changeLayout(layoutSelect.value));

  hexInput.addEventListener('keydown', (event) => {
    event.stopPropagation(); // typing a color must not trigger shortcuts
    if (event.key === 'Enter') applyColor(hexInput.value);
    if (event.key === 'Escape') closePalette();
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
      closePalette();
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
      graph = { nodes: [], edges: [], rootId: null, layout: DEFAULT_LAYOUT };
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
    if (data && Array.isArray(data.nodes)) {
      // Maps saved before the layout menu existed were all radial, so keep calling them radial.
      data.layout = data.layout || 'radial';
      return data;
    }
    if (data && typeof data.text === 'string') return treeToGraph(data);
    return newMap(title);
  }

  /** "Auto" and "From outline": ask Joplin for a tree, then lay it out with the map's layout. */
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
      graph = treeToGraph(reply.tree, graph.layout);
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

  /** Fills a <select> with options. "choices" is a list of { value, label }. */
  function fillSelect(select, choices) {
    for (const choice of choices) {
      const option = document.createElement('option');
      option.value = choice.value;
      option.textContent = choice.label;
      select.appendChild(option);
    }
  }

  fillSelect(fontSelect, FONT_CHOICES);
  fillSelect(scaleSelect, SIZE_CHOICES);

  webviewApi.onMessage((event) => {
    if (event.message.name === 'noteChanged') loadCurrentNote();
  });

  // When the canvas gets a size (first time it is shown, or when it is resized):
  new ResizeObserver(() => {
    if (needsFit) fitView();
    else render();
  }).observe(canvasBox);

  // When the whole panel changes width: switch between full buttons and icon-only buttons.
  new ResizeObserver(() => {
    appBox.classList.toggle('compact', appBox.clientWidth < COMPACT_BELOW_PX);
    closePalette(); // its position would be wrong after a resize
  }).observe(appBox);

  defaultHint();
  render();
  loadCurrentNote();

  // This lets us unit-test the layout code in Node. Joplin ignores it.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      countLeaves,
      placeNode,
      graphToTree,
      layoutRadial,
      layoutHorizontal,
      relayout,
      treeToGraph,
      newMap,
    };
  }
})();
