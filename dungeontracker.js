// dungeontracker.js v2026-02-23-01
// A self-contained "DungeonTracker" you can mount into an existing page.
// - Left side: SVG 50x50 square grid.
// - Right side: panel to edit either a cell OR a room.
// - Enhancement: select contiguous cells and convert into a "Room" (BFS adjacency).

import { makeSquareMath, buildSquareSvgGrid } from "./dungeonGridSvg.js";

export function createDungeonTracker(opts){
  const {
    svgEl,
    panelEls,
    storageKey = "dungeontracker_v1",
    COLS = 50,
    ROWS = 50,
    SIZE = 18,
    GAP  = 2,
    PAD  = 18,
    // optional: called when the user clicks "Exit"
    onExit = null
  } = opts;

  const {
    titleEl,
    modeEl,
    selectedEl,
    colorEl,
    iconEl,
    notesEl,
    roomNameEl,
    roomKindEl,
    createRoomBtn,
    dissolveRoomBtn,
    deleteRoomBtn,
    clearCellBtn,
    exportBtn,
    importBtn,
    importFileEl,
    wipeBtn,
    roomListEl,
    exitBtn
  } = panelEls;

  // --- data model ---
  // data.cells["c,r"] = { c: "#hex", n: "notes", icon:"", roomId: "abc" | null }
  // data.rooms[roomId] = { id, name, kind, c, n, icon, cells: ["c,r", ...] }
  const data = load() || { cells:{}, rooms:{}, meta:{ nextRoomId: 1 } };

  function save(){ localStorage.setItem(storageKey, JSON.stringify(data)); }
  function load(){
    try{ return JSON.parse(localStorage.getItem(storageKey) || ""); }
    catch{ return null; }
  }

  function key(c, r){ return `${c},${r}`; }

  function ensureCell(c, r){
    const k = key(c, r);
    data.cells[k] ??= { c: null, n: "", icon: "", roomId: null };
    const cell = data.cells[k];
    if (cell.icon === undefined) cell.icon = "";
    if (cell.roomId === undefined) cell.roomId = null;
    return cell;
  }

  function roomById(id){ return id ? data.rooms[id] : null; }

  // --- selection state ---
  // editTarget: "cell" | "room"
  let editTarget = "cell";
  let selectedCellKey = null;
  let selectedRect = null;

  // multi-select staging for "create room"
  const staged = new Set(); // keys
  let hoverKey = null;

  // --- geometry + build ---
  const math = makeSquareMath({ COLS, ROWS, SIZE, GAP, PAD });
  const { topLeft, center, computeBounds } = math;

  function setSelected(rect, on){
    if (!rect) return;
    if (on){
      rect.setAttribute("stroke", "#ffd54a");
      rect.setAttribute("stroke-width", "3");
    } else {
      rect.setAttribute("stroke", "rgba(255,255,255,0.55)");
      rect.setAttribute("stroke-width", "1");
    }
  }

  function setStaged(rect, on){
    if (!rect) return;
    if (on){
      rect.setAttribute("stroke", "#7fe6ff");
      rect.setAttribute("stroke-width", "3");
      rect.setAttribute("stroke-dasharray", "4 3");
    } else {
      rect.removeAttribute("stroke-dasharray");
    }
  }

  // primary paint logic
  function setVisual(rect, c, r){
    const cell = ensureCell(c, r);

    rect.style.cursor = "pointer";
    rect.style.pointerEvents = "all";
    rect.style.transition = "fill-opacity 200ms ease";

    // base fill: room color if part of room, else cell color, else faint
    const room = roomById(cell.roomId);
    const color = (room?.c) || cell.c;

    if (color){
      rect.setAttribute("fill", color);
      rect.setAttribute("fill-opacity", "0.90");
    } else {
      rect.setAttribute("fill", "#ffffff");
      rect.setAttribute("fill-opacity", "0.05");
    }

    rect.setAttribute("stroke", "rgba(255,255,255,0.55)");
    rect.setAttribute("stroke-width", "1");

    // icon: prefer room icon if in room, else cell icon
    const icon = (room?.icon) || cell.icon || "";
    if (rect._cellIcon){
      rect._cellIcon.textContent = icon;
      rect._cellIcon.style.display = icon ? "block" : "none";
    }
  }

  const grid = buildSquareSvgGrid({
    svg: svgEl,
    COLS, ROWS, SIZE, GAP, PAD,
    topLeft, center, computeBounds,
    setVisual,
    onClickCell: (c, r, rect) => onCellClick(c, r, rect),
    onEnterCell: (c, r, rect) => onCellEnter(c, r, rect),
    onLeaveCell: (c, r, rect) => onCellLeave(c, r, rect),
    makeIconText: true
  });

  // --- pan + pinch-zoom (iPad friendly) via viewBox ---
  // Uses Pointer Events + touch-action:none (CSS) so the browser doesn't zoom the page.
  const vbMinW = grid.w;           // zoomed-out limit (full map)
  const vbMinH = grid.h;
  const maxZoom = 8;               // zoom-in limit (8x)
  const vbMaxW = grid.w / maxZoom; // smallest viewBox allowed
  const vbMaxH = grid.h / maxZoom;

  let view = { x: 0, y: 0, w: grid.w, h: grid.h };
  svgEl.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);

  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

  // keep viewBox inside the map bounds
  function clampView() {
    view.w = clamp(view.w, vbMaxW, vbMinW);
    view.h = clamp(view.h, vbMaxH, vbMinH);
    view.x = clamp(view.x, 0, grid.w - view.w);
    view.y = clamp(view.y, 0, grid.h - view.h);
  }

  function updateView() {
    clampView();
    svgEl.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
  }

  function svgUnitsPerPx() {
    const r = svgEl.getBoundingClientRect();
    return {
      ux: view.w / Math.max(1, r.width),
      uy: view.h / Math.max(1, r.height),
    };
  }

  function dist(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y;
    return Math.hypot(dx, dy);
  }

  function mid(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  // suppress tile clicks after a drag/pinch (prevents accidental selection)
  let blockClicksUntil = 0;
  function blockClicks(ms = 250) {
    blockClicksUntil = Date.now() + ms;
  }

  // Track active pointers
  const pointers = new Map(); // id -> {x,y}
  let gesture = null;
  // gesture: { mode:"pan"|"pinch", startView, startDist, startMid, startMidSvg }

  function clientToSvg(clientX, clientY) {
    const rect = svgEl.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    return {
      x: view.x + px * (view.w / Math.max(1, rect.width)),
      y: view.y + py * (view.h / Math.max(1, rect.height)),
    };
  }

  function onPointerDown(e) {
    // Only handle touch/pen for map gestures; mouse can keep normal scroll behavior if you like.
    // If you want mouse-drag pan too, delete this if-block.
    if (e.pointerType === "mouse") return;

    svgEl.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 1) {
      gesture = {
        mode: "pan",
        startView: { ...view },
        startPt: { x: e.clientX, y: e.clientY }
      };
    } else if (pointers.size === 2) {
      const pts = Array.from(pointers.values());
      const m = mid(pts[0], pts[1]);
      const d = dist(pts[0], pts[1]);
      const mSvg = clientToSvg(m.x, m.y);

      gesture = {
        mode: "pinch",
        startView: { ...view },
        startDist: d,
        startMid: m,
        startMidSvg: mSvg
      };
    }
  }

  function onPointerMove(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (!gesture) return;

    // PAN (1 pointer)
    if (pointers.size === 1 && gesture.mode === "pan") {
      const cur = pointers.get(e.pointerId);
      const dxPx = cur.x - gesture.startPt.x;
      const dyPx = cur.y - gesture.startPt.y;

      // if user is really moving, block clicks
      if (Math.hypot(dxPx, dyPx) > 6) blockClicks(300);

      const { ux, uy } = svgUnitsPerPx();
      view.x = gesture.startView.x - dxPx * ux;
      view.y = gesture.startView.y - dyPx * uy;
      updateView();
      return;
    }

    // PINCH (2 pointers)
    if (pointers.size === 2) {
      const pts = Array.from(pointers.values());
      const m = mid(pts[0], pts[1]);
      const d = dist(pts[0], pts[1]);

      // if pinch is happening, block clicks
      blockClicks(400);

      // scale relative to start
      const scale = gesture.startDist / Math.max(1, d); // pinch out -> smaller d? (scale up)
      const targetW = gesture.startView.w * scale;
      const targetH = gesture.startView.h * scale;

      // clamp zoom limits
      view.w = clamp(targetW, vbMaxW, vbMinW);
      view.h = clamp(targetH, vbMaxH, vbMinH);

      // Keep zoom centered at the pinch midpoint (in SVG units)
      // We stored the midpoint in SVG coords at gesture start; keep that same world point under the fingers.
      const rect = svgEl.getBoundingClientRect();
      const midPxX = m.x - rect.left;
      const midPxY = m.y - rect.top;

      view.x = gesture.startMidSvg.x - (midPxX / Math.max(1, rect.width)) * view.w;
      view.y = gesture.startMidSvg.y - (midPxY / Math.max(1, rect.height)) * view.h;

      updateView();
    }
  }

  function onPointerUp(e) {
    pointers.delete(e.pointerId);
    if (pointers.size === 0) {
      gesture = null;
      return;
    }

    // If one pointer remains after pinch, reset gesture to pan from current state
    if (pointers.size === 1) {
      const only = Array.from(pointers.values())[0];
      gesture = {
        mode: "pan",
        startView: { ...view },
        startPt: { x: only.x, y: only.y }
      };
    }
  }

  svgEl.addEventListener("pointerdown", onPointerDown, { passive: true });
  svgEl.addEventListener("pointermove", onPointerMove, { passive: true });
  svgEl.addEventListener("pointerup", onPointerUp, { passive: true });
  svgEl.addEventListener("pointercancel", onPointerUp, { passive: true });


  function rectForKey(k){ return grid.rectByKey.get(k) || null; }

  // --- input model ---
  // Click:
  //   - normal click => select cell (edit cell or its room)
  //   - Shift+Click => stage/unstage for room creation
  // Keyboard:
  //   - Esc clears staging (and closes room edit back to cell)
  //   - Enter creates room if staging is valid
  function onCellClick(c, r, rect){
    if (Date.now() < blockClicksUntil) return;
    const k = key(c, r);

    if (window.event?.shiftKey){
      toggleStage(k);
      return;
    }

    selectCell(k, rect);
  }

  function onCellEnter(c, r, rect){
    hoverKey = key(c, r);
    if (rect !== selectedRect && !staged.has(hoverKey)){
      rect.setAttribute("fill-opacity", "0.10");
    }
  }

  function onCellLeave(c, r, rect){
    const k = key(c, r);
    hoverKey = null;
    if (rect !== selectedRect && !staged.has(k)) setVisual(rect, c, r);
  }

  function toggleStage(k){
    const rect = rectForKey(k);
    if (!rect) return;

    if (staged.has(k)){
      staged.delete(k);
      // restore visual
      const [c, r] = k.split(",").map(Number);
      setVisual(rect, c, r);
    } else {
      staged.add(k);
      setStaged(rect, true);
    }
    renderStageStatus();
  }

  function clearStage(){
    for (const k of staged){
      const rect = rectForKey(k);
      if (!rect) continue;
      const [c, r] = k.split(",").map(Number);
      rect.removeAttribute("stroke-dasharray");
      setVisual(rect, c, r);
    }
    staged.clear();
    renderStageStatus();
  }

  function selectCell(k, rect){
    selectedCellKey = k;

    if (selectedRect) setSelected(selectedRect, false);
    selectedRect = rect;
    setSelected(selectedRect, true);

    // default edit target: if cell belongs to a room, open room edit; else cell edit
    const [c, r] = k.split(",").map(Number);
    const cell = ensureCell(c, r);
    const room = roomById(cell.roomId);
    editTarget = room ? "room" : "cell";

    modeEl.textContent = (editTarget === "room") ? "Editing: Room" : "Editing: Cell";
    selectedEl.textContent = (editTarget === "room")
      ? `Room: ${room.name} (${room.cells.length} tiles)`
      : `Cell: ${k}`;

    // populate fields
    if (editTarget === "cell"){
      colorEl.value = cell.c || "#2a2a2a";
      iconEl.value  = cell.icon || "";
      notesEl.value = cell.n || "";
      roomNameEl.value = "";
      roomKindEl.value = "room";
    } else {
      colorEl.value = room.c || "#2a2a2a";
      iconEl.value  = room.icon || "";
      notesEl.value = room.n || "";
      roomNameEl.value = room.name || "";
      roomKindEl.value = room.kind || "room";
    }

    refreshButtons();
    renderRoomList();
    document.body.classList.add("panel-open");
  }

  // --- contiguity check (4-neighbor adjacency) ---
  function isContiguous(keys){
    if (keys.length <= 1) return true;
    const set = new Set(keys);
    const start = keys[0];

    const q = [start];
    const seen = new Set([start]);

    while (q.length){
      const cur = q.shift();
      const [c, r] = cur.split(",").map(Number);
      const neigh = [
        key(c+1, r), key(c-1, r),
        key(c, r+1), key(c, r-1),
      ];
      for (const n of neigh){
        if (!set.has(n) || seen.has(n)) continue;
        seen.add(n);
        q.push(n);
      }
    }
    return seen.size === set.size;
  }

  function anyInRoom(keys){
    for (const k of keys){
      const [c, r] = k.split(",").map(Number);
      const cell = ensureCell(c, r);
      if (cell.roomId) return cell.roomId;
    }
    return null;
  }

  function createRoomFromStage(){
    const keys = Array.from(staged);
    if (!keys.length) return;

    // rule 1: staged set must be contiguous
    if (!isContiguous(keys)){
      alert("Room tiles must be contiguous (edge-adjacent). Tip: stage with Shift+Click.");
      return;
    }

    // rule 2: don't allow mixing multiple rooms; but allow empty cells
    const existingRoomId = anyInRoom(keys);
    if (existingRoomId){
      alert("At least one staged tile already belongs to a room. Dissolve or delete that room first (or stage only empty tiles).");
      return;
    }

    const id = `R${data.meta.nextRoomId++}`;
    const room = {
      id,
      name: `Room ${id}`,
      kind: "room",
      c: "#3c6270",
      n: "",
      icon: "",
      cells: keys.slice().sort()
    };
    data.rooms[id] = room;

    // assign roomId to cells
    for (const k of room.cells){
      const [c, r] = k.split(",").map(Number);
      const cell = ensureCell(c, r);
      cell.roomId = id;

      // repaint immediately
      const rect = rectForKey(k);
      if (rect) setVisual(rect, c, r);
    }

    save();
    clearStage();

    // select first tile of room and enter room edit mode
    const firstK = room.cells[0];
    const rect = rectForKey(firstK);
    if (rect) selectCell(firstK, rect);
    editTarget = "room";
    modeEl.textContent = "Editing: Room";
    selectedEl.textContent = `Room: ${room.name} (${room.cells.length} tiles)`;
    refreshButtons();
    renderRoomList();
  }

  function dissolveRoom(roomId){
    const room = roomById(roomId);
    if (!room) return;

    for (const k of room.cells){
      const [c, r] = k.split(",").map(Number);
      const cell = ensureCell(c, r);
      cell.roomId = null;

      const rect = rectForKey(k);
      if (rect) setVisual(rect, c, r);
    }

    delete data.rooms[roomId];
    save();

    // after dissolve, stay on currently selected cell, but flip to cell edit
    editTarget = "cell";
    modeEl.textContent = "Editing: Cell";
    selectedEl.textContent = selectedCellKey ? `Cell: ${selectedCellKey}` : "No selection";
    refreshButtons();
    renderRoomList();
  }

  function deleteCurrentRoom(){
    const room = getCurrentRoom();
    if (!room) return;
    if (!confirm(`Delete "${room.name}"? (Tiles will become ungrouped)`)) return;
    dissolveRoom(room.id);
  }

  function getCurrentCell(){
    if (!selectedCellKey) return null;
    const [c, r] = selectedCellKey.split(",").map(Number);
    return ensureCell(c, r);
  }

  function getCurrentRoom(){
    const cell = getCurrentCell();
    if (!cell?.roomId) return null;
    return roomById(cell.roomId);
  }

  // --- panel bindings ---
  function applyColor(color){
    if (!selectedCellKey || !selectedRect) return;
    const cell = getCurrentCell();

    if (editTarget === "room"){
      const room = getCurrentRoom();
      if (!room) return;
      room.c = color;
      // repaint all room cells
      for (const k of room.cells){
        const [c, r] = k.split(",").map(Number);
        const rect = rectForKey(k);
        if (rect) setVisual(rect, c, r);
      }
    } else {
      cell.c = color;
      const [c, r] = selectedCellKey.split(",").map(Number);
      setVisual(selectedRect, c, r);
      setSelected(selectedRect, true);
    }

    save();
    renderRoomList();
  }

  function applyIcon(icon){
    if (!selectedCellKey || !selectedRect) return;
    const cell = getCurrentCell();
    const val = icon || "";

    if (editTarget === "room"){
      const room = getCurrentRoom();
      if (!room) return;
      room.icon = val;
      for (const k of room.cells){
        const [c, r] = k.split(",").map(Number);
        const rect = rectForKey(k);
        if (rect && rect._cellIcon){
          rect._cellIcon.textContent = val;
          rect._cellIcon.style.display = val ? "block" : "none";
        }
      }
    } else {
      cell.icon = val;
      if (selectedRect._cellIcon){
        selectedRect._cellIcon.textContent = val;
        selectedRect._cellIcon.style.display = val ? "block" : "none";
      }
    }

    save();
    renderRoomList();
  }

  function applyNotes(notes){
    if (!selectedCellKey) return;
    const cell = getCurrentCell();

    if (editTarget === "room"){
      const room = getCurrentRoom();
      if (!room) return;
      room.n = notes;
    } else {
      cell.n = notes;
    }

    save();
  }

  function applyRoomName(name){
    const room = getCurrentRoom();
    if (!room) return;
    room.name = name || room.name;
    save();
    renderRoomList();
    selectedEl.textContent = `Room: ${room.name} (${room.cells.length} tiles)`;
  }

  function applyRoomKind(kind){
    const room = getCurrentRoom();
    if (!room) return;
    room.kind = kind || "room";
    save();
    renderRoomList();
  }

  function clearSelectedCell(){
    if (!selectedCellKey || !selectedRect) return;
    const cell = getCurrentCell();
    if (!cell) return;

    // if part of a room, don't clear the room through the cell button
    if (cell.roomId){
      alert("This tile is part of a room. Edit the room, dissolve it, or delete it.");
      return;
    }

    cell.c = null;
    cell.icon = "";
    cell.n = "";
    save();

    const [c, r] = selectedCellKey.split(",").map(Number);
    setVisual(selectedRect, c, r);
    setSelected(selectedRect, true);
  }

  // --- room list UI ---
  function renderRoomList(){
    roomListEl.innerHTML = "";
    const rooms = Object.values(data.rooms).sort((a,b) => a.id.localeCompare(b.id));
    if (!rooms.length){
      roomListEl.innerHTML = `<div class="small">No rooms yet. Stage tiles with <kbd>Shift</kbd>+Click, then create a room.</div>`;
      return;
    }

    for (const room of rooms){
      const div = document.createElement("div");
      div.className = "roomItem";
      div.innerHTML = `
        <div class="title">
          <div class="name">${escapeHtml(room.name)}</div>
          <div class="small">${room.id}</div>
        </div>
        <div class="meta">${escapeHtml(room.kind)} • ${room.cells.length} tiles</div>
      `;
      div.addEventListener("click", () => {
        // select first cell of that room
        const k = room.cells[0];
        const rect = rectForKey(k);
        if (rect) selectCell(k, rect);
        editTarget = "room";
        modeEl.textContent = "Editing: Room";
        selectedEl.textContent = `Room: ${room.name} (${room.cells.length} tiles)`;
        colorEl.value = room.c || "#2a2a2a";
        iconEl.value  = room.icon || "";
        notesEl.value = room.n || "";
        roomNameEl.value = room.name || "";
        roomKindEl.value = room.kind || "room";
        refreshButtons();
      });
      roomListEl.appendChild(div);
    }
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, ch => ({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
    }[ch]));
  }

  // --- stage status / buttons ---
  function renderStageStatus(){
    const n = staged.size;
    const contiguous = n ? isContiguous(Array.from(staged)) : true;

    titleEl.textContent = "DungeonTracker";
    const msg = n
      ? `Staged tiles: ${n} • ${contiguous ? "contiguous ✅" : "not contiguous ❌"}`
      : "Staged tiles: 0";
    selectedEl.dataset.stage = msg; // not shown; just for debug

    createRoomBtn.disabled = !(n && contiguous);
  }

  function refreshButtons(){
    const cell = getCurrentCell();
    const room = getCurrentRoom();

    clearCellBtn.disabled = !cell;
    dissolveRoomBtn.disabled = !room;
    deleteRoomBtn.disabled = !room;
    roomNameEl.disabled = !room;
    roomKindEl.disabled = !room;
  }

  // --- export / import / wipe ---
  function doExport(){
    const blob = new Blob([JSON.stringify({ cols:COLS, rows:ROWS, data }, null, 2)], { type:"application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "dungeontracker.json";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function doImport(file){
    const text = await file.text();
    const obj = JSON.parse(text);
    if (!obj?.data?.cells || !obj?.data?.rooms) return alert("Invalid file.");

    // replace data in place
    data.cells = obj.data.cells;
    data.rooms = obj.data.rooms;
    data.meta  = obj.data.meta || { nextRoomId: 1 };

    save();
    rebuildAll();
    clearStage();
    selectedCellKey = null;
    if (selectedRect) setSelected(selectedRect, false);
    selectedRect = null;
    modeEl.textContent = "Editing: Cell";
    selectedEl.textContent = "Click a tile…";
    notesEl.value = "";
    roomNameEl.value = "";
    roomKindEl.value = "room";
    refreshButtons();
    renderRoomList();
  }

  function doWipe(){
    if (!confirm("Wipe local dungeon save?")) return;
    data.cells = {};
    data.rooms = {};
    data.meta = { nextRoomId: 1 };
    save();
    rebuildAll();
    clearStage();
    selectedCellKey = null;
    if (selectedRect) setSelected(selectedRect, false);
    selectedRect = null;
    modeEl.textContent = "Editing: Cell";
    selectedEl.textContent = "Click a tile…";
    notesEl.value = "";
    roomNameEl.value = "";
    roomKindEl.value = "room";
    refreshButtons();
    renderRoomList();
  }

  function rebuildAll(){
    // repaint every cell (cheap enough for 2500)
    for (let r=0; r<ROWS; r++){
      for (let c=0; c<COLS; c++){
        const k = key(c,r);
        const rect = rectForKey(k);
        if (rect) setVisual(rect, c, r);
      }
    }
  }

  // --- wire panel events ---
  colorEl.addEventListener("input", () => applyColor(colorEl.value));
  iconEl.addEventListener("input", () => applyIcon(iconEl.value));
  notesEl.addEventListener("input", () => applyNotes(notesEl.value));

  roomNameEl.addEventListener("input", () => applyRoomName(roomNameEl.value));
  roomKindEl.addEventListener("change", () => applyRoomKind(roomKindEl.value));

  createRoomBtn.addEventListener("click", () => createRoomFromStage());
  dissolveRoomBtn.addEventListener("click", () => {
    const room = getCurrentRoom();
    if (!room) return;
    if (!confirm(`Dissolve "${room.name}"? (Tiles remain, but are ungrouped)`)) return;
    dissolveRoom(room.id);
  });
  deleteRoomBtn.addEventListener("click", () => deleteCurrentRoom());
  clearCellBtn.addEventListener("click", () => clearSelectedCell());

  exportBtn.addEventListener("click", () => doExport());
  importBtn.addEventListener("click", () => importFileEl.click());
  importFileEl.addEventListener("change", async () => {
    const f = importFileEl.files?.[0];
    if (!f) return;
    await doImport(f);
    alert("Imported.");
    importFileEl.value = "";
  });
  wipeBtn.addEventListener("click", () => doWipe());

  if (exitBtn){
    exitBtn.addEventListener("click", () => {
      if (onExit) onExit(getPublicState());
    });
  }

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape"){
      clearStage();
      // if you were editing a room, Esc flips back to cell edit (keeping selection)
      if (editTarget === "room"){
        editTarget = "cell";
        modeEl.textContent = "Editing: Cell";
        selectedEl.textContent = selectedCellKey ? `Cell: ${selectedCellKey}` : "Click a tile…";
        const cell = getCurrentCell();
        if (cell){
          colorEl.value = cell.c || "#2a2a2a";
          iconEl.value  = cell.icon || "";
          notesEl.value = cell.n || "";
        }
        refreshButtons();
      }
    }
    if (e.key === "Enter"){
      if (!createRoomBtn.disabled) createRoomFromStage();
    }
  });

  // initial UI
  titleEl.textContent = "DungeonTracker";
  modeEl.textContent = "Editing: Cell";
  selectedEl.textContent = "Click a tile…";
  renderStageStatus();
  refreshButtons();
  renderRoomList();

  // public API (for later wiring into your hex map)
  function getPublicState(){
    // enough to tie back to a hex key later
    return JSON.parse(JSON.stringify(data));
  }

  function loadState(state){
    if (!state?.cells || !state?.rooms) return;
    data.cells = state.cells;
    data.rooms = state.rooms;
    data.meta  = state.meta || { nextRoomId: 1 };
    save();
    rebuildAll();
    renderRoomList();
  }

  function destroy(){
    // minimal: just clear svg + remove listeners you added externally
    svgEl.innerHTML = "";
  }

  return { getState: getPublicState, loadState, destroy, clearStage };
}
