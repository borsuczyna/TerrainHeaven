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

[x] Add shortcuts for tools (visible on tooltip too) clicking same shortcut when tool is active should go to next tool if this tool has right click different tools

[x] Selected WorldElement's should change color (blueish kinda) remember to keep wireframe working

[x] Add rotation gizmo for WorldElement (it should rotate also child nodes)

[x] Add transparent history on bottom right, possible to fold (only header visible when folded), add CTRL + Z/Y, implement it everywhere in the project, make HistoryManager for it

[x] Add bridge with pillars, pillars should be possible to select shape (box, circular; circular with segment count changing), pillars should reach the terrain flawlessly, it should be possible to change pillars distance and count, for example 1 - just one on center, 2 - on both sides, 3 - one on center and on sides, to make it easier and easier for users, make it option for road, not new WorldElement

[ ] Tunnels - they should cut the terrain, to make it easier and easier for users, make it option for road, not new WorldElement

[ ] Snapping to grid and WorldElement's cutout edges

[ ] New terrain cutout types, now we have only point, add tool to create cutout mesh, when clicked add point, when two clicked make it a line, when thee or more use it same as WorldElement cutout

[ ] Parenting system - add on left top (below translate and rotate) elements list, it should be possible to create groups, when group is selected it should be possible to move all elements together

[ ] Del or backspace to delete (only for WorldElements)

[ ] Add box selection and change camera movement to right button

Important:
[ ] When two points are very close to each other but on different Y, cutout on terrain is wrong, it uses most of the time one with higher Y, it should do cutout on all points not skipping any
