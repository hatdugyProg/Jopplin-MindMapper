/**
 * index.ts  -  the plugin's entry point (runs inside Joplin, NOT in the panel).
 * -----------------------------------------------------------------------------
 * What happens here:
 *   1. We create a side panel and give it our HTML, CSS and JS.
 *   2. We add toolbar buttons, a View menu item and a shortcut to open/close it.
 *   3. We answer messages from the panel ("load", "save", "auto", ...),
 *      because only this file is allowed to talk to Joplin's notes.
 *   4. The first time the plugin runs, we show a pop-up that tells the user
 *      where the plugin button is.
 *
 * Picture of the two halves talking:
 *
 *   webview/mindmap.js  --- webviewApi.postMessage({ name: 'save', ... }) --->  index.ts
 *   (the panel you see) <---------------- the return value ------------------  (Joplin side)
 *
 * CHANGED after the ethnographic study:
 *   - showFirstTimeHint(): pop-up that points to the plugin button.
 *   - A second toolbar button above the editor (easier to find).
 *   - The 'auto' message now carries a "mode" ('words' or 'phrases').
 */

import joplin from 'api';
import {
  MenuItemLocation,
  ModelType,
  SettingItemType,
  ToastType,
  ToolbarButtonLocation,
} from 'api/types';
import { buildMindMap, markdownToTree, TermMode } from './algorithms';
import { PANEL_HTML } from './panelHtml';

/* ------------------------------ settings -------------------------------- */

const PANEL_ID = 'mindmapper.panel';
const TOGGLE_COMMAND = 'mindmapper.toggle';
const USER_DATA_KEY = 'mindmap'; // the name under which each note's map is stored
const TOP_N = 12; // how many TF-IDF keywords become nodes
const HINT_SETTING = 'hintShown'; // remembers that we already showed the pop-up

/* ------------------------------ helpers --------------------------------- */

/** Gets the title and body of a note by its id. */
async function getNote(noteId: string) {
  return joplin.data.get(['notes', noteId], { fields: ['id', 'title', 'body'] });
}

/** TF-IDF needs to compare the current note with ALL notes, so fetch them all. */
async function getAllNotes() {
  const notes: { id: string; title: string; body: string }[] = [];
  let page = 1;
  let hasMore = true;
  while (hasMore) {
    const result = await joplin.data.get(['notes'], {
      fields: ['id', 'title', 'body'],
      page: page,
      limit: 100,
    });
    notes.push(...result.items);
    hasMore = result.has_more;
    page++;
  }
  return notes;
}

/**
 * Shows a pop-up (a "toast") the FIRST time the plugin starts, so new users
 * know where the button is. We store a true/false setting so it only appears once.
 */
async function showFirstTimeHint() {
  // A "private" setting (public: false) does not appear in Joplin's settings screen.
  await joplin.settings.registerSettings({
    [HINT_SETTING]: {
      value: false,
      type: SettingItemType.Bool,
      public: false,
      label: 'Mind Mapper: first-time hint was shown',
    },
  });

  const alreadyShown = await joplin.settings.value(HINT_SETTING);
  if (alreadyShown) return;

  await joplin.views.dialogs.showToast({
    message:
      'Mind Mapper is ready! Click the mind map icon in the toolbar (above the editor and at ' +
      'the top right of the note), or press Ctrl+Alt+M.',
    type: ToastType.Info,
    duration: 15000, // milliseconds = 15 seconds
  });
  await joplin.settings.setValue(HINT_SETTING, true);
}

/* --------------------- answering messages from the panel ----------------- */

async function handleMessage(message: any, hidePanel: () => Promise<void>) {
  try {
    switch (message.name) {
      case 'load': {
        // The panel asks: "what is the saved map for the note that is open?"
        const note = await joplin.workspace.selectedNote();
        if (!note) return { error: 'No note is open.' };
        const data = await joplin.data.userDataGet(ModelType.Note, note.id, USER_DATA_KEY);
        return { noteId: note.id, title: note.title, data: data || null };
      }

      case 'save': {
        // message.noteId is the note the map belongs to (not necessarily the open one,
        // because the user may have switched notes a moment ago).
        await joplin.data.userDataSet(ModelType.Note, message.noteId, USER_DATA_KEY, message.graph);
        return { ok: true };
      }

      case 'auto': {
        // TF-IDF -> Kruskal. The panel then applies the layout.
        // message.mode is 'words' or 'phrases' (anything else counts as 'words').
        const mode: TermMode = message.mode === 'phrases' ? 'phrases' : 'words';
        const note = await getNote(message.noteId);
        const allNotes = await getAllNotes();
        return { tree: buildMindMap(note, allNotes, TOP_N, mode) };
      }

      case 'outline': {
        const note = await getNote(message.noteId);
        return { tree: markdownToTree(note.title, note.body) };
      }

      case 'close': {
        await hidePanel();
        return { ok: true };
      }

      default:
        return { error: 'Unknown message: ' + message.name };
    }
  } catch (error) {
    // Show the problem in the panel's status bar instead of failing silently.
    return { error: String(error) };
  }
}

/* ------------------------------ start-up -------------------------------- */

joplin.plugins.register({
  onStart: async function () {
    // 1. Create the panel and load its HTML, CSS and JS.
    const panel = await joplin.views.panels.create(PANEL_ID);
    await joplin.views.panels.setHtml(panel, PANEL_HTML);
    await joplin.views.panels.addScript(panel, './webview/mindmap.css');
    await joplin.views.panels.addScript(panel, './webview/mindmap.js');
    await joplin.views.panels.hide(panel); // start closed; the button opens it

    const hidePanel = async () => {
      await joplin.views.panels.hide(panel);
    };

    // 2. Listen for messages from the panel.
    await joplin.views.panels.onMessage(panel, (message: any) => handleMessage(message, hidePanel));

    // 3. Open/close command, with toolbar buttons, a View-menu item and a shortcut.
    await joplin.commands.register({
      name: TOGGLE_COMMAND,
      label: 'Toggle Mind Map',
      iconName: 'fas fa-project-diagram',
      execute: async () => {
        const isOpen = await joplin.views.panels.visible(panel);
        if (isOpen) {
          await joplin.views.panels.hide(panel);
        } else {
          await joplin.views.panels.show(panel);
          // Tell the panel to (re)load the map of the note that is open now.
          joplin.views.panels.postMessage(panel, { name: 'noteChanged' });
        }
      },
    });

    // Button 1: the note toolbar (top right of the note).
    await joplin.views.toolbarButtons.create(
      'mindmapper.button',
      TOGGLE_COMMAND,
      ToolbarButtonLocation.NoteToolbar
    );
    // Button 2: the editor toolbar (right above the text, where users are looking).
    await joplin.views.toolbarButtons.create(
      'mindmapper.editorButton',
      TOGGLE_COMMAND,
      ToolbarButtonLocation.EditorToolbar
    );
    await joplin.views.menuItems.create('mindmapper.menu', TOGGLE_COMMAND, MenuItemLocation.View, {
      accelerator: 'CmdOrCtrl+Alt+M',
    });

    // 4. When the user opens a different note, the panel must load that note's map.
    await joplin.workspace.onNoteSelectionChange(() => {
      joplin.views.panels.postMessage(panel, { name: 'noteChanged' });
    });

    // 5. Tell brand-new users where the button is (only the first time).
    await showFirstTimeHint();
  },
});
