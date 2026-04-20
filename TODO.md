# TODO
[x] Moving WorldElement's with gizmo (it should move child nodes too)
[x] Should be possible to move camera when mouse is clicked on WorldElement
[x] Intersection cut out on terrain is incorrect
[x] Should be possible to select more than one WorldElement at once to move it
[x] When two nodes or WorldElements are selected at once, don't show properties editing, only show options like Merge nodes etc
[x] Rework toolbar:
- Add top (header) toolbar with options like in photoshop, text not icons: (move from left toolbar)
  - Save
  - Load
  - Settings
- Modify left toolbar:
  - Select tool (keep current)
  - Road tool (when right clicked show on right other options: intersection)
  - Move intersection tool to switch between road tool
  - UV Mapper (keep current)
  - Texture Browser (keep current)
  - Wireframe (keep current)
Make sure code is perfect, so you need to refactor a little bit ToolManager and need to make new HeaderManager
[ ] Add rotation gizmo for WorldElement (it should rotate also child nodes)
[x] Add shortcuts for tools (visible on tooltip too) clicking same shortcut when tool is active should go to next tool if this tool has right click different tools
[ ] Add transparent history on bottom right, possible to fold (only header visible when folded), add CTRL + Z/Y, implement it everywhere in the project, make HistoryManager for it