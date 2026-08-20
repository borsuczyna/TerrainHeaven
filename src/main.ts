import 'reflect-metadata';
import './style.css';
import { createIcons, icons } from 'lucide';
import { container } from 'tsyringe';
import App from './editor/App';
import { loadDemoScene } from './DemoScene';

const app = container.resolve(App);
loadDemoScene(app);
app.history.reset('Demo Scene');

createIcons({ icons });
