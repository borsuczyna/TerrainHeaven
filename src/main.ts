import 'reflect-metadata';
import './style.css';
import { createIcons, icons } from 'lucide';
import { container } from 'tsyringe';
import App from './editor/App';
import { loadDemoScene } from './DemoScene';
import EditorBridge from './mcp/EditorBridge';

const nonTextFocusTarget = 'button, a[href], [role="button"], [tabindex]';

// Keep mouse-clicked UI controls from retaining focus. The editor uses keys such
// as Space for camera movement, and a focused button would otherwise activate
// again when that key is pressed. Inputs remain focusable so they can be edited.
document.addEventListener('mousedown', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const focusTarget = target.closest<HTMLElement>(nonTextFocusTarget);
    if (!focusTarget || focusTarget.matches('input, select, textarea, [contenteditable="true"]')) return;

    event.preventDefault();
}, true);

document.addEventListener('focusin', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const focusTarget = target.closest<HTMLElement>(nonTextFocusTarget);
    if (!focusTarget || focusTarget.matches('input, select, textarea, [contenteditable="true"]')) return;

    focusTarget.blur();
}, true);

const app = container.resolve(App);
loadDemoScene(app);
app.history.reset('Demo Scene');
container.resolve(EditorBridge).start();

createIcons({ icons });
